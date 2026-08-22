// src/capturer/capturer.js
// Orquestrador de captação por persona.
// Varre múltiplos vídeos/VODs por canal até encontrar um com picos válidos.
// YouTube: heatmap via yt-dlp (testa vários vídeos até achar um com dados)
// Twitch:  Clips API → Chat Density → Uniforme (Opção C sobre cada VOD)

import path from 'node:path';
import fs from 'node:fs';
import { fetchLatestYouTubeVideo, fetchYouTubeVideoList, fetchTwitchVODList } from './fetcher.js';
import { getYoutubePeaks } from '../platforms/youtube.js';
import { getTwitchLivePeaks } from '../platforms/twitch-peaks.js';
import { processClip, initBinaries, SubscriberOnlyError } from '../processor/ffmpeg.js';
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

// ─── YouTube: sempre o vídeo mais recente (nunca recua atrás de heatmap) ─────
// Antes escaneava até YOUTUBE_SCAN_DEPTH vídeos (8) atrás de um com "Most
// Replayed", o que podia acabar postando conteúdo de dias atrás. Agora só
// olha pra uma janela pequena (pra ainda respeitar titleKeywords — ex.:
// prioriza vídeos com Dilera/Balestrin do Cariani), pega o candidato mais
// relevante dela, e se não tiver heatmap usa picos uniformes NO PRÓPRIO
// vídeo — nunca troca de vídeo só pra achar heatmap.

async function findYouTubePeaks(persona) {
    const WINDOW = parseInt(process.env.YOUTUBE_SCAN_DEPTH || '3', 10);
    const offset = persona.videoOffset ?? 1;

    let candidates;
    try {
        const list = await fetchYouTubeVideoList(persona.channelUrl, offset + WINDOW - 1);
        candidates = list.slice(offset - 1);
        const keywords = (persona.titleKeywords || []).map((k) => k.toLowerCase());
        if (keywords.length > 0) {
            const matches = candidates.filter((v) => keywords.some((k) => v.title.toLowerCase().includes(k)));
            if (matches.length > 0) {
                logger.info(`[Capturer] ${matches.length} vídeo(s) com keywords [${keywords.join(', ')}] priorizados para ${persona.displayName}.`);
                candidates = matches;
            }
        }
    } catch (err) {
        logger.warn(`[Capturer] Falha ao listar canal (${err.message}) — fallback para busca direta.`);
        candidates = null;
    }

    let videoUrl, title, duration;
    if (candidates?.length) {
        ({ videoUrl, title, duration } = candidates[0]);
    } else {
        ({ videoUrl, title, duration } = await fetchLatestYouTubeVideo(persona.channelUrl, offset));
    }
    logger.info(`[Capturer] YouTube: vídeo mais recente de ${persona.displayName}: "${title}"`);

    try {
        const peaks = await getYoutubePeaks(videoUrl, persona.clipsPerRun);
        if (peaks.length > 0) {
            logger.success(`[Capturer] Heatmap encontrado: "${title}"`);
            return { peaks, videoUrl, title, duration };
        }
    } catch (err) {
        const isHeatmapErr = err.message.includes('heatmap') || err.message.includes('Most Replayed');
        if (!isHeatmapErr) logger.warn(`[Capturer] Falha ao buscar heatmap: ${err.message}`);
    }

    // Sem heatmap → picos uniformemente espaçados no PRÓPRIO vídeo mais
    // recente, ignorando os 10% iniciais/finais (abertura/encerramento).
    // Opt-out por persona com uniformPeaksFallback: false, senão é o padrão.
    if (persona.uniformPeaksFallback !== false && duration > 0) {
        const n = persona.clipsPerRun ?? 3;
        const start = duration * 0.1;
        const span = duration * 0.8;
        const peaks = Array.from({ length: n }, (_, i) => ({
            peakTime: start + ((i + 0.5) / n) * span,
            peakValue: 0,
            title,
            duration,
            videoUrl,
        }));
        logger.warn(`[Capturer] Sem heatmap em "${title}" — fallback: ${n} pico(s) uniformes.`);
        return { peaks, videoUrl, title, duration };
    }

    throw new Error(`Vídeo mais recente de "${persona.displayName}" ("${title}") não tem heatmap disponível.`);
}

// ─── Twitch: sempre o VOD mais recente (nunca recua atrás de peaks) ─────────
// Antes varria até TWITCH_SCAN_DEPTH VODs (5) atrás de um com peaks via
// Clips API. Agora só olha o VOD mais recente — se ele não tiver peaks,
// usa picos uniformes NELE MESMO em vez de tentar um VOD mais antigo.

