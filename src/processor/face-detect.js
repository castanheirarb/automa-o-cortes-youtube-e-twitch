// src/processor/face-detect.js
// Detecta automaticamente a posição do rosto/webcam no frame do vídeo
// usando Gemini 2.5 Pro Vision para determinar o enquadramento ideal do crop 9:16.

import { GoogleGenerativeAI } from '@google/generative-ai';
import Groq from 'groq-sdk';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import { isGeminiQuotaExhausted, isGeminiQuotaError, markGeminiQuotaExhausted } from '../utils/gemini-quota-guard.js';

// Fallback de VISÃO quando o Gemini falha/esgota cota. IMPORTANTE (checado
// direto contra GET /v1/models da Groq em 18/09/2026): a conta Groq deste
// projeto NÃO tem nenhum modelo com visão disponível hoje — nem
// meta-llama/llama-4-scout-17b-16e-instruct nem qwen/qwen3-vl-32b-instruct
// (ambos sugeridos por pesquisa, mas retornam 404 model_not_found nesta
// conta). Esse bloco fica pronto pra quando/se a Groq liberar visão pra essa
// conta (ou definir GROQ_VISION_MODEL no .env com o nome certo) — até lá,
// falha rápido e cai pro fallback burro de frame fixo, sem quebrar nada.
const GROQ_VISION_MODEL = process.env.GROQ_VISION_MODEL || 'meta-llama/llama-4-scout-17b-16e-instruct';

