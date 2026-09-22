// src/canal-infantil/long-video.js
// Vídeo longo diário do Canal Infantil: baixa um vídeo INTEIRO do canal oficial
// do Luccas Neto (não recorta, não usa fonte de terceiros) para
// ./output/longos-infantil — o ciclo diário do poster sobe com metadados
// próprios gerados por transcrição (express-poster, sem #shorts), no perfil
// dedicado do canal infantil.
//
// Mesmo padrão de src/canal-da-fe/long-video.js, mas sem isolamento de voz
// (Demucs) — aquilo é mitigação específica pro copyright strike de música de
// fundo em live de oração, não se aplica ao conteúdo do Luccas Neto.
//
// .env:
//   LONG_VIDEO_INFANTIL_MIN_DURATION  duração mínima do vídeo-fonte em s (default 300 = 5min)
//   LONG_VIDEO_INFANTIL_MAX_DURATION  duração máxima em s (default 3600 = 60min)
//
// Registry próprio (scheduler/long-video-infantil-registry.json) evita repostar
// o mesmo vídeo.

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { fetchYouTubeVideoList } from '../capturer/fetcher.js';
import { sanitizeFilename } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

const LUCASNETO_CHANNEL_URL = 'https://www.youtube.com/@luccasneto/videos';
const REGISTRY_FILE = path.resolve('./scheduler/long-video-infantil-registry.json');
const LONG_INFANTIL_DIR = path.resolve(process.env.LONG_VIDEOS_INFANTIL_DIR || './output/longos-infantil');

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
    logger.step(`[LongVideoInfantil] Baixando vídeo completo (${Math.round(video.duration / 60)}min): "${video.title}"...`);
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
 * Baixa um vídeo inteiro do canal do Luccas Neto para ./output/longos-infantil.
 * @returns {Promise<string|null>} caminho do .mp4 baixado, ou null se nada elegível
 */
export async function getLucasNetoLongVideo({ maxAttempts = 3, listSize = 15 } = {}) {
    const minDur = parseInt(process.env.LONG_VIDEO_INFANTIL_MIN_DURATION || '300', 10);
    const maxDur = parseInt(process.env.LONG_VIDEO_INFANTIL_MAX_DURATION || '3600', 10);
    const registry = loadRegistry();

    logger.info(`[LongVideoInfantil] Buscando vídeos recentes do canal do Luccas Neto...`);
    let videos;
    try {
        videos = await fetchYouTubeVideoList(LUCASNETO_CHANNEL_URL, listSize);
    } catch (err) {
        logger.error(`[LongVideoInfantil] Falha ao listar vídeos do canal: ${err.message}`);
        return null;
    }

    const candidates = videos.filter((v) =>
        !registry.includes(v.id) &&
        v.duration !== null &&
        v.duration >= minDur &&
        v.duration <= maxDur
    );

    if (candidates.length === 0) {
        logger.warn('[LongVideoInfantil] Nenhum vídeo elegível do Luccas Neto (duração/registry).');
        return null;
    }

    fs.mkdirSync(LONG_INFANTIL_DIR, { recursive: true });

    for (const video of candidates.slice(0, maxAttempts)) {
        registerAttempted(video.id); // antes do download: falha não vira loop
        const destPath = path.join(LONG_INFANTIL_DIR, `${sanitizeFilename(video.title)}.mp4`);
        try {
            await downloadFullVideo(video, destPath);
            logger.success(`[LongVideoInfantil] Vídeo longo pronto: ${path.basename(destPath)}`);
            return destPath;
        } catch (err) {
            logger.error(`[LongVideoInfantil] Falha ao baixar "${video.title}": ${err.message}`);
        }
    }

    return null;
}

// Execução standalone: node src/canal-infantil/long-video.js
if (process.argv[1] && path.basename(process.argv[1]) === 'long-video.js') {
    const p = await getLucasNetoLongVideo();
    process.exitCode = p ? 0 : 1;
}
