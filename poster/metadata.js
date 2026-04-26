// poster/metadata.js — MODO VIRAL PRO
// Pipeline de metadados virais:
// 1. Extrai áudio do .mp4 com fluent-ffmpeg
// 2. Transcreve com Groq (whisper-large-v3-turbo) — gratuito
// 3. Sanitiza transcrição (remove palavrões/ofensas)
// 4. Gera copy viral com Gemini 2.5 Flash (fórmulas + nicho) ou Groq Llama 3.3 (fallback)
// 5. Aplica branding automático ("| Cortes do [Nome]")
// 6. Valida e filtra resultado final
// 7. Deleta o áudio temporário

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'fluent-ffmpeg';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';
import { validateAndLog } from './metadata-validator.js';
import { sanitizeTranscript, sanitizeMetadataText } from './content-filter.js';
import { getPersonaBranding } from './branding.js';
import { PERSONAS_MAP } from '../src/capturer/personas.js';

// ─── BANCO DE FÓRMULAS VIRAIS (baseado em dados reais dos maiores canais) ────

const VIRAL_FORMULAS = {
    podcast: [
        'REVELAÇÃO: "[CONVIDADO] REVELA [ASSUNTO SENSÍVEL]"',
        'CONFRONTO: "[PESSOA1] E [PESSOA2] DISCUTEM SOBRE [POLÊMICA]"',
        'PERGUNTA CHOCANTE: "[ASSUNTO] É UM CAMINHO SEM VOLTA?"',
        'CITAÇÃO DIRETA: "\"[FRASE MAIS IMPACTANTE]\" - [CONVIDADO]"',
        'VERDADE OCULTA: "O QUE NÃO TE CONTARAM SOBRE [ASSUNTO]"',
        'CONFISSÃO: "[CONVIDADO] ADMITIU QUE [REVELAÇÃO]"',
    ],
    gaming: [
        'REAÇÃO ÉPICA: "[STREAMER] NÃO ACREDITOU NO QUE ACONTECEU"',
        'JOGADA IMPOSSÍVEL: "A JOGADA MAIS INSANA DE [STREAMER]"',
        'FAIL ENGRAÇADO: "[STREAMER] PASSOU A MAIOR VERGONHA AO VIVO"',
        'RAGE: "[STREAMER] PERDEU A PACIÊNCIA COM [JOGO]"',
        'CLUTCH: "[STREAMER] VIROU O JOGO SOZINHO"',
    ],
    react: [
        'REAGE: "[STREAMER] REAGE A [ASSUNTO] - [SUBTÍTULO ENGRAÇADO]"',
        'NÃO SE SEGUROU: "[STREAMER] PASSOU MAL DE RIR COM [VÍDEO]"',
        'EMOÇÃO: "[STREAMER] FOI ÀS LÁGRIMAS REAGINDO A [VÍDEO]"',
        'ABSURDO: "\"ISSO AQUI É LOUCURA\": [STREAMER] FICA CHOCADO"',
    ],
    fitness: [
        'REVELAÇÃO FITNESS: "[ATLETA] CONTA O SEGREDO DE [RESULTADO]"',
        'POLÊMICA: "[ATLETA] FALA A VERDADE SOBRE [SUPLEMENTO/DIETA]"',
        'DESAFIO: "[ATLETA] TENTOU [DESAFIO] E O RESULTADO FOI..."',
    ],
    default: [
        'CURIOSIDADE: "VOCÊ SABIA QUE [FATO DO VÍDEO]?"',
        'IMPACTO: "A CENA QUE CHOCOU A TODOS NA LIVE"',
        'REVELAÇÃO: "[PESSOA] FINALMENTE CONTOU A VERDADE"',
    ],
};

// ─── PROMPT DO COPYWRITER VIRAL ───────────────────────────────────────────────

