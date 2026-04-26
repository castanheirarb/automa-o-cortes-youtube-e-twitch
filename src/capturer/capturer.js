// src/capturer/capturer.js
// Orquestrador de captação por persona.
// Varre múltiplos vídeos/VODs por canal até encontrar um com picos válidos.
// YouTube: heatmap via yt-dlp (testa vários vídeos até achar um com dados)
// Twitch:  Clips API → Chat Density → Uniforme (Opção C sobre cada VOD)

import path from 'node:path';
import fs from 'node:fs';
import { fetchLatestYouTubeVideo, fetchTwitchVODList } from './fetcher.js';
import { getYoutubePeaks } from '../platforms/youtube.js';
import { getTwitchLivePeaks } from '../platforms/twitch-peaks.js';
import { processClip, initBinaries } from '../processor/ffmpeg.js';
import { logger } from '../utils/logger.js';

const OUTPUT_BASE = path.resolve(process.env.OUTPUT_DIR || './output');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function countExistingClips(personaDir) {
    // Busca recursiva: clipes ficam em subpastas (output/{persona}/{titulo}/clip.mp4)
    function walk(dir) {
        let count = 0;
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) count += walk(path.join(dir, entry.name));
                else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) count++;
            }
        } catch { /* pasta inacessível */ }
        return count;
    }
    return walk(personaDir);
}

function ensurePersonaDir(personaName) {
    const dir = path.join(OUTPUT_BASE, personaName);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// ─── YouTube: varre N vídeos até achar um com heatmap ────────────────────────

async function findYouTubePeaks(persona) {
    const MAX_ATTEMPTS = parseInt(process.env.YOUTUBE_SCAN_DEPTH || '8', 10);
    const offset = persona.videoOffset ?? 1;

    for (let attempt = offset; attempt <= offset + MAX_ATTEMPTS - 1; attempt++) {
        try {
            logger.info(`[Capturer] YouTube: tentando vídeo #${attempt} de ${persona.displayName}...`);
            const { videoUrl, title, duration } = await fetchLatestYouTubeVideo(persona.channelUrl, attempt);

            const peaks = await getYoutubePeaks(videoUrl, persona.clipsPerRun);
            if (peaks.length > 0) {
                logger.success(`[Capturer] Heatmap encontrado no vídeo #${attempt}: "${title}"`);
                return { peaks, videoUrl, title, duration };
            }
        } catch (err) {
            // "Nenhum dado de heatmap" → tenta o próximo; outros erros → loga e tenta próximo
            const isHeatmapErr = err.message.includes('heatmap') || err.message.includes('Most Replayed');
            if (!isHeatmapErr) {
                logger.warn(`[Capturer] Vídeo #${attempt} falhou: ${err.message}`);
            }
        }
    }
    throw new Error(`Nenhum dos ${MAX_ATTEMPTS} vídeos de "${persona.displayName}" tem heatmap disponível.`);
}

// ─── Twitch: varre N VODs usando Clips API (Opção C) ─────────────────────────

async function findTwitchPeaks(persona) {
    const MAX_VODS = parseInt(process.env.TWITCH_SCAN_DEPTH || '5', 10);

    let vods;
    try {
        vods = await fetchTwitchVODList(persona.channelUrl, MAX_VODS);
    } catch (err) {
        throw new Error(`Não foi possível buscar VODs de "${persona.displayName}": ${err.message}`);
    }

    if (!vods || vods.length === 0) {
        throw new Error(`Nenhum VOD arquivado encontrado para "${persona.displayName}".`);
    }

    for (const vod of vods) {
        try {
            logger.info(`[Capturer] Twitch VOD: "${vod.title}" (${vod.duration}) — buscando peaks...`);

            const peaks = await getTwitchLivePeaks({
                broadcasterId: vod.userId,
                streamStartedAt: vod.createdAt,
                clientId: process.env.TWITCH_CLIENT_ID,
                token: await getTwitchAppToken(),
                chatDensity: [], // sem chat ao vivo em VODs arquivados
                videoUrl: vod.videoUrl,
                duration: vod.durationSec,
                title: vod.title,
                topN: persona.clipsPerRun,
            });

            if (peaks.length > 0) {
                logger.success(`[Capturer] ${peaks.length} peak(s) encontrado(s) no VOD "${vod.title}"`);
                return { peaks, videoUrl: vod.videoUrl, title: vod.title, duration: vod.durationSec };
            }
        } catch (err) {
            logger.warn(`[Capturer] VOD "${vod.title}" sem peaks válidos: ${err.message}`);
        }
    }

    throw new Error(`Nenhum dos ${vods.length} VODs de "${persona.displayName}" retornou peaks.`);
}

// ─── Token Twitch (cache simples) ────────────────────────────────────────────

let _twitchToken = null;
let _twitchTokenExp = 0;

async function getTwitchAppToken() {
    if (_twitchToken && Date.now() < _twitchTokenExp) return _twitchToken;
    const axios = (await import('axios')).default;
    const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: { client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' },
    });
    _twitchToken = res.data.access_token;
    _twitchTokenExp = Date.now() + (res.data.expires_in - 60) * 1000;
    return _twitchToken;
}

// ─── Pipeline por Persona ────────────────────────────────────────────────────