async function askGroqForBestFrameIndex(frames) {
    const apiKey = process.env.GROQ_API_KEY;
    if (!apiKey) return null;

    const groq = new Groq({ apiKey });
    const content = [
        {
            type: 'text',
            text: `Analise as ${frames.length} imagens. Qual delas (de 0 a ${frames.length - 1}) tem a expressão facial mais forte e chamativa para uma thumbnail de YouTube Shorts? Responda APENAS com o número do índice.`,
        },
        ...frames.map((f) => ({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${f.base64}` },
        })),
    ];

    const completion = await groq.chat.completions.create({
        model: GROQ_VISION_MODEL,
        max_tokens: 20,
        temperature: 0.3,
        messages: [{ role: 'user', content }],
    });

    const raw = completion.choices[0]?.message?.content?.trim() ?? '';
    const bestIndex = parseInt(raw, 10);
    return isNaN(bestIndex) || bestIndex < 0 || bestIndex >= frames.length ? null : bestIndex;
}

// Terceiro nível de fallback de visão: OpenRouter. Modelos confirmados direto
// no catálogo público (GET https://openrouter.ai/api/v1/models, sem precisar
// de chave pra listar) em 18/09/2026 — reais e gratuitos hoje, ao contrário do
// que pesquisa anterior sugeriu (qwen2.5-vl-32b-instruct:free NÃO existe).
// Exige OPENROUTER_API_KEY própria (conta separada da Groq/Gemini) — sem ela,
// esse nível simplesmente não entra, sem erro.
//
// DOIS modelos, não um: testado ao vivo em 18/09/2026, o primeiro (Gemma) deu
// 429 "temporarily rate-limited upstream" — normal em modelo ":free" (pool
// compartilhado entre todos os usuários da OpenRouter, não é erro nosso).
// Sem um segundo modelo de reserva, esse nível inteiro cairia pro fallback
// burro só por congestionamento passageiro de UM modelo específico.
// Se OPENROUTER_VISION_MODEL estiver setada, ela entra PRIMEIRO na lista (dá
// prioridade à escolha manual) — mas sem SUBSTITUIR a lista de reserva, senão
// perde o ponto inteiro de ter um 2º modelo (bug real: definir a env var pra
// documentar o padrão no .env acabava reduzindo a lista pra 1 item só).
const OPENROUTER_VISION_MODELS = [
    ...(process.env.OPENROUTER_VISION_MODEL ? [process.env.OPENROUTER_VISION_MODEL] : []),
    'google/gemma-4-31b-it:free',
    'inclusionai/ling-3.0-flash-vl:free',
].filter((m, i, arr) => arr.indexOf(m) === i); // remove duplicata se a env var repetir o default

async function callOpenRouterVision(model, content) {
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
        method: 'POST',
        headers: {
            Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
            'Content-Type': 'application/json',
        },
        // max_tokens generoso: mesmo bug clássico já visto com gpt-oss-120b no
        // resto do projeto (ver CLAUDE.md) — modelos "thinking" (ex.: o
        // inclusionai/ling-3.0-flash-vl:free gastou 20/20 tokens todos em
        // raciocínio oculto e nunca chegou a responder, finish_reason:
        // "length", content: null, confirmado ao vivo em 18/09/2026) cortam
        // no meio do pensamento com um limite baixo.
        body: JSON.stringify({ model, max_tokens: 200, temperature: 0.3, messages: [{ role: 'user', content }] }),
    });
    if (!res.ok) throw new Error(`OpenRouter (${model}) ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return res.json();
}

async function askOpenRouterForBestFrameIndex(frames) {
    const apiKey = process.env.OPENROUTER_API_KEY;
    if (!apiKey) return null;

    const content = [
        {
            type: 'text',
            text: `Analise as ${frames.length} imagens. Qual delas (de 0 a ${frames.length - 1}) tem a expressão facial mais forte e chamativa para uma thumbnail de YouTube Shorts? Responda APENAS com o número do índice.`,
        },
        ...frames.map((f) => ({
            type: 'image_url',
            image_url: { url: `data:image/jpeg;base64,${f.base64}` },
        })),
    ];

    let data = null;
    let lastErr = null;
    for (const model of OPENROUTER_VISION_MODELS) {
        try {
            data = await callOpenRouterVision(model, content);
            break;
        } catch (err) {
            lastErr = err;
            logger.warn(`[FaceDetect] ${err.message} — tentando próximo modelo OpenRouter...`);
        }
    }
    if (!data) throw lastErr || new Error('Nenhum modelo OpenRouter respondeu.');

    const raw = data.choices?.[0]?.message?.content?.trim() ?? '';
    const bestIndex = parseInt(raw, 10);
    return isNaN(bestIndex) || bestIndex < 0 || bestIndex >= frames.length ? null : bestIndex;
}

const execFileAsync = promisify(execFile);

async function extractFrame(videoUrl, seekSeconds) {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    const tmpFile = path.join(os.tmpdir(), `face-detect-${Date.now()}.jpg`);
    await execFileAsync(ffmpegPath, [
        '-ss', String(Math.floor(seekSeconds)),
        '-i', videoUrl,
        '-vframes', '1',
        '-q:v', '3',
        '-y',
        tmpFile,
    ]);
    return tmpFile;
}

async function askGeminiForFacePosition(framePath) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

    const image = {
        inlineData: {
            data: Buffer.from(fs.readFileSync(framePath)).toString('base64'),
            mimeType: 'image/jpeg',
        },
    };

    const prompt =
        'This is a game livestream frame. Locate the streamer\'s webcam/face overlay. ' +
        'Reply with ONLY a single decimal number from 0.00 to 1.00 that represents ' +
        'the horizontal center of the face/webcam as a fraction of the total image width ' +
        '(0.00 = far left, 0.50 = center, 1.00 = far right). ' +
        'If there is no visible face or webcam, reply with 0.50.';

    const result = await model.generateContent([prompt, image]);
    const raw = result.response.text().trim();
    const value = parseFloat(raw);

    if (isNaN(value) || value < 0 || value > 1) {
        logger.warn(`face-detect: resposta inesperada do Gemini: "${raw}"`);
        return null;
    }

    return value;
}

/**
 * Detecta a posição horizontal ideal para o crop 9:16 com base no rosto do streamer.
 * Amostra múltiplos frames e usa a média das detecções.
 */
export async function detectCropXPosition(videoStreamUrl, startTime, endTime) {
    if (!process.env.GEMINI_API_KEY || isGeminiQuotaExhausted()) {
        logger.warn('face-detect: Gemini indisponível (sem chave ou cota esgotada) — usando centro (0.5).');
        return 0.5;
    }

    const SAMPLE_COUNT = 3;
    const step = (endTime - startTime) / (SAMPLE_COUNT + 1);
    const sampleTimes = Array.from({ length: SAMPLE_COUNT }, (_, i) => startTime + step * (i + 1));

    logger.info(`face-detect: analisando ${SAMPLE_COUNT} frames com Gemini...`);

    const positions = [];

    for (const t of sampleTimes) {
        let framePath = null;
        try {
            framePath = await extractFrame(videoStreamUrl, t);
            const pos = await askGeminiForFacePosition(framePath);
            if (pos !== null) {
                positions.push(pos);
                logger.info(`  frame em ${Math.floor(t)}s → rosto em X=${(pos * 100).toFixed(0)}%`);
            }
        } catch (err) {
            if (isGeminiQuotaError(err)) markGeminiQuotaExhausted();
            logger.warn(`  frame em ${Math.floor(t)}s → erro: ${err.message}`);
        } finally {
            if (framePath && fs.existsSync(framePath)) fs.unlinkSync(framePath);
        }
    }

    if (positions.length === 0) {
        logger.warn('face-detect: nenhum rosto detectado — usando centro (0.5).');
        return 0.5;
    }

    const avg = positions.reduce((a, b) => a + b, 0) / positions.length;
    logger.info(`face-detect: posição média do rosto → X=${(avg * 100).toFixed(0)}% da largura.`);
    return avg;
}

/**
 * Extrai o frame com a expressão facial mais impactante usando Gemini Vision.
 * Usado pelo thumbnail.js para selecionar o melhor frame para a thumbnail.
 * @param {string} videoPath - Caminho do vídeo local
 * @returns {Promise<string|null>} Caminho do frame salvo ou null
 */
export async function extractBestFrame(videoPath) {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

    const duration = 60; // Analisa os primeiros 60s
    const frameCount = 5;
    const frames = [];

    // 1. Extrai 5 frames do vídeo
    for (let i = 0; i < frameCount; i++) {
        const time = (duration / (frameCount + 1)) * (i + 1);
        const framePath = path.join(os.tmpdir(), `frame-best-${i}-${Date.now()}.jpg`);
        try {
            await execFileAsync(ffmpegPath, ['-ss', String(time), '-i', videoPath, '-vframes', '1', '-pix_fmt', 'yuvj420p', '-q:v', '2', '-y', framePath]);
            const base64 = fs.readFileSync(framePath).toString('base64');
            frames.push({ path: framePath, base64 });
        } catch (err) {
            logger.warn(`[FaceDetect] Falha ao extrair frame ${i}: ${err.message}`);
        }
    }

    if (frames.length === 0) return null;

    let safeIndex = null;

    // 2. Gemini primeiro (melhor qualidade histórica), se disponível.
    if (process.env.GEMINI_API_KEY && !isGeminiQuotaExhausted()) {
        try {
            const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
            const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
            const parts = [
                ...frames.map((f) => ({ inlineData: { data: f.base64, mimeType: 'image/jpeg' } })),
                {
                    text: `Analise as ${frames.length} imagens. Qual delas (de 0 a ${frames.length - 1}) tem a expressão facial mais forte e chamativa para uma thumbnail de YouTube Shorts? Responda APENAS com o número do índice (${Array.from({ length: frames.length }, (_, i) => i).join(', ')}).`,
                },
            ];
            const result = await model.generateContent(parts);
            const bestIndex = parseInt(result.response.text().trim(), 10);
            safeIndex = isNaN(bestIndex) || bestIndex >= frames.length ? 0 : bestIndex;
            logger.info(`[FaceDetect] Melhor frame selecionado pelo Gemini: índice ${safeIndex}`);
        } catch (err) {
            if (isGeminiQuotaError(err)) markGeminiQuotaExhausted();
            logger.warn(`[FaceDetect] Gemini Vision falhou: ${err.message} — tentando Groq Vision...`);
        }
    }

    // 3. Groq Vision (mesma chave já usada pra Whisper/copy no projeto) —
    // fallback de visão real, não o fallback burro (frame fixo) que existia
    // antes disso aqui. Cota Groq (14.400 req/dia) sobra MUITO pro volume de
    // thumbnail — só entra quando Gemini falha ou está sem cota.
    if (safeIndex === null) {
        try {
            const groqIndex = await askGroqForBestFrameIndex(frames);
            if (groqIndex !== null) {
                safeIndex = groqIndex;
                logger.info(`[FaceDetect] Melhor frame selecionado pelo Groq (${GROQ_VISION_MODEL}): índice ${safeIndex}`);
            }
        } catch (err) {
            logger.warn(`[FaceDetect] Groq Vision também falhou: ${err.message}`);
        }
    }

    // 4. OpenRouter (conta/chave separada) — terceiro nível, só entra se
    // Gemini E Groq falharem/estiverem indisponíveis.
    if (safeIndex === null) {
        try {
            const orIndex = await askOpenRouterForBestFrameIndex(frames);
            if (orIndex !== null) {
                safeIndex = orIndex;
                logger.info(`[FaceDetect] Melhor frame selecionado pelo OpenRouter (${OPENROUTER_VISION_MODEL}): índice ${safeIndex}`);
            }
        } catch (err) {
            logger.warn(`[FaceDetect] OpenRouter Vision também falhou: ${err.message}`);
        }
    }

    // 5. Sem IA nenhuma disponível: mantém o comportamento antigo (deixa
    // thumbnail.js cair pro extractFallbackFrame — frame fixo em 1/3 do vídeo).
    if (safeIndex === null) {
        frames.forEach((f) => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        return null;
    }

    const bestFrame = frames[safeIndex];
    frames.forEach((f, i) => {
        if (i !== safeIndex && fs.existsSync(f.path)) fs.unlinkSync(f.path);
    });
    return bestFrame.path;
}

// ─── Classificação de cena → layout automático ───────────────────────────────
// Decide o formato do clipe pelo CONTEÚDO do quadro, não pela persona:
// o mesmo canal alterna "just chatting" (webcam grande) e gameplay em tela
// cheia, e cada caso pede um enquadramento diferente.
//
//   'asd'    → há pessoa/webcam com presença relevante → crop 9:16 no rosto
//   'hybrid' → jogo/tela ocupando o quadro todo, sem rosto relevante →
//              painel 16:9 nativo (preserva HUD, evita upscale de 1,78×)

async function classifyFrame(framePath) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

    const image = {
        inlineData: {
            data: Buffer.from(fs.readFileSync(framePath)).toString('base64'),
            mimeType: 'image/jpeg',
        },
    };

    const prompt =
        'This is a frame from a livestream clip. Answer with ONE word only:\n' +
        '"FACE" if a person\'s face/webcam is clearly visible AND takes up a meaningful ' +
        'part of the frame (roughly 15% of the width or more) — typical of just-chatting, ' +
        'reactions, podcasts, or webcam-dominant stream layouts.\n' +
        '"GAME" if the frame is mostly full-screen gameplay, a screen share, or UI, ' +
        'with no face or only a tiny face overlay.\n' +
        'Answer: FACE or GAME.';

    const result = await model.generateContent([prompt, image]);
    const raw = result.response.text().trim().toUpperCase();
    if (raw.includes('FACE')) return 'face';
    if (raw.includes('GAME')) return 'game';
    logger.warn(`[SceneDetect] Resposta inesperada do Gemini: "${raw}"`);
    return null;
}

/**
 * Analisa amostras do trecho e devolve o layout recomendado.
 * Fallback seguro: 'asd' (comportamento atual) quando indeterminado.
 *
 * @returns {Promise<'asd'|'hybrid'>}
 */
export async function detectSceneLayout(videoStreamUrl, startTime, endTime) {
    if (!process.env.GEMINI_API_KEY || isGeminiQuotaExhausted()) {
        logger.warn('[SceneDetect] Gemini indisponível (sem chave ou cota esgotada) — mantendo layout padrão (asd).');
        return 'asd';
    }

    const SAMPLE_COUNT = 3;
    const step = (endTime - startTime) / (SAMPLE_COUNT + 1);
    const times = Array.from({ length: SAMPLE_COUNT }, (_, i) => startTime + step * (i + 1));

    const votes = { face: 0, game: 0 };
    for (const t of times) {
        // Saída antecipada: 2 votos iguais já decidem a maioria de 3 amostras.
        // Economiza chamadas à API (a cota do Gemini é compartilhada com a
        // geração de copy e thumbnails).
        if (votes.face >= 2 || votes.game >= 2) break;

        let framePath = null;
        try {
            framePath = await extractFrame(videoStreamUrl, t);
            const v = await classifyFrame(framePath);
            if (v) votes[v]++;
        } catch (err) {
            if (isGeminiQuotaError(err)) markGeminiQuotaExhausted();
            logger.warn(`[SceneDetect] Falha ao analisar frame em ${Math.floor(t)}s: ${err.message}`);
        } finally {
            if (framePath && fs.existsSync(framePath)) { try { fs.unlinkSync(framePath); } catch { /* ignora */ } }
        }
    }

    if (votes.face === 0 && votes.game === 0) {
        logger.warn('[SceneDetect] Sem classificação válida — mantendo layout padrão (asd).');
        return 'asd';
    }

    // Empate ou maioria de rosto → 'asd' (mais seguro: foi o formato que venceu
    // o teste A/B em conteúdo com webcam). Só vai para 'hybrid' com maioria clara.
    const layout = votes.game > votes.face ? 'hybrid' : 'asd';
    logger.success(`[SceneDetect] Cena: ${votes.face} rosto / ${votes.game} jogo → layout "${layout}".`);
    return layout;
}
