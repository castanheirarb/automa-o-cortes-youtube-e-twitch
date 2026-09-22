// src/processor/smart-boundary.js
// Ajusta onde um clipe TERMINA para cair no fechamento natural do assunto
// (ex.: uma oração termina com "amém", uma história termina com o desfecho),
// em vez de cortar num instante fixo (peak + buffer) que pode interromper o
// que está sendo dito no meio.
//
// Fluxo: transcreve (Groq Whisper, com timestamps por segmento) uma janela
// de áudio um pouco mais larga que o corte original, manda pra IA (Gemini)
// apontar o instante onde o TÓPICO — não só a frase — se conclui, e usa esse
// instante como novo fim do clipe. Qualquer falha em qualquer etapa cai de
// volta pro fim original (targetEndTime) — nunca quebra o pipeline.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ffmpeg from 'fluent-ffmpeg';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

// Quanto além do fim "ideal" (peak + buffer) a busca pode se estender à
// procura do fechamento do assunto, e o teto absoluto de duração do clipe.
const GRACE_SECONDS = parseInt(process.env.CLIP_TOPIC_GRACE_SECONDS || '25', 10);
const ABS_MAX_SECONDS = parseInt(process.env.CLIP_TOPIC_ABS_MAX_SECONDS || '70', 10);

function extractAudioWindow(streamUrl, startTime, endTime) {
    const audioPath = path.join(os.tmpdir(), `smart-boundary-${Date.now()}.mp3`);
    const duration = endTime - startTime;
    return new Promise((resolve, reject) => {
        ffmpeg(streamUrl)
            .inputOptions([`-ss ${startTime}`, `-t ${duration}`])
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('64k')
            .audioChannels(1)
            .output(audioPath)
            .on('end', () => resolve(audioPath))
            .on('error', (err) => reject(new Error(`FFmpeg (janela de áudio): ${err.message}`)))
            .run();
    });
}

async function transcribeWithTimestamps(audioPath) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada');

    const groq = new Groq({ apiKey });
    const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
        language: 'pt',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
    });

    return response.segments || [];
}

function buildTopicEndPrompt(segments, targetOffsetSec, maxOffsetSec) {
    const transcriptBlock = segments
        .map((s) => `[${s.start.toFixed(1)}-${s.end.toFixed(1)}] ${s.text.trim()}`)
        .join('\n');

    return `Você recebe a transcrição com timestamps (em segundos, relativos ao início do trecho) de um corte de vídeo em português.
O corte foi planejado para terminar por volta de ${targetOffsetSec.toFixed(0)}s, mas pode se estender até no máximo ${maxOffsetSec.toFixed(0)}s.

Sua tarefa: aponte o INSTANTE (em segundos) onde o ASSUNTO/racional/história que está sendo contado NAQUELE MOMENTO realmente se conclui — não apenas onde uma frase termina, mas onde o tópico chega a um fechamento natural (ex.: uma oração termina com "amém" ou um "aleluia" final, uma história termina no desfecho, uma explicação termina na conclusão do raciocínio).

Regras:
- Se o assunto já tiver se encerrado ANTES de ${targetOffsetSec.toFixed(0)}s, aponte esse instante mais cedo — não estique o clipe à toa.
- Se precisar passar de ${targetOffsetSec.toFixed(0)}s pra concluir o assunto, pode ir até ${maxOffsetSec.toFixed(0)}s, mas NUNCA além disso.
- Se não for possível identificar um fechamento claro dentro da janela, retorne ${targetOffsetSec.toFixed(0)} mesmo.

Responda SOMENTE em JSON: {"endOffsetSec": number, "motivo": "string curta explicando a escolha"}

Transcrição:
${transcriptBlock}`;
}

function parseTopicEndResponse(raw, source) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const jsonMatch = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`${source} não retornou JSON válido: ${raw.substring(0, 100)}`);
        parsed = JSON.parse(jsonMatch[0]);
    }
    if (typeof parsed.endOffsetSec !== 'number' || !Number.isFinite(parsed.endOffsetSec)) {
        throw new Error(`${source} não retornou endOffsetSec válido.`);
    }
    return parsed;
}