/**
 * Executa captação para uma persona:
 * - YouTube: varre até YOUTUBE_SCAN_DEPTH vídeos para achar um com heatmap
 * - Twitch:  varre até TWITCH_SCAN_DEPTH VODs usando Clips API (Opção C)
 */
export async function capturePersona(persona, { force = false, minClips = 3, dynamicTarget = null } = {}) {
    if (dynamicTarget) {
        logger.step(`[Capturer] Capturando alvo dinâmico: "${dynamicTarget.title}"`);
        const personaDir = ensurePersonaDir(persona.name);

        try {
            let peaks;
            if (dynamicTarget.platform === 'twitch') {
                peaks = await getTwitchLivePeaks({
                    broadcasterId: dynamicTarget.video_id,
                    videoUrl: dynamicTarget.url,
                    duration: dynamicTarget.duration,
                    title: dynamicTarget.title,
                    topN: persona.clipsPerRun ?? 3,
                    chatDensity: [],
                    clientId: process.env.TWITCH_CLIENT_ID,
                    token: await getTwitchAppToken(),
                });
            } else {
                peaks = await getYoutubePeaks(dynamicTarget.url, persona.clipsPerRun ?? 3);
            }

            let generated = 0;
            for (let i = 0; i < peaks.length; i++) {
                try {
                    // outputBaseDir passado diretamente — evita mutação de process.env.OUTPUT_DIR
                    // que causava race condition quando múltiplas personas rodavam em paralelo
                    await processClip({ ...peaks[i], videoUrl: dynamicTarget.url, outputBaseDir: personaDir }, i + 1, peaks.length);
                    generated++;
                } catch (err) {
                    logger.error(`[Capturer] Clipe ${i + 1} falhou: ${err.message}`);
                }
            }

            logger.success(`[Capturer] Alvo dinâmico: ${generated} clipe(s) gerado(s)`);
            return { persona: persona.name, clipsGenerated: generated };
        } catch (err) {
            logger.error(`[Capturer] Falha ao capturar alvo dinâmico: ${err.message}`);
            return { persona: persona.name, clipsGenerated: 0, error: err.message };
        }
    }

    const personaDir = ensurePersonaDir(persona.name);
    const existing = countExistingClips(personaDir);

    logger.info(`[Capturer] ${persona.displayName}: ${existing} clipe(s) em ./output/${persona.name}/`);

    if (!force && existing >= minClips) {
        logger.info(`[Capturer] ${persona.displayName}: já tem ${existing} clipes — pulando.`);
        return { persona: persona.name, clipsGenerated: 0 };
    }

    try {
        logger.step(`[Capturer] Varrendo conteúdo de "${persona.displayName}" (${persona.platform.toUpperCase()})...`);

        let peaks, videoUrl, title, duration;

        if (persona.platform === 'youtube') {
            ({ peaks, videoUrl, title, duration } = await findYouTubePeaks(persona));
        } else if (persona.platform === 'twitch') {
            ({ peaks, videoUrl, title, duration } = await findTwitchPeaks(persona));
        } else {
            throw new Error(`Plataforma desconhecida: ${persona.platform}`);
        }

        // Processa os clipes
        let generated = 0;
        for (let i = 0; i < peaks.length; i++) {
            try {
                await processClip({ ...peaks[i], videoUrl, outputBaseDir: personaDir }, i + 1, peaks.length);
                generated++;
            } catch (err) {
                logger.error(`[Capturer] Clipe ${i + 1} falhou: ${err.message}`);
            }
        }

        logger.success(`[Capturer] "${persona.displayName}": ${generated} clipe(s) gerado(s) → ${personaDir}`);
        return { persona: persona.name, clipsGenerated: generated };

    } catch (err) {
        logger.error(`[Capturer] Erro ao capturar "${persona.displayName}": ${err.message}`);
        return { persona: persona.name, clipsGenerated: 0, error: err.message };
    }
}

/**
 * Captura todas as personas em paralelo (por plataforma).
 */
export async function captureAll(personas, opts = {}) {
    initBinaries();

    console.log('\n\x1b[35m' + '═'.repeat(56) + '\x1b[0m');
    console.log('\x1b[35m  🎬  CANAL CORTE — Varredura Simultânea\x1b[0m');
    console.log(`\x1b[35m  YouTube + Twitch | ${personas.length} persona(s)\x1b[0m`);
    console.log('\x1b[35m' + '═'.repeat(56) + '\x1b[0m\n');

    // Roda todas em paralelo para máxima velocidade
    const results = await Promise.allSettled(
        personas.map((p) => capturePersona(p, opts))
    );

    const settled = results.map((r, i) =>
        r.status === 'fulfilled' ? r.value : { persona: personas[i].name, clipsGenerated: 0, error: r.reason?.message }
    );

    const total = settled.reduce((s, r) => s + r.clipsGenerated, 0);
    const errors = settled.filter((r) => r.error);

    console.log('\n\x1b[32m' + '═'.repeat(56) + '\x1b[0m');
    console.log(`\x1b[32m  ✅  ${total} clipe(s) gerado(s) no total\x1b[0m`);
    if (errors.length) {
        console.log(`\x1b[31m  ⚠️   ${errors.length} erro(s): ${errors.map((e) => e.persona).join(', ')}\x1b[0m`);
    }
    console.log('\x1b[32m' + '═'.repeat(56) + '\x1b[0m\n');

    return settled;
}
