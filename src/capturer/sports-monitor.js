// src/capturer/sports-monitor.js
// Monitor de background para canais de futebol (src/capturer/sports-channels.js).
// Faz polling periódico via yt-dlp, detecta VODs de jogos completos novos e
// dispara o VodMiner (chat replay + heatmap → gols → clipe → postagem express),
// espelhando a arquitetura do youtube-monitor.js (personas).
//
// Uso via orchestrator: node src/orchestrator.js --sports-monitor
// Uso direto:           node src/capturer/sports-monitor.js

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { SPORTS_CHANNELS } from './sports-channels.js';
import { mineVodPeaks } from './sports-vod-miner.js';
import { initBinaries } from '../processor/ffmpeg.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// ─── Configuração ─────────────────────────────────────────────────────────────

const POLL_MS      = parseInt(process.env.SPORTS_MONITOR_INTERVAL     || '900', 10) * 1000;
// Default cobre desde resenha/entrevista (~10min) até jogo completo — o VodMiner
// decide a estratégia (chat de gol vs. heatmap) por conta própria a partir do vídeo.
const MIN_DURATION = parseInt(process.env.SPORTS_MONITOR_MIN_DURATION || '600', 10);
const CACHE_MAX    = 500;
const CACHE_PATH   = path.resolve('./tmp/sports-monitor-history.json');

// Rastreia canais em mineração — impede encavalamento
const activeMining = new Set();

// ─── Cache FIFO ───────────────────────────────────────────────────────────────

function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
            if (Array.isArray(data)) return data;
        }
    } catch { /* arquivo corrompido ou inexistente — começa do zero */ }
    return [];
}

function saveCache(ids) {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(ids, null, 2), 'utf8');
}

function pushToCache(ids, newId) {
    if (ids.includes(newId)) return ids;
    const next = [...ids, newId];
    return next.length > CACHE_MAX ? next.slice(next.length - CACHE_MAX) : next;
}

// ─── Descoberta via yt-dlp ────────────────────────────────────────────────────

async function fetchRecentVideos(channelUrl, count = 5) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';

    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', String(count),
        '--skip-download',
        '--no-warnings',
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    return stdout.trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .map((entry) => ({
            id:        entry.id,
            title:     entry.title || entry.id,
            duration:  entry.duration ?? 0,
            url:       entry.url?.startsWith('http')
                ? entry.url
                : `https://www.youtube.com/watch?v=${entry.id}`,
        }));
}

// ─── Checagem por Canal ───────────────────────────────────────────────────────

async function checkChannel(channel, cache) {
    if (activeMining.has(channel.name)) {
        logger.info(`[Sports-Monitor] ${channel.displayName}: mineração em andamento — pulando.`);
        return cache;
    }

    let videos;
    try {
        videos = await fetchRecentVideos(channel.channelUrl, channel.scanDepth ?? 5);
    } catch (err) {
        logger.warn(`[Sports-Monitor] ${channel.displayName}: falha ao buscar videos — ${err.message}`);
        return cache;
    }

    const minDuration = channel.minDurationSec ?? MIN_DURATION;
    let updatedCache = cache;
    let dispatched = 0;

    for (const video of videos) {
        if (updatedCache.includes(video.id)) continue;

        // Filtro de título — evita minerar todo o canal quando ele publica
        // muito conteúdo que não é do escopo esportivo (ex: Podpah/Quebrada FC)
        if (channel.titleFilter && !video.title.toLowerCase().includes(channel.titleFilter.toLowerCase())) {
            continue;
        }

        // Duração desconhecida (live em andamento, ainda não resolvida pelo YT)
        if (video.duration === 0) {
            logger.info(`[Sports-Monitor] "${video.title}": duracao desconhecida — aguardando proximo ciclo.`);
            continue;
        }

        // Curto demais para valer a pena minerar (Shorts, vinheta, teaser)
        if (video.duration < minDuration) {
            logger.info(
                `[Sports-Monitor] "${video.title}" ignorado — ${video.duration}s < ${minDuration}s minimo.`
            );
            updatedCache = pushToCache(updatedCache, video.id);
            continue;
        }

        // Elegível — cacheia imediatamente antes de disparar (evita duplicata em crash)
        updatedCache = pushToCache(updatedCache, video.id);
        saveCache(updatedCache);

        dispatched++;
        logger.info(
            `[Sports-Monitor] Novo jogo elegivel: "${video.title}" (${video.duration}s) — iniciando mineração...`
        );

        activeMining.add(channel.name);
        mineVodPeaks(video.url, channel.clipsPerRun ?? 3)
            .then((result) => {
                logger.success(
                    `[Sports-Monitor] ${channel.displayName}: "${video.title}" — ` +
                    `${result.posted}/${result.peaksFound} lance(s) postado(s) (estrategia: ${result.strategy}).`
                );
            })
            .catch((err) => logger.error(`[Sports-Monitor] Mineração falhou para "${video.title}": ${err.message}`))
            .finally(() => activeMining.delete(channel.name));

        // 1 jogo novo por canal por ciclo evita sobrecarga no pipeline de FFmpeg
        break;
    }

    if (dispatched === 0 && videos.length > 0) {
        logger.info(`[Sports-Monitor] ${channel.displayName}: sem novidades.`);
    }

    return updatedCache;
}

// ─── Loop Principal ───────────────────────────────────────────────────────────

export async function startSportsMonitor(filterNames = []) {
    initBinaries();

    const targets = filterNames.length > 0
        ? SPORTS_CHANNELS.filter((c) => filterNames.includes(c.name))
        : SPORTS_CHANNELS;

    if (targets.length === 0) {
        logger.error('[Sports-Monitor] Nenhum canal encontrado em sports-channels.js. Encerrando.');
        return;
    }

    const names = targets.map((c) => c.displayName).join(', ');
    logger.info(`\n⚽ Sports Monitor iniciado — monitorando: ${names}`);
    logger.info(`   Polling a cada ${POLL_MS / 1000}s | Duracao minima: ${MIN_DURATION}s`);
    logger.info(`   Cache: ${CACHE_PATH}\n`);

    let cache = loadCache();
    logger.info(`[Sports-Monitor] ${cache.length} ID(s) no historico. Iniciando primeira checagem...\n`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        for (const channel of targets) {
            try {
                cache = await checkChannel(channel, cache);
            } catch (err) {
                logger.warn(`[Sports-Monitor] Erro inesperado em "${channel.displayName}": ${err.message}`);
            }
        }

        logger.info(`[Sports-Monitor] Proxima checagem em ${POLL_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}