async function pickTopicEndWithGemini(prompt) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: { temperature: 0.2, responseMimeType: 'application/json' },
    });

    const result = await model.generateContent(prompt);
    return parseTopicEndResponse(result.response.text().trim(), 'Gemini');
}

async function pickTopicEndWithGroq(prompt) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada');

    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_COPY_MODEL || 'openai/gpt-oss-120b',
        // gpt-oss-120b gasta tokens de raciocínio interno ANTES do JSON de
        // saída (até ~980 medidos com prompts mais longos) — 200 cortava
        // esse raciocínio no meio (erro json_validate_failed, mesma causa
        // raiz corrigida em metadata.js). reasoning_effort:'low' resolve na
        // raiz (mais rápido/barato também); max_tokens com folga por segurança.
        reasoning_effort: 'low',
        max_tokens: 500,
        temperature: 0.2,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: prompt }],
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error('Groq retornou resposta vazia.');
    return parseTopicEndResponse(raw, 'Groq');
}

/**
 * Pede pra IA apontar o instante (relativo ao início da janela analisada)
 * onde o assunto/raciocínio em andamento REALMENTE se conclui.
 * Gemini é o primário; a cota gratuita dele (20 req/dia) já vinha estourando
 * em produção, então cai pro Groq Llama (mesmo padrão do fallback de copy em
 * poster/metadata.js) antes de desistir.
 */
async function pickTopicEnd(segments, targetOffsetSec, maxOffsetSec) {
    const prompt = buildTopicEndPrompt(segments, targetOffsetSec, maxOffsetSec);
    try {
        return await pickTopicEndWithGemini(prompt);
    } catch (err) {
        logger.warn(`[SmartBoundary] Gemini falhou (${err.message}) — tentando Groq Llama...`);
        return pickTopicEndWithGroq(prompt);
    }
}

/**
 * Ajusta o fim de um clipe pra cair no fechamento natural do assunto, em vez
 * de um instante fixo (peak + buffer). Fallback silencioso em qualquer falha:
 * devolve targetEndTime sem quebrar o pipeline de captura.
 *
 * @param {object} opts
 * @param {string} opts.audioStreamUrl - URL de áudio (ou vídeo, se stream único) da fonte
 * @param {number} opts.startTime - início do clipe (segundos, absoluto na fonte)
 * @param {number} opts.targetEndTime - fim "ideal" atual (peak + buffer, já com o cap normal)
 * @param {number} opts.hardMaxEndTime - teto absoluto (duração do vídeo/VOD, etc.)
 * @returns {Promise<number>} novo endTime, sempre dentro de [startTime, hardMaxEndTime]
 */
export async function findSmartEndTime({ audioStreamUrl, startTime, targetEndTime, hardMaxEndTime }) {
    if (process.env.SMART_CLIP_BOUNDARY === 'false') return targetEndTime;

    const searchEndTime = Math.min(
        hardMaxEndTime,
        targetEndTime + GRACE_SECONDS,
        startTime + ABS_MAX_SECONDS,
    );
    if (searchEndTime <= targetEndTime) return targetEndTime; // sem espaço pra buscar além do fim atual

    let audioPath = null;
    try {
        audioPath = await extractAudioWindow(audioStreamUrl, startTime, searchEndTime);
        const segments = await transcribeWithTimestamps(audioPath);
        if (!segments.length) return targetEndTime;

        const targetOffsetSec = targetEndTime - startTime;
        const maxOffsetSec = searchEndTime - startTime;
        const { endOffsetSec, motivo } = await pickTopicEnd(segments, targetOffsetSec, maxOffsetSec);

        const clampedOffset = Math.max(0, Math.min(endOffsetSec, maxOffsetSec));
        const newEndTime = startTime + clampedOffset;
        logger.info(
            `[SmartBoundary] Corte ajustado para ${clampedOffset.toFixed(1)}s (era ${targetOffsetSec.toFixed(1)}s) — ${motivo || 'sem motivo informado'}`
        );
        return newEndTime;
    } catch (err) {
        logger.warn(`[SmartBoundary] Falha ao ajustar corte (${err.message}) — usando fim padrão.`);
        return targetEndTime;
    } finally {
        if (audioPath) fs.unlink(audioPath, () => {});
    }
}