function buildCopyPrompt(niche, formulas) {
    return `Copywriter de YouTube Shorts/TikTok. Gere metadados em JSON puro.

NICHO DO CANAL: ${niche}

FÓRMULAS DE TÍTULO (escolha UMA e adapte ao conteúdo real da transcrição):
${formulas}

EXEMPLOS DE TÍTULOS DE SUCESSO (inspire-se no padrão, NÃO copie):
- "SATANISMO É UM CAMINHO SEM VOLTA? | Cortes do Flow"
- "MARINHO COMPROU A LOJA TODA EM DINHEIRO | Cortes do Flow"
- "CASIMIRO REAGE: SHOW DO MILHÃO - PROERD É O PROGRAMA | Cortes do Casimito"
- "SEI a VERDADE sobre GOLEIRO BRUNO e ELIZA SAMUDIO (Beto Ribeiro)"
- "RENATO CARIANI REVELA O SEGREDO DA SUA DIETA"

REGRAS INVIOLÁVEIS:
1. ZERO palavrões, xingamentos, ofensas, termos sexuais, violentos ou de ódio
2. Conteúdo 100% seguro para anunciantes (advertiser-friendly)
3. Se a transcrição contiver linguagem imprópria, REFORMULE de forma limpa
4. NÃO revele o final — crie gancho de curiosidade
5. NÃO use: "você não vai acreditar", "incrível", "chocante", "imperdível", "clique aqui"

TÍTULO (campo "titulo"):
- 40-70 caracteres, use CAIXA ALTA em palavras-chave para impacto
- Máx 2 emojis, sem hashtags no título
- Deve ter gatilho: pergunta, revelação, humor, surpresa ou tensão

DESCRIÇÃO (campo "descricao"):
- 1-2 frases que aprofundam o gancho, sem revelar o final
- Termine com: "Inscreva-se para mais! 🎬"
- Máx 200 caracteres

HASHTAGS (campo "hashtags"):
- 5 hashtags separadas por espaço, #shorts primeiro
- 1 de nicho amplo + 3 específicas do vídeo + 1 do criador
- Sem acentos, máx 30 chars cada

TEXTO DA THUMBNAIL (campo "thumbText"):
- 3-5 palavras em CAIXA ALTA que COMPLEMENTEM o título (NÃO repita o título)
- Ex: Se título é "ELE REVELOU O SEGREDO", thumbText pode ser "NINGUÉM ESPERAVA"

Responda APENAS com JSON válido:
{"titulo":"...","descricao":"...","hashtags":"#shorts #tag2 #tag3 #tag4 #tag5","thumbText":"..."}`;
}

// ─── 1. Extração de Áudio ─────────────────────────────────────────────────────

export function extractAudio(videoPath) {
    const audioPath = path.join(os.tmpdir(), `canal_corte_${Date.now()}.mp3`);
    return new Promise((resolve, reject) => {
        logger.info('[Metadata] Extraindo áudio do vídeo...');
        ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('64k')
            .audioChannels(1)
            .output(audioPath)
            .on('end', () => resolve(audioPath))
            .on('error', reject)
            .run();
    });
}

// ─── 2. Transcrição com Groq (Whisper) — gratuito ────────────────────────────

export async function transcribeAudio(audioPath) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada no .env');

    logger.info('[Metadata] Transcrevendo áudio com Groq Whisper...');
    const groq = new Groq({ apiKey });
    const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-large-v3-turbo',
        language: 'pt',
        response_format: 'text',
    });

    const text = typeof response === 'string' ? response : response.text ?? '';
    if (!text?.trim()) throw new Error('Groq retornou transcrição vazia.');
    logger.info(`[Metadata] Transcrição bruta: "${text.substring(0, 80)}..."`);
    return text;
}

// ─── 3. Detecta persona e nicho a partir do caminho do vídeo ─────────────────

function getPersonaInfo(videoPath) {
    const parts = videoPath.replace(/\\/g, '/').split('/');
    const personaName = parts.find((dir) => PERSONAS_MAP[dir]);
    if (!personaName) return { name: 'default', niche: 'default', branding: '' };

    const persona = PERSONAS_MAP[personaName];
    return {
        name: persona.displayName || persona.name,
        niche: persona.niche || 'default',
        branding: getPersonaBranding(persona),
    };
}

