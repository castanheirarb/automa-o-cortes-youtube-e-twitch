// src/platforms/twitch-peaks.js
// Implementa a Opção C de detecção de melhores momentos de uma live Twitch:
//   1. Community Clips (Helix API) → vod_offset como peakTime
//   2. Fallback: Chat Density      → janelas com mais mensagens IRC
//   3. Fallback: Distribuição uniforme

import axios from 'axios';
import { logger } from '../utils/logger.js';

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

// ─── Estratégia 1: Community Clips ───────────────────────────────────────────

/**
 * Busca clips criados pela comunidade durante a stream atual (pelo broadcast_id).
 *
 * @param {string} broadcasterId - ID do canal Twitch
 * @param {string} streamStartedAt - ISO string do início da stream
 * @param {string} clientId
 * @param {string} token
 * @param {number} topN
 * @returns {Promise<Array<{ peakTime, peakValue, title, duration, videoUrl }> | null>}
 */
async function getPeaksFromCommunityClips(broadcasterId, streamStartedAt, clientId, token, topN, videoUrl, vodDuration, vodTitle) {
    try {
        logger.info('[TwitchPeaks] Buscando clips da comunidade...');

        const response = await axios.get(`${TWITCH_API_BASE}/clips`, {
            headers: { 'Client-Id': clientId, Authorization: `Bearer ${token}` },
            params: {
                broadcaster_id: broadcasterId,
                started_at: streamStartedAt,
                first: 20,
            },
        });

        const clips = response.data.data || [];

        if (clips.length === 0) {
            logger.warn('[TwitchPeaks] Nenhum clip da comunidade disponível ainda.');
            return null;
        }

        // Ordena por view_count (mais assistido primeiro) e pega top N
        clips.sort((a, b) => b.view_count - a.view_count);
        const selected = clips.slice(0, topN);

        logger.success(`[TwitchPeaks] ${selected.length} clip(s) da comunidade encontrado(s).`);

        return selected.map((clip, i) => {
            // vod_offset: segundos desde o início do VOD onde o clip começa
            const vodOffset = clip.vod_offset ?? extractOffsetFromThumbnail(clip.thumbnail_url);
            const peakTime = vodOffset ?? ((vodDuration / (topN + 1)) * (i + 1));

            logger.info(`  Clip #${i + 1}: "${clip.title}" — ${clip.view_count} views — offset: ${peakTime}s`);

            return {
                peakTime,
                peakValue: clip.view_count,
                title: vodTitle,
                duration: vodDuration,
                videoUrl,
            };
        });

    } catch (err) {
        logger.warn(`[TwitchPeaks] Clips API falhou: ${err.message}`);
        return null;
    }
}

function extractOffsetFromThumbnail(url = '') {
    const match = url.match(/offset-(\d+)/);
    return match ? parseInt(match[1], 10) : null;
}

// ─── Estratégia 2: Chat Density ───────────────────────────────────────────────

/**
 * Converte os dados de densidade do chat em peaks compatíveis com processClip().
 *
 * @param {Array<{ peakTime, density }>} chatDensity - Output de monitorChatDensity()
 * @param {number} topN
 * @param {string} videoUrl
 * @param {number} duration
 * @param {string} title
 */
function getPeaksFromChatDensity(chatDensity, topN, videoUrl, duration, title) {
    if (!chatDensity || chatDensity.length === 0) return null;

    logger.info(`[TwitchPeaks] Usando Chat Density (${chatDensity.length} janelas disponíveis).`);

    const maxDensity = chatDensity[0].density; // já ordenado por densidade

    return chatDensity.slice(0, topN).map((p) => ({
        peakTime: p.peakTime,
        peakValue: p.density / maxDensity, // normalizado 0-1
        title,
        duration,
        videoUrl,
    }));
}

// ─── Estratégia 3: Uniforme ───────────────────────────────────────────────────

function getPeaksUniform(topN, videoUrl, duration, title) {
    logger.warn('[TwitchPeaks] Fallback: distribuição uniforme de clipes.');
    const step = duration / (topN + 1);
    return Array.from({ length: topN }, (_, i) => ({
        peakTime: Math.floor(step * (i + 1)),
        peakValue: 1 / (topN - i), // decrescente → favorece clipes do início
        title,
        duration,
        videoUrl,
    }));
}

// ─── Dispatcher (Opção C) ─────────────────────────────────────────────────────

/**
 * Retorna os N melhores peaks de uma live Twitch usando a estratégia Opção C:
 *   1. Community Clips → 2. Chat Density → 3. Uniforme
 *
 * @param {object} params
 * @param {string} params.broadcasterId  - ID numérico do canal Twitch
 * @param {string} params.streamStartedAt  - ISO string  do início da stream
 * @param {string} params.clientId
 * @param {string} params.token           - App access token
 * @param {Array}  params.chatDensity     - Output de monitorChatDensity() (pode ser [])
 * @param {string} params.videoUrl        - Path local do arquivo gravado (mp4)
 * @param {number} params.duration        - Duração gravada em segundos
 * @param {string} params.title           - Título da stream
 * @param {number} params.topN            - Quantos peaks retornar
 */
export async function getTwitchLivePeaks({
    broadcasterId,
    streamStartedAt,
    clientId,
    token,
    chatDensity = [],
    videoUrl,
    duration,
    title,
    topN = 5,
}) {
    // Estratégia 1: Community Clips
    const fromClips = await getPeaksFromCommunityClips(
        broadcasterId, streamStartedAt, clientId, token, topN, videoUrl, duration, title
    );
    if (fromClips && fromClips.length > 0) return fromClips;

    // Estratégia 2: Chat Density
    const fromChat = getPeaksFromChatDensity(chatDensity, topN, videoUrl, duration, title);
    if (fromChat && fromChat.length > 0) return fromChat;

    // Estratégia 3: Fallback uniforme
    return getPeaksUniform(topN, videoUrl, duration, title);
}
