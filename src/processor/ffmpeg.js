// src/processor/ffmpeg.js
// Responsável por baixar o trecho do vídeo, cortar e converter para 9:16.
// ÁUDIO: yt-dlp retorna URLs separadas de vídeo e áudio; ambas são passadas ao FFmpeg.

import ffmpeg from 'fluent-ffmpeg';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../utils/logger.js';
import { sanitizeFilename, formatDuration } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

// ─── Configuração dos binários ──────────────────────────────────────────────

function configureBinaries() {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim();
    const ffprobePath = process.env.FFPROBE_PATH?.trim();

    if (ffmpegPath) {
        ffmpeg.setFfmpegPath(ffmpegPath);
        logger.info(`FFmpeg path configurado: ${ffmpegPath}`);
    }
    if (ffprobePath) {
        ffmpeg.setFfprobePath(ffprobePath);
        logger.info(`FFprobe path configurado: ${ffprobePath}`);
    }
}

// ─── Obtenção de URLs de stream via yt-dlp ──────────────────────────────────

/**
 * Usa yt-dlp para obter as URLs diretas de stream de vídeo E áudio.
 * Quando o formato é bestvideo+bestaudio, yt-dlp retorna DUAS linhas:
 *   linha 1 → URL do vídeo (sem áudio)
 *   linha 2 → URL do áudio (sem vídeo)
 * Ambas são necessárias para que o FFmpeg produza um arquivo com som.
 *
 * @param {string} videoUrl
 * @returns {Promise<{ videoStreamUrl: string, audioStreamUrl: string|null }>}
 */
async function getStreamUrls(videoUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    logger.info('Obtendo URLs de stream via yt-dlp...');

    const { stdout } = await execFileAsync(ytDlp, [
        '--get-url',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--no-playlist',
        videoUrl,
    ]);

    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);

    return {
        videoStreamUrl: lines[0],
        audioStreamUrl: lines[1] || null, // Pode ser null se o formato já contém áudio
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureOutputDir(outputDir) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        logger.info(`Diretório de saída criado: ${outputDir}`);
    }
}

/**
 * Gera o nome do arquivo de saída (sem extensão de pasta).
 * @param {number} peakTime
 * @param {number} clipIndex
 * @param {number} totalClips
 * @returns {string}
 */
function buildOutputFilename(peakTime, clipIndex, totalClips) {
    const padded = String(clipIndex).padStart(String(totalClips).length, '0');
    return `${padded}__pico-${Math.floor(peakTime)}s.mp4`;
}

// ─── Pipeline FFmpeg ─────────────────────────────────────────────────────────

/**
 * Executa o corte e crop 9:16 usando FFmpeg.
 *
 * Quando há URLs separadas de vídeo e áudio:
 *   - Input 1: videoStreamUrl (seek + duration para baixar só o trecho)
 *   - Input 2: audioStreamUrl (seek + duration idem)
 *   - Mapeia [0:v] e [1:a] separadamente
 *
 * Crop 9:16: mantém a altura total, largura = ih*9/16, centralizado horizontalmente.
 * Codec: H.264 (libx264) + AAC 192k.
 *
 * @param {string} videoStreamUrl
 * @param {string|null} audioStreamUrl
 * @param {number} startTime - segundos
 * @param {number} endTime   - segundos
 * @param {string} outputPath
 * @returns {Promise<void>}
 */
function runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath) {
    const duration = endTime - startTime;

    logger.step(
        `Cortando ${formatDuration(duration)} ` +
        `(${formatDuration(startTime)} → ${formatDuration(endTime)})...`
    );

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg();

        // ── Input de vídeo ──────────────────────────────────────────────────────
        cmd.input(videoStreamUrl).inputOptions([
            `-ss ${startTime}`,
            `-t ${duration}`,
        ]);

        // ── Input de áudio (separado) ────────────────────────────────────────────
        if (audioStreamUrl) {
            cmd.input(audioStreamUrl).inputOptions([
                `-ss ${startTime}`,
                `-t ${duration}`,
            ]);
        }

        // ── Filtro de crop 9:16 ──────────────────────────────────────────────────
        // Recorta o centro horizontal do frame, mantendo a altura total
        cmd.videoFilter('crop=ih*9/16:ih:(iw-ih*9/16)/2:0');

        // ── Codecs ───────────────────────────────────────────────────────────────
        cmd
            .videoCodec('libx264')
            .outputOptions([
                '-crf 23',
                '-preset fast',
                '-movflags +faststart',
            ]);

        if (audioStreamUrl) {
            // Com dois inputs, precisamos mapear explicitamente vídeo do input 0 e áudio do input 1
            cmd
                .audioCodec('aac')
                .audioBitrate('192k')
                .outputOptions(['-map 0:v:0', '-map 1:a:0']);
        } else {
            // Formato combinado: áudio já está no primeiro input
            cmd.audioCodec('aac').audioBitrate('192k');
        }

        cmd
            .output(outputPath)
            .on('start', () => logger.info('FFmpeg iniciado.'))
            .on('progress', (progress) => {
                if (progress.percent) {
                    process.stdout.write(
                        `\r  ⏳ Progresso: ${Math.min(progress.percent, 100).toFixed(1)}%   `
                    );
                }
            })
            .on('end', () => {
                process.stdout.write('\n');
                resolve();
            })
            .on('error', (err) => {
                process.stdout.write('\n');
                reject(new Error(`FFmpeg error: ${err.message}`));
            })
            .run();
    });
}

// ─── Função principal do módulo ──────────────────────────────────────────────

/**
 * Processa um único clipe: obtém as URLs do stream, calcula o intervalo com buffer,
 * corta o vídeo e salva em 9:16 com áudio.
 *
 * @param {{
 *   videoUrl: string,
 *   peakTime: number,
 *   title: string,
 *   duration?: number
 * }} peakData
 * @param {number} clipIndex - Número do clip (1-based), para nomear o arquivo
 * @param {number} totalClips - Total de clipes sendo gerados
 * @returns {Promise<string>} caminho absoluto do arquivo salvo
 */
export async function processClip(peakData, clipIndex = 1, totalClips = 1) {
    const { videoUrl, peakTime, title, duration: vodDuration } = peakData;
    const bufferSeconds = parseInt(process.env.CLIP_BUFFER_SECONDS || '30', 10);
    const baseOutputDir = path.resolve(process.env.OUTPUT_DIR || './output');

    // Subpasta nomeada com o título do vídeo — ex: output/BEBADOS_NO_CT/
    const videoFolder = sanitizeFilename(title);
    const outputDir = path.join(baseOutputDir, videoFolder);

    const startTime = Math.max(0, peakTime - bufferSeconds);
    const endTime = vodDuration
        ? Math.min(vodDuration, peakTime + bufferSeconds)
        : peakTime + bufferSeconds;

    logger.info(
        `Clip ${clipIndex}/${totalClips} — Intervalo: ${formatDuration(startTime)} → ${formatDuration(endTime)} ` +
        `(buffer de ${bufferSeconds}s antes e depois)`
    );

    ensureOutputDir(outputDir);

    const filename = buildOutputFilename(peakTime, clipIndex, totalClips);
    const outputPath = path.join(outputDir, filename);

    // Evita reprocessar clipes já existentes
    if (fs.existsSync(outputPath)) {
        logger.warn(`Clipe já existe, pulando: ${filename}`);
        return outputPath;
    }

    const { videoStreamUrl, audioStreamUrl } = await getStreamUrls(videoUrl);

    await runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath);

    logger.success(`Clipe ${clipIndex}/${totalClips} salvo: ${filename}`);
    return outputPath;
}

/**
 * Inicializa os binários — deve ser chamado uma vez antes de processar os clipes.
 */
export function initBinaries() {
    configureBinaries();
}
