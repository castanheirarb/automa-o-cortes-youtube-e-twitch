// src/canal-da-fe/long-video.js
// Vídeo longo diário do Canal da Fé: baixa uma live/prédica INTEIRA do canal
// oficial do Bispo Bruno Leonardo (não recorta, não usa fonte de terceiros)
// para ./output/longos-fe — o ciclo diário do poster sobe com metadados
// próprios gerados por transcrição (express-poster, sem #shorts), no perfil
// dedicado do canal religioso.
//
// Mesmo padrão de src/trend-hunter/long-replicate.js, mas a fonte é sempre o
// canal do Bispo (fetchYouTubeVideoList), nunca concorrentes.
//
// .env:
//   LONG_VIDEO_FE_MIN_DURATION  duração mínima do vídeo-fonte em s (default 300 = 5min)
//   LONG_VIDEO_FE_MAX_DURATION  duração máxima em s (default 3600 = 60min)
//
// Registry próprio (scheduler/long-video-fe-registry.json) evita repostar a
// mesma prédica/live.

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { fetchYouTubeVideoList } from '../capturer/fetcher.js';
import { sanitizeFilename } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

const BISPO_CHANNEL_URL = 'https://www.youtube.com/@BispoBrunoLeonardo/videos';
const REGISTRY_FILE = path.resolve('./scheduler/long-video-fe-registry.json');
const LONG_FE_DIR = path.resolve(process.env.LONG_VIDEOS_FE_DIR || './output/longos-fe');

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
    logger.step(`[LongVideoFé] Baixando vídeo completo (${Math.round(video.duration / 60)}min): "${video.title}"...`);
    await execFileAsync(ytDlp, [
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '-o', destPath,
        video.videoUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });
    if (!fs.existsSync(destPath)) throw new Error('yt-dlp terminou mas o arquivo não existe.');
    return destPath;
}

/**
 * Baixa uma prédica/live inteira do canal do Bispo Bruno Leonardo para
 * ./output/longos-fe.
 * @returns {Promise<string|null>} caminho do .mp4 baixado, ou null se nada elegível
 */
export async function getBispoLongVideo({ maxAttempts = 3, listSize = 15 } = {}) {
    const minDur = parseInt(process.env.LONG_VIDEO_FE_MIN_DURATION || '300', 10);
    const maxDur = parseInt(process.env.LONG_VIDEO_FE_MAX_DURATION || '3600', 10);
    const registry = loadRegistry();

    logger.info(`[LongVideoFé] Buscando vídeos recentes do canal do Bispo Bruno Leonardo...`);
    let videos;
    try {
        videos = await fetchYouTubeVideoList(BISPO_CHANNEL_URL, listSize);
    } catch (err) {
        logger.error(`[LongVideoFé] Falha ao listar vídeos do canal: ${err.message}`);
        return null;
    }

    const candidates = videos.filter((v) =>
        !registry.includes(v.id) &&
        v.duration !== null &&
        v.duration >= minDur &&
        v.duration <= maxDur
    );

    if (candidates.length === 0) {
        logger.warn('[LongVideoFé] Nenhum vídeo elegível do Bispo (duração/registry).');
        return null;
    }

    fs.mkdirSync(LONG_FE_DIR, { recursive: true });

    for (const video of candidates.slice(0, maxAttempts)) {
        registerAttempted(video.id); // antes do download: falha não vira loop
        const destPath = path.join(LONG_FE_DIR, `${sanitizeFilename(video.title)}.mp4`);
        try {
            await downloadFullVideo(video, destPath);
            logger.success(`[LongVideoFé] Vídeo longo pronto: ${path.basename(destPath)}`);
            return destPath;
        } catch (err) {
            logger.error(`[LongVideoFé] Falha ao baixar "${video.title}": ${err.message}`);
        }
    }

    return null;
}

// Execução standalone: node src/canal-da-fe/long-video.js
if (process.argv[1] && path.basename(process.argv[1]) === 'long-video.js') {
    const p = await getBispoLongVideo();
    process.exitCode = p ? 0 : 1;
}
