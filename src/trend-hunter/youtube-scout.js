// src/trend-hunter/youtube-scout.js
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CHANNELS = [
    'https://www.youtube.com/@FlowPodcast',
    'https://www.youtube.com/@Podpah',
    'https://www.youtube.com/@InteligenciaLtda',
    'https://www.youtube.com/@VenusPodcast',
    'https://www.youtube.com/@renatocariani',
    'https://www.youtube.com/@juliobalestrinoficial',
];

/**
 * Retorna a lista de canais a varrer.
 * Se TREND_YOUTUBE_CHANNELS estiver definido no .env (separado por vírgulas),
 * usa esses canais. Caso contrário, usa os defaults acima.
 */
function getTargetChannels() {
    const raw = process.env.TREND_YOUTUBE_CHANNELS?.trim();
    if (!raw) return DEFAULT_CHANNELS;
    const parsed = raw.split(',').map((c) => c.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_CHANNELS;
}

async function searchChannel(channelUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const args = [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', '5', // Analisa os 5 vídeos mais recentes
        '--dateafter', 'now-2d', // Filtra vídeos das últimas 48h
        channelUrl,
    ];

    const { stdout } = await execFileAsync(ytDlp, args, { maxBuffer: 10 * 1024 * 1024 });
    const videos = stdout.trim().split('\n').map(line => JSON.parse(line));

    return videos.map(v => ({
        platform: 'youtube',
        title: v.title,
        url: `https://www.youtube.com/watch?v=${v.id}`,
        views: v.view_count,
        creator: v.uploader,
        duration: v.duration,
    }));
}

export async function scoutYouTube() {
    const TARGET_CHANNELS = getTargetChannels();
    logger.info(`[TrendHunter/YT] Buscando vídeos em alta no YouTube (${TARGET_CHANNELS.length} canais)...`);
    let allVideos = [];
    for (const channel of TARGET_CHANNELS) {
        try {
            const videos = await searchChannel(channel);
            allVideos.push(...videos);
        } catch (err) {
            logger.warn(`[TrendHunter/YT] Falha ao buscar canal ${channel}: ${err.message}`);
        }
    }

    allVideos.sort((a, b) => b.views - a.views);
    logger.success(`[TrendHunter/YT] ${allVideos.length} vídeos encontrados e ordenados por views.`);
    return allVideos.slice(0, 15); // Retorna os 15 mais vistos
}