// ─── 4. Geração de Copy com Gemini 2.5 Flash (primário) ──────────────────────

async function generateCopyWithGemini(transcript, videoPath) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

    const { name, niche, branding } = getPersonaInfo(videoPath);
    logger.info(`[Metadata] Gerando copy viral com Gemini 2.5 Flash (Nicho: ${niche}, Persona: ${name})`);

    const formulasForNiche = (VIRAL_FORMULAS[niche] || VIRAL_FORMULAS.default).map((f) => `- ${f}`).join('\n');
    const prompt = buildCopyPrompt(niche, formulasForNiche);

    const cleanTranscript = sanitizeTranscript(transcript);
    const trimmedTranscript = cleanTranscript.length > 800
        ? cleanTranscript.substring(0, 800) + '...'
        : cleanTranscript;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: {
            temperature: 0.5,
            responseMimeType: 'application/json',
        },
    });

    const result = await model.generateContent(
        `${prompt}\n\nTranscrição do vídeo para análise:\n\n${trimmedTranscript}`
    );

    const raw = result.response.text().trim();
    let metadata;
    try {
        metadata = JSON.parse(raw);
    } catch {
        const jsonMatch = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`Gemini não retornou JSON válido: ${raw.substring(0, 100)}`);
        metadata = JSON.parse(jsonMatch[0]);
    }
    if (!metadata.titulo || !metadata.descricao || !metadata.hashtags) {
        throw new Error(`JSON incompleto: ${raw.substring(0, 100)}`);
    }

    metadata.titulo = `${sanitizeMetadataText(metadata.titulo)} ${branding}`.trim();
    metadata.descricao = sanitizeMetadataText(metadata.descricao);
    metadata.thumbText = sanitizeMetadataText(metadata.thumbText || '');
    if (metadata.titulo.length > 100) metadata.titulo = metadata.titulo.substring(0, 97) + '...';

    logger.success(`[Metadata] Título gerado: "${metadata.titulo}"`);
    return metadata;
}

// ─── 4b. Fallback: Groq/Llama com prompt restritivo ──────────────────────────

async function generateCopyWithGroq(transcript, videoPath) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada');

    const { niche, branding } = getPersonaInfo(videoPath);
    logger.warn(`[Metadata] Fallback: gerando copy com Groq Llama 3.3 70B (Nicho: ${niche})`);

    const formulasForNiche = (VIRAL_FORMULAS[niche] || VIRAL_FORMULAS.default).map((f) => `- ${f}`).join('\n');
    const prompt = buildCopyPrompt(niche, formulasForNiche);

    const cleanTranscript = sanitizeTranscript(transcript);
    const trimmedTranscript = cleanTranscript.length > 500
        ? cleanTranscript.substring(0, 500) + '...'
        : cleanTranscript;

    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_COPY_MODEL || 'llama-3.3-70b-versatile',
        max_tokens: 300,
        temperature: 0.5,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Transcrição:\n${trimmedTranscript}` },
        ],
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error('Groq retornou resposta vazia.');

    const jsonMatch = raw.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Groq não retornou JSON válido: ${raw.substring(0, 100)}`);

    const metadata = JSON.parse(jsonMatch[0]);
    if (!metadata.titulo || !metadata.descricao || !metadata.hashtags) {
        throw new Error(`JSON incompleto: ${raw.substring(0, 100)}`);
    }

    metadata.titulo = `${sanitizeMetadataText(metadata.titulo)} ${branding}`.trim();
    metadata.descricao = sanitizeMetadataText(metadata.descricao);
    metadata.thumbText = sanitizeMetadataText(metadata.thumbText || '');
    if (metadata.titulo.length > 100) metadata.titulo = metadata.titulo.substring(0, 97) + '...';

    logger.success(`[Metadata] Título gerado (fallback): "${metadata.titulo}"`);
    return metadata;
}

