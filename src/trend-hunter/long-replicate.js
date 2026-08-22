// src/trend-hunter/long-replicate.js
// Replica vídeos PRONTOS em alta dos canais de cortes concorrentes como
// vídeo longo do dia: em vez de recortar (Trend Hunter normal), baixa o vídeo
// INTEIRO para ./output/longos — o ciclo diário das 20h posta com metadados
// próprios gerados por transcrição (express-poster, sem #shorts).
//
// .env:
//   LONG_REPLICATE_MIN_DURATION  duração mínima do vídeo-fonte em s (default 180)
//   LONG_REPLICATE_MAX_DURATION  duração máxima em s (default 1200 = 20min)
//
// Registry próprio (scheduler/long-replicate-registry.json) evita repostar o
// mesmo vídeo-fonte.

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { scoutTrendingCortes } from './trend-capture.js';
import { sanitizeFilename } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

const REGISTRY_FILE = path.resolve('./scheduler/long-replicate-registry.json');
const LONG_DIR = path.resolve(process.env.LONG_VIDEOS_DIR || './output/longos');

function loadRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); }
    catch { return []; }
}

function registerAttempted(videoId) {
    const registry = loadRegistry();
    if (!registry.includes(videoId)) {
        registry.push(videoId);
        fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }
}

async function downloadFullVideo(video, destPath) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    logger.step(`[LongReplicate] Baixando vídeo completo (${Math.round(video.duration / 60)}min): "${video.title}"...`);
    await execFileAsync(ytDlp, [
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '-o', destPath,
        video.url,
    ], { maxBuffer: 20 * 1024 * 1024 });
    if (!fs.existsSync(destPath)) throw new Error('yt-dlp terminou mas o arquivo não existe.');
    return destPath;
}

/**
 * Baixa o vídeo em alta dos canais concorrentes para ./output/longos.
 * @returns {Promise<string|null>} caminho do .mp4 baixado, ou null se nada elegível
 */
export async function replicateTrendingLongVideo({ maxAttempts = 3 } = {}) {
    const minDur = parseInt(process.env.LONG_REPLICATE_MIN_DURATION || '180', 10);
    const maxDur = parseInt(process.env.LONG_REPLICATE_MAX_DURATION || '1200', 10);
    const registry = loadRegistry();

    const candidates = (await scoutTrendingCortes()).filter((v) =>
        !registry.includes(v.id) &&
        v.duration >= minDur &&
        v.duration <= maxDur
    );

    if (candidates.length === 0) {
        logger.warn('[LongReplicate] Nenhum vídeo em alta elegível (duração/registry).');
        return null;
    }

    fs.mkdirSync(LONG_DIR, { recursive: true });

    for (const video of candidates.slice(0, maxAttempts)) {
        registerAttempted(video.id); // antes do download: falha não vira loop
        const destPath = path.join(LONG_DIR, `${sanitizeFilename(video.title)}.mp4`);
        try {
            await downloadFullVideo(video, destPath);
            logger.success(`[LongReplicate] Vídeo longo pronto: ${path.basename(destPath)} (${video.views} views na fonte)`);
            return destPath;
        } catch (err) {
            logger.error(`[LongReplicate] Falha ao baixar "${video.title}": ${err.message}`);
        }
    }

    return null;
}

// Execução standalone: node src/trend-hunter/long-replicate.js
if (process.argv[1] && path.basename(process.argv[1]) === 'long-replicate.js') {
    const p = await replicateTrendingLongVideo();
    process.exitCode = p ? 0 : 1;
}
