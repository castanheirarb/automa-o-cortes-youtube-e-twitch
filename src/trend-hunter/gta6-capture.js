// src/trend-hunter/gta6-capture.js
// Persona virtual "GTA VI Hunter": vasculha canais brasileiros de análise/reação
// sobre GTA VI, identifica o vídeo em alta e gera clipes dele via pipeline normal
// (heatmap → processClip). Mesmo padrão do Trend Hunter de futebol
// (trend-capture.js), mas isolado dele — registry e canais próprios, porque a
// fonte de conteúdo é completamente diferente (análise/teoria, não cortes de
// podcast/futebol).
//
// Por que isso existe em vez de uma persona normal em personas.js: GTA VI só
// lança em 19/11/2026 — não existe ninguém jogando ao vivo pra cortar pico de
// audiência ainda. O que existe em volume agora é conteúdo de análise/reação ao
// trailer ("GTA 6: An Extended Look", Rockstar, 27/08/2026). Quando o jogo
// lançar e streamers BR de GTA RP (Coringa, PaulinhoLOKObr, LuquEt4, Gabepeixe,
// Cellbit) começarem a jogar de verdade, é ali — em GTA6_ROTATION, poster/index.js
// — que entram personas reais (platform: 'twitch', niche: 'gta6') ponderadas via
// buildRotation, no mesmo padrão de RELIGIOUS_SOURCES/INFANTIL_SOURCES. Este
// módulo cobre só a fase pré-lançamento.
//
// Uso standalone: node src/trend-hunter/gta6-capture.js
//
// .env:
//   TREND_GTA6_CHANNELS              canais a vasculhar (vírgula) — default abaixo
//   GTA6_WEIGHT                      turnos por ciclo no round-robin (default 1)
//   TREND_GTA6_SCAN_PER_CHANNEL      vídeos recentes analisados por canal (default 10)
//   TREND_GTA6_MAX_SOURCE_DURATION   duração máx. do vídeo-fonte em s (default 3600)

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { capturePersona } from '../capturer/capturer.js';
import { sanitizeFilename } from '../utils/helpers.js';

const execFileAsync = promisify(execFile);

// Ponto de partida, não lista definitiva — validados ao vivo em 28-29/08/2026
// cobrindo o trailer "Extended Look":
//   @DavyJonesGTA6      canal NOVO, 100% dedicado a GTA VI (lançado dias atrás
//                        pela mesma equipe do Davy Jones). Só 92,9 mil inscritos,
//                        mas vídeos saindo com 192mil/193mil/846mil views cada —
//                        maior fonte encontrada até agora, prioridade máxima.
//   @CortesdoDavyJones  cortes diários de notícias/análises de games (não só
//                        GTA6); cobriu o trailer no dia seguinte (626 mil
//                        inscritos, 107 mil views no vídeo). Mais genérico que
//                        o canal acima, mas mais consistente/antigo.
// Descartados na validação: @2controlestv (games genérico, vídeo de GTA6 só
// com 233 views), @STACKZOFICIAL (true crime/mistério, GTA6 é assunto raro),
// "Coringa REAGE" (canal com só 3 vídeos até agora, cedo demais pra confiar
// como fonte recorrente — reavaliar depois que ele postar mais).
// Antes de rodar em produção, rode o scout standalone (comando no topo do
// arquivo) e ajuste TREND_GTA6_CHANNELS com os canais que realmente renderem
// clipes bons pro seu público — não assuma que essa lista é definitiva.
const DEFAULT_GTA6_CHANNELS = [
    'https://www.youtube.com/@DavyJonesGTA6/videos',
    'https://www.youtube.com/@CortesdoDavyJones/videos',
];

const REGISTRY_FILE = path.resolve('./scheduler/gta6-registry.json');

