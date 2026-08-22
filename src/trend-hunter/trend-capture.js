// src/trend-hunter/trend-capture.js
// Persona virtual "Trend Hunter": vasculha os principais canais de cortes
// concorrentes, identifica o vídeo em alta (mais views recentes) e gera
// clipes dele via pipeline normal (heatmap → processClip).
//
// Entra no round-robin do poster como uma persona a mais, então os posts
// intercalam naturalmente: seus cortes → ... → corte em alta → seus cortes...
//
// Uso standalone: node src/trend-hunter/trend-capture.js
//
// .env:
//   TREND_CORTES_CHANNELS      canais a vasculhar (vírgula) — default abaixo
//   TREND_WEIGHT               turnos por ciclo no round-robin (default 1)
//   TREND_SCAN_PER_CHANNEL     vídeos recentes analisados por canal (default 10)
//   TREND_MAX_SOURCE_DURATION  duração máx. do vídeo-fonte em s (default 3600)

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { capturePersona } from '../capturer/capturer.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CORTES_CHANNELS = [
    'https://www.youtube.com/@CortesdoFlow/videos',
    'https://www.youtube.com/@CortesdoInteligencia/videos',
    'https://www.youtube.com/@PodpahCortes/videos',
];

const REGISTRY_FILE = path.resolve('./scheduler/trend-registry.json');

export const TREND_PERSONA = {
    name: 'trendhunter',
    displayName: 'Trend Hunter (cortes em alta)',
    platform: 'youtube',
    clipsPerRun: parseInt(process.env.TREND_CLIPS_PER_RUN || '3', 10),
    niche: 'podcast',
    weight: parseInt(process.env.TREND_WEIGHT || '1', 10),
    // Cortes de concorrentes já vêm com legendas queimadas — não sobrepor as nossas
    skipCaptions: true,
    // Fonte mista (gameplay/podcast já em 9:16 ou 16:9): preserva o frame inteiro
    layout: 'blur',
};

// ─── Registry: evita recapturar o mesmo vídeo-fonte ──────────────────────────

function loadRegistry() {
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function registerAttempted(videoId) {
    const registry = loadRegistry();
    if (!registry.includes(videoId)) {
        registry.push(videoId);
        fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }
}

// ─── Scout: lista os vídeos recentes dos canais de cortes, ordena por views ──

function getCortesChannels() {
    const raw = process.env.TREND_CORTES_CHANNELS?.trim();
    if (!raw) return DEFAULT_CORTES_CHANNELS;
    const parsed = raw.split(',').map((c) => c.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_CORTES_CHANNELS;
}

async function scanChannel(channelUrl, perChannel) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json', '--flat-playlist',
        '--playlist-end', String(perChannel),
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const v = JSON.parse(line);
        return {
            id: v.id,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            title: v.title,
            views: v.view_count ?? 0,
            duration: v.duration ?? 0,
            channel: channelUrl,
        };
    });
}

export async function scoutTrendingCortes() {
    const channels = getCortesChannels();
    const perChannel = parseInt(process.env.TREND_SCAN_PER_CHANNEL || '10', 10);
    logger.info(`[TrendCapture] Vasculhando ${channels.length} canais de cortes (${perChannel} vídeos/canal)...`);

    const all = [];
    for (const channel of channels) {
        try {
            all.push(...await scanChannel(channel, perChannel));
        } catch (err) {
            logger.warn(`[TrendCapture] Falha ao vasculhar ${channel}: ${err.message}`);
        }
    }

    all.sort((a, b) => b.views - a.views);
    logger.success(`[TrendCapture] ${all.length} vídeos encontrados — top: "${all[0]?.title}" (${all[0]?.views} views)`);
    return all;
}

// ─── Captura: baixa e corta o vídeo em alta via pipeline normal ──────────────

/**
 * Identifica o corte em alta e gera clipes dele em ./output/trendhunter/.
 * Tenta os próximos candidatos se o topo não tiver heatmap/falhar.
 * @returns {{ clipsGenerated: number, source?: object }}
 */
export async function captureTrendClip({ maxAttempts = 4 } = {}) {
    const maxDuration = parseInt(process.env.TREND_MAX_SOURCE_DURATION || '3600', 10);
    const registry = loadRegistry();

    const candidates = (await scoutTrendingCortes()).filter((v) =>
        !registry.includes(v.id) &&
        v.duration >= 120 &&           // ignora Shorts do concorrente (sem material p/ cortar)
        v.duration <= maxDuration
    );

    if (candidates.length === 0) {
        logger.warn('[TrendCapture] Nenhum candidato novo (todos já capturados ou fora dos critérios).');
        return { clipsGenerated: 0 };
    }

    for (const video of candidates.slice(0, maxAttempts)) {
        logger.step(`[TrendCapture] 🔥 Em alta: "${video.title}" (${video.views} views) — capturando...`);
        registerAttempted(video.id); // registra antes: falha não vira loop infinito

        const result = await capturePersona(TREND_PERSONA, {
            dynamicTarget: {
                platform: 'youtube',
                url: video.url,
                title: video.title,
                duration: video.duration,
            },
        });

        if (result.clipsGenerated > 0) {
            logger.success(`[TrendCapture] ${result.clipsGenerated} clipe(s) do corte em alta prontos para a fila.`);
            return { ...result, source: video };
        }
        logger.warn(`[TrendCapture] "${video.title}" não gerou clipes — tentando próximo candidato...`);
    }

    logger.error('[TrendCapture] Nenhum candidato gerou clipes nesta rodada.');
    return { clipsGenerated: 0 };
}

// ─── Execução standalone: npm run trend:capture ──────────────────────────────

if (process.argv[1] && path.basename(process.argv[1]) === 'trend-capture.js') {
    const { initBinaries } = await import('../processor/ffmpeg.js');
    initBinaries();
    const r = await captureTrendClip();
    process.exitCode = r.clipsGenerated > 0 ? 0 : 1;
}