async function findTwitchPeaks(persona) {
    let vods;
    try {
        vods = await fetchTwitchVODList(persona.channelUrl, 1);
    } catch (err) {
        throw new Error(`Não foi possível buscar VODs de "${persona.displayName}": ${err.message}`);
    }

    if (!vods || vods.length === 0) {
        throw new Error(`Nenhum VOD arquivado encontrado para "${persona.displayName}".`);
    }

    const vod = vods[0];
    logger.info(`[Capturer] Twitch: VOD mais recente de ${persona.displayName}: "${vod.title}" (${vod.durationSec}s)`);

    try {
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

    // Sem peaks → picos uniformemente espaçados no PRÓPRIO VOD mais recente.
    // Opt-out por persona com uniformPeaksFallback: false, senão é o padrão.
    if (persona.uniformPeaksFallback !== false && vod.durationSec > 0) {
        const n = persona.clipsPerRun ?? 3;
        const start = vod.durationSec * 0.1;
        const span = vod.durationSec * 0.8;
        const peaks = Array.from({ length: n }, (_, i) => ({
            peakTime: start + ((i + 0.5) / n) * span,
            peakValue: 0,
            title: vod.title,
            duration: vod.durationSec,
            videoUrl: vod.videoUrl,
        }));
        logger.warn(`[Capturer] Sem peaks no VOD "${vod.title}" — fallback: ${n} pico(s) uniformes.`);
        return { peaks, videoUrl: vod.videoUrl, title: vod.title, duration: vod.durationSec };
    }

    throw new Error(`VOD mais recente de "${persona.displayName}" ("${vod.title}") não retornou peaks.`);
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
                    await processClip({ ...peaks[i], videoUrl: dynamicTarget.url, outputBaseDir: personaDir, skipCaptions: persona.skipCaptions === true, layout: persona.layout ?? null, niche: persona.niche ?? 'default' }, i + 1, peaks.length);
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
            try {
                ({ peaks, videoUrl, title, duration } = await findTwitchPeaks(persona));
            } catch (err) {
                // Sem VODs arquivados, ou nenhum deles com peaks válidos — cai para o
                // YouTube se a persona tiver um canal configurado (mesmo fallback
                // omnichannel usado abaixo para VODs subscriber-only).
                if (!persona.youtubeUrl) throw err;
                logger.step(
                    `[Capturer] Fallback omnichannel ativado: "${persona.displayName}" ` +
                    `Twitch (${err.message}) → YouTube`
                );
                const ytPersona = { ...persona, platform: 'youtube', channelUrl: persona.youtubeUrl };
                ({ peaks, videoUrl, title, duration } = await findYouTubePeaks(ytPersona));
            }
        } else {
            throw new Error(`Plataforma desconhecida: ${persona.platform}`);
        }

        // Processa os clipes
        let generated = 0;
        let subscriberOnlyBlocked = false;

        for (let i = 0; i < peaks.length; i++) {
            try {
                await processClip({ ...peaks[i], videoUrl, outputBaseDir: personaDir, skipCaptions: persona.skipCaptions === true, layout: persona.layout ?? null, niche: persona.niche ?? 'default' }, i + 1, peaks.length);
                generated++;
            } catch (err) {
                if (err instanceof SubscriberOnlyError) {
                    subscriberOnlyBlocked = true;
                    logger.warn(`[Capturer] VOD subscriber-only — abortando clipes restantes do VOD.`);
                    break; // todos os clipes do mesmo VOD vão falhar igual
                }
                logger.error(`[Capturer] Clipe ${i + 1} falhou: ${err.message}`);
            }
        }

        // ── Fallback Omnichannel: Twitch subscriber-only → YouTube ────────────
        if (subscriberOnlyBlocked && generated === 0 && persona.platform === 'twitch' && persona.youtubeUrl) {
            logger.step(
                `[Capturer] Fallback omnichannel ativado: "${persona.displayName}" ` +
                `Twitch (subscriber-only) → YouTube`
            );
            const ytPersona = { ...persona, platform: 'youtube', channelUrl: persona.youtubeUrl };
            ({ peaks, videoUrl, title, duration } = await findYouTubePeaks(ytPersona));

            for (let i = 0; i < peaks.length; i++) {
                try {
                    await processClip({ ...peaks[i], videoUrl, outputBaseDir: personaDir, skipCaptions: persona.skipCaptions === true, layout: persona.layout ?? null, niche: persona.niche ?? 'default' }, i + 1, peaks.length);
                    generated++;
                } catch (err) {
                    logger.error(`[Capturer] Clipe YouTube-fallback ${i + 1} falhou: ${err.message}`);
                }
            }

            if (generated > 0) {
                logger.success(`[Capturer] Fallback YouTube: ${generated} clipe(s) gerado(s).`);
            } else {
                logger.warn(`[Capturer] Fallback YouTube também não gerou clipes.`);
            }
        } else if (subscriberOnlyBlocked && generated === 0 && !persona.youtubeUrl) {
            logger.warn(
                `[Capturer] "${persona.displayName}" é subscriber-only e não tem youtubeUrl configurado. ` +
                `Adicione o campo youtubeUrl em personas.js para habilitar o fallback.`
            );
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