// ─── 5. Geração com validação e retry ────────────────────────────────────────

export async function generateCopy(transcript, videoPath) {
    const hasGemini = !!process.env.GEMINI_API_KEY?.trim();
    if (hasGemini) {
        try {
            return await generateCopyWithGemini(transcript, videoPath);
        } catch (err) {
            logger.warn(`[Metadata] Gemini falhou: ${err.message} — tentando Groq...`);
        }
    }
    return await generateCopyWithGroq(transcript, videoPath);
}

async function generateCopyWithValidation(transcript, videoPath) {
    let metadata = await generateCopy(transcript, videoPath);
    let validated = validateAndLog(metadata);

    if (!validated._validation.valid) {
        const criticalErrors = validated._validation.errors.filter(
            (e) => e.includes('já usado') || e.includes('proibida') || e.includes('muito curto') || e.includes('ofensiva')
        );
        if (criticalErrors.length > 0) {
            logger.warn('[Metadata] Regenerando por erros críticos...');
            const retryTranscript = `${transcript}\n\n[INSTRUÇÃO EXTRA: Título COMPLETAMENTE DIFERENTE e original. Erros: ${criticalErrors.join('; ')}]`;
            try {
                metadata = await generateCopy(retryTranscript, videoPath);
                validated = validateAndLog(metadata);
            } catch (err) {
                logger.warn(`[Metadata] Regeneração falhou: ${err.message}`);
            }
        }
    }

    return {
        titulo: validated.titulo,
        descricao: validated.descricao,
        hashtags: validated.hashtags,
        thumbText: metadata.thumbText || '',
    };
}

// ─── 6. Pipeline Completo ─────────────────────────────────────────────────────

export async function generateMetadata(videoPath) {
    let audioPath = null;
    try {
        audioPath = await extractAudio(videoPath);
        const transcript = await transcribeAudio(audioPath);
        const metadata = await generateCopyWithValidation(transcript, videoPath);
        return { ...metadata, transcript };
    } finally {
        if (audioPath && fs.existsSync(audioPath)) {
            fs.unlinkSync(audioPath);
            logger.info('[Metadata] Áudio temporário removido.');
        }
    }
}

// ─── Formatadores ─────────────────────────────────────────────────────────────

export function formatTitle(metadata) {
    // Título limpo sem hashtags — hashtags no título prejudicam SEO e distribuição do YouTube
    return metadata.titulo.trim();
}

export function formatYouTubeDescription(metadata) {
    return `${metadata.descricao.trim()}\n\n${metadata.hashtags.trim()}`;
}

export function formatTikTokCaption(metadata) {
    const parts = [
        metadata.titulo.trim(),
        metadata.descricao.trim(),
        metadata.hashtags.trim(),
    ].filter(Boolean);
    return parts.join('\n\n').slice(0, 2200);
}

export function generateFallbackMetadata(filename) {
    logger.warn('[Metadata] APIs não configuradas — usando título baseado no arquivo.');
    const base = path.basename(filename, '.mp4')
        .replace(/^\d+__/, '')
        .replace(/__pico-\d+s$/, '')
        .replace(/_+/g, ' ')
        .trim();
    return {
        titulo: base.substring(0, 60) || 'Momento imperdível da live',
        descricao: 'Inscreva-se para mais cortes! 🎬',
        hashtags: '#shorts #cortespodcast #cortes #podcast #viral',
        thumbText: '',
    };
}

// ─── CLI (teste isolado) ──────────────────────────────────────────────────────

if (process.argv[1].endsWith('metadata.js')) {
    const videoPath = process.argv[2];
    if (!videoPath) {
        console.error('Uso: node poster/metadata.js <arquivo.mp4>');
        process.exit(1);
    }
    try {
        const meta = await generateMetadata(path.resolve(videoPath));
        console.log('\n' + JSON.stringify(meta, null, 2));
    } catch (err) {
        console.error('Erro:', err.message);
        process.exit(1);
    }
}