export const GTA6_PERSONA = {
    name: 'gta6hunter',
    displayName: 'GTA VI Hunter',
    platform: 'youtube',
    clipsPerRun: parseInt(process.env.GTA6_CLIPS_PER_RUN || '3', 10),
    niche: 'gta6',
    weight: parseInt(process.env.GTA6_WEIGHT || '1', 10),
    // Diferente do Trend Hunter de futebol (skipCaptions: true): a fonte aqui é
    // vídeo de análise/reação falado, sem legenda queimada — vale a pena aplicar
    // nossa legenda com highlight de palavra (karaokê) por cima.
    layout: 'blur',
    youtubeProfileDir: './profiles/chrome-youtube-04',
    tiktokProfileDir: './profiles/chrome-tiktok-04',
    // Conta TikTok do FOCONOGTAVI logada em 03/09/2026 — skipTikTok removido,
    // posta em ambas as plataformas a partir de aí.
    // Suspensão do Google (04/09/2026) revertida — API voltou a responder
    // normalmente em 04/09/2026, skipYoutube removido na época. Se cair de
    // novo, ver histórico em memória (project_gta6_youtube_suspended).
    //
    // PAUSADO em 17/09/2026 — canal boicotado (ação de terceiros, não
    // suspensão do Google). REATIVADO em 19/09/2026: Studio confirmado limpo
    // (sessão válida, zero copyright strikes/removal requests, sem banner de
    // restrição) — decisão consciente do usuário de retomar mesmo sem
    // confirmação de que o boicote passou, acompanhando como reage. Refresh
    // token da API de Dados (Comment Bot) segue com erro "account suspended"
    // à parte, não bloqueia upload via Playwright (ver memória
    // project_gta6_youtube_suspended).
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

// ─── Scout: lista os vídeos recentes dos canais, ordena por views ────────────

function getGta6Channels() {
    const raw = process.env.TREND_GTA6_CHANNELS?.trim();
    if (!raw) return DEFAULT_GTA6_CHANNELS;
    const parsed = raw.split(',').map((c) => c.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_GTA6_CHANNELS;
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

export async function scoutTrendingGta6() {
    const channels = getGta6Channels();
    const perChannel = parseInt(process.env.TREND_GTA6_SCAN_PER_CHANNEL || '10', 10);
    logger.info(`[Gta6Hunter] Vasculhando ${channels.length} canais de GTA VI (${perChannel} vídeos/canal)...`);

    const all = [];
    for (const channel of channels) {
        try {
            all.push(...await scanChannel(channel, perChannel));
        } catch (err) {
            logger.warn(`[Gta6Hunter] Falha ao vasculhar ${channel}: ${err.message}`);
        }
    }

    all.sort((a, b) => b.views - a.views);
    logger.success(`[Gta6Hunter] ${all.length} vídeos encontrados — top: "${all[0]?.title}" (${all[0]?.views} views)`);
    return all;
}

// ─── Captura: baixa e corta o vídeo em alta via pipeline normal ──────────────

/**
 * Identifica o vídeo de GTA VI em alta e gera clipes dele em ./output/gta6hunter/.
 * Tenta os próximos candidatos se o topo não tiver heatmap/falhar.
 * @returns {{ clipsGenerated: number, source?: object }}
 */
export async function captureGta6TrendClip({ maxAttempts = 4 } = {}) {
    const maxDuration = parseInt(process.env.TREND_GTA6_MAX_SOURCE_DURATION || '3600', 10);
    const registry = loadRegistry();

    const candidates = (await scoutTrendingGta6()).filter((v) =>
        !registry.includes(v.id) &&
        v.duration >= 120 &&           // ignora Shorts (sem material p/ cortar)
        v.duration <= maxDuration
    );

    if (candidates.length === 0) {
        logger.warn('[Gta6Hunter] Nenhum candidato novo (todos já capturados ou fora dos critérios).');
        return { clipsGenerated: 0 };
    }

    for (const video of candidates.slice(0, maxAttempts)) {
        logger.step(`[Gta6Hunter] 🎮 Em alta: "${video.title}" (${video.views} views) — capturando...`);
        registerAttempted(video.id); // registra antes: falha não vira loop infinito

        const result = await capturePersona(GTA6_PERSONA, {
            dynamicTarget: {
                platform: 'youtube',
                url: video.url,
                title: video.title,
                duration: video.duration,
            },
        });

        if (result.clipsGenerated > 0) {
            logger.success(`[Gta6Hunter] ${result.clipsGenerated} clipe(s) de GTA VI prontos para a fila.`);
            return { ...result, source: video };
        }
        logger.warn(`[Gta6Hunter] "${video.title}" não gerou clipes — tentando próximo candidato...`);
    }

    logger.error('[Gta6Hunter] Nenhum candidato gerou clipes nesta rodada.');
    return { clipsGenerated: 0 };
}

// ─── Vídeo longo: baixa a íntegra de um vídeo em alta (mesmos canais curados) ─
// Registry SEPARADO do dos clipes — um vídeo já cortado em Shorts continua
// elegível pro vídeo longo, e vice-versa (não competem pelo mesmo "já usado").
//
// .env:
//   LONG_VIDEO_GTA6_MIN_DURATION  duração mínima do vídeo-fonte em s (default 300 = 5min)
//   LONG_VIDEO_GTA6_MAX_DURATION  duração máxima em s (default 5400 = 90min — vídeos de
//                                  análise do Davy Jones já passaram disso)

const LONG_REGISTRY_FILE = path.resolve('./scheduler/gta6-long-registry.json');
const LONG_GTA6_DIR = path.resolve(process.env.LONG_VIDEOS_GTA6_DIR || './output/longos-gta6');

function loadLongRegistry() {
    try {
        return JSON.parse(fs.readFileSync(LONG_REGISTRY_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function registerLongAttempted(videoId) {
    const registry = loadLongRegistry();
    if (!registry.includes(videoId)) {
        registry.push(videoId);
        fs.mkdirSync(path.dirname(LONG_REGISTRY_FILE), { recursive: true });
        fs.writeFileSync(LONG_REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }
}

async function downloadFullVideo(video, destPath) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    logger.step(`[Gta6LongVideo] Baixando vídeo completo (${Math.round(video.duration / 60)}min): "${video.title}"...`);
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
 * Baixa a íntegra de um vídeo de GTA VI em alta (dos mesmos canais curados do
 * Hunter de shorts) para ./output/longos-gta6.
 * @returns {Promise<string|null>} caminho do .mp4 baixado, ou null se nada elegível
 */
export async function getGta6LongVideo({ maxAttempts = 3 } = {}) {
    const minDur = parseInt(process.env.LONG_VIDEO_GTA6_MIN_DURATION || '300', 10);
    const maxDur = parseInt(process.env.LONG_VIDEO_GTA6_MAX_DURATION || '5400', 10);
    const registry = loadLongRegistry();

    const candidates = (await scoutTrendingGta6()).filter((v) =>
        !registry.includes(v.id) &&
        v.duration >= minDur &&
        v.duration <= maxDur
    );

    if (candidates.length === 0) {
        logger.warn('[Gta6LongVideo] Nenhum vídeo elegível (duração/registry).');
        return null;
    }

    fs.mkdirSync(LONG_GTA6_DIR, { recursive: true });

    for (const video of candidates.slice(0, maxAttempts)) {
        registerLongAttempted(video.id); // antes do download: falha não vira loop
        const destPath = path.join(LONG_GTA6_DIR, `${sanitizeFilename(video.title)}.mp4`);
        try {
            await downloadFullVideo(video, destPath);
            logger.success(`[Gta6LongVideo] Vídeo longo pronto: ${path.basename(destPath)}`);
            return destPath;
        } catch (err) {
            logger.error(`[Gta6LongVideo] Falha ao baixar "${video.title}": ${err.message}`);
        }
    }

    return null;
}

// ─── Execução standalone: node src/trend-hunter/gta6-capture.js ─────────────

if (process.argv[1] && path.basename(process.argv[1]) === 'gta6-capture.js') {
    const { initBinaries } = await import('../processor/ffmpeg.js');
    initBinaries();
    const r = await captureGta6TrendClip();
    process.exitCode = r.clipsGenerated > 0 ? 0 : 1;
}
