// src/processor/captions.js
// Adiciona legendas automáticas e sincronizadas aos clipes.
// Fluxo: extrai áudio → Groq Whisper (timestamps) → Sanitiza → SRT → FFmpeg burn
//
// NOVO: Sanitização de profanidade ANTES de queimar as legendas no vídeo.
// Palavrões e termos ofensivos são substituídos por equivalentes limpos,
// garantindo que o texto visível no vídeo seja advertiser-friendly.
//
// Ativado por ADD_CAPTIONS=true no .env

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'fluent-ffmpeg';
import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';
import { sanitizeCaptions } from '../../poster/content-filter.js';

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Formata segundos para o timestamp do SRT: HH:MM:SS,mmm */
function toSrtTime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = Math.floor(seconds % 60);
    const ms = Math.round((seconds % 1) * 1000);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`;
}

/** Gera o conteúdo do arquivo SRT a partir dos segmentos do Whisper */
function buildSRT(segments) {
    return segments
        .map((seg, i) => `${i + 1}\n${toSrtTime(seg.start)} --> ${toSrtTime(seg.end)}\n${seg.text.trim()}\n`)
        .join('\n');
}

/**
 * Quebra texto em linhas de 3 palavras para leitura rápida (estilo Hormozi/viral).
 * 3 palavras por linha → ritmo acelerado, ideal para Shorts e TikTok.
 */
function wrapText(text, maxWordsPerLine = 3) {
    const words = text.trim().split(/\s+/).filter(Boolean);
    const lines = [];
    for (let i = 0; i < words.length; i += maxWordsPerLine) {
        lines.push(words.slice(i, i + maxWordsPerLine).join(' '));
    }
    return lines.join('\n');
}

// ─── 1. Extração de áudio do clipe ───────────────────────────────────────────

function extractAudio(videoPath) {
    const audioPath = path.join(os.tmpdir(), `cc_cap_${Date.now()}.mp3`);
    return new Promise((resolve, reject) => {
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

// ─── 2. Transcrição com Groq Whisper (com timestamps por segmento) ────────────

async function transcribeSegments(audioPath) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada no .env');

    const groq = new Groq({ apiKey });

    const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: 'whisper-large-v3-turbo',
        language: 'pt',
        response_format: 'verbose_json',
        timestamp_granularities: ['segment'],
    });

    return response.segments ?? [];
}

// ─── 3. Queima as legendas no vídeo via FFmpeg ────────────────────────────────

function burnSubtitles(videoPath, srtPath, outputPath) {
    return new Promise((resolve, reject) => {
        const srtEscaped = srtPath
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:');

        // Estilo Hormozi/viral: Impact amarela, contorno preto grosso, centro-baixo da facecam
        // Alignment=2  → centro horizontal + alinhado na base (margem inferior controlada por MarginV)
        // MarginV=180  → sobe a legenda para o centro do painel superior (facecam),
        //                logo acima da linha divisória do split-screen (y≈780 de 960)
        const style = [
            'FontName=Impact',
            'FontSize=13',
            'Bold=1',
            'PrimaryColour=&H0000FFFF',     // Amarelo vibrante (BGR: 00,FF,FF)
            'OutlineColour=&H00000000',     // Contorno preto
            'BackColour=&H00000000',        // Sem fundo
            'Outline=4',                    // Contorno extra-grosso para máxima legibilidade
            'Shadow=1',
            'Alignment=2',                  // Centro-baixo (bottom-center): posição padrão viral
            'MarginV=180',                  // Empurra para cima — fica no centro da facecam
        ].join(',');

        ffmpeg(videoPath)
            .videoFilter(`subtitles='${srtEscaped}':force_style='${style}'`)
            .videoCodec('libx264')
            .outputOptions(['-crf 18', '-b:v 5M', '-preset fast', '-movflags +faststart'])
            .audioCodec('copy')
            .output(outputPath)
            .on('start', () => logger.info('[Captions] Queimando legendas no vídeo...'))
            .on('progress', (p) => {
                if (p.percent) process.stdout.write(`\r  ⏳ Legendas: ${Math.min(p.percent, 100).toFixed(1)}%   `);
            })
            .on('end', () => { process.stdout.write('\n'); resolve(); })
            .on('error', (err) => { process.stdout.write('\n'); reject(err); })
            .run();
    });
}

// ─── Pipeline Principal ───────────────────────────────────────────────────────

/**
 * Adiciona legendas automáticas e sincronizadas ao clipe (in-place).
 * Só executa se ADD_CAPTIONS=true no .env.
 *
 * NOVO: Sanitiza o texto das legendas ANTES de queimar no vídeo.
 * Palavrões são substituídos por equivalentes limpos.
 *
 * @param {string} videoPath - Caminho absoluto do .mp4 já cortado
 * @returns {Promise<string>} Mesmo caminho, agora com legendas queimadas
 */
export async function addCaptionsToClip(videoPath) {
    if (process.env.ADD_CAPTIONS !== 'true') return videoPath;

    logger.step('[Captions] Gerando legendas automáticas com Groq Whisper...');

    let audioPath = null;
    let srtPath = null;
    const tempOut = videoPath.replace(/\.mp4$/i, '_sub.mp4');

    try {
        // 1. Extrai áudio
        audioPath = await extractAudio(videoPath);

        // 2. Transcreve com timestamps
        const segments = await transcribeSegments(audioPath);
        if (!segments.length) {
            logger.warn('[Captions] Nenhum segmento encontrado — pulando legendas.');
            return videoPath;
        }
        logger.info(`[Captions] ${segments.length} segmentos transcritos.`);

        // 3. Quebra o texto em linhas de 3 palavras (ritmo viral)
        for (const seg of segments) {
            seg.text = wrapText(seg.text);
        }

        // 4. Gera SRT e sanitiza o conteúdo completo
        srtPath = path.join(os.tmpdir(), `cc_cap_${Date.now()}.srt`);
        let srtContent = buildSRT(segments);

        // SANITIZAÇÃO: remove palavrões das legendas
        const cleanSrt = sanitizeCaptions(srtContent);
        fs.writeFileSync(srtPath, cleanSrt, 'utf-8');

        if (cleanSrt !== srtContent) {
            logger.info('[Captions] Legendas sanitizadas — palavrões removidos.');
        }

        // 5. Queima legendas
        await burnSubtitles(videoPath, srtPath, tempOut);

        // 6. Substitui o original
        fs.unlinkSync(videoPath);
        fs.renameSync(tempOut, videoPath);

        logger.success(`[Captions] Legendas adicionadas: ${path.basename(videoPath)}`);
        return videoPath;

    } catch (err) {
        logger.warn(`[Captions] Falha ao gerar legendas: ${err.message}. Vídeo sem legenda mantido.`);
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
        return videoPath;

    } finally {
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (srtPath && fs.existsSync(srtPath)) fs.unlinkSync(srtPath);
    }
}
