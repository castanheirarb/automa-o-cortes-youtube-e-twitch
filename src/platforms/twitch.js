// src/platforms/twitch.js
// Consulta a API da Twitch para obter o clipe mais assistido de um VOD.

import axios from 'axios';
import { logger } from '../utils/logger.js';

const TWITCH_TOKEN_URL = 'https://id.twitch.tv/oauth2/token';
const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

/**
 * Obtém um App Access Token da Twitch usando Client Credentials Flow.
 * @returns {Promise<string>} access_token
 */
async function getTwitchAccessToken() {
    const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;

    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        throw new Error(
            'Credenciais da Twitch não configuradas. ' +
            'Defina TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET no .env'
        );
    }

    const response = await axios.post(TWITCH_TOKEN_URL, null, {
        params: {
            client_id: TWITCH_CLIENT_ID,
            client_secret: TWITCH_CLIENT_SECRET,
            grant_type: 'client_credentials',
        },
    });

    return response.data.access_token;
}

/**
 * Busca os clipes de um VOD da Twitch, ordenados por views (mais assistido primeiro).
 *
 * @param {string} vodId - ID do VOD (ex: "123456789")
 * @param {string} accessToken
 * @returns {Promise<Array>} lista de clipes
 */
async function fetchClipsForVod(vodId, accessToken) {
    const { TWITCH_CLIENT_ID } = process.env;

    logger.info(`Buscando clipes do VOD ${vodId} via Twitch API...`);

    // A Helix API filtra clipes por video_id
    const response = await axios.get(`${TWITCH_API_BASE}/clips`, {
        headers: {
            'Client-Id': TWITCH_CLIENT_ID,
            Authorization: `Bearer ${accessToken}`,
        },
        params: {
            video_id: vodId,
            first: 20, // Busca os 20 primeiros para garantir o mais visto
        },
    });

    const clips = response.data.data;

    if (!clips || clips.length === 0) {
        throw new Error(
            `Nenhum clipe encontrado para o VOD ${vodId}. ` +
            'O VOD pode ser muito recente, privado ou não ter clipes criados pela comunidade.'
        );
    }

    return clips;
}

/**
 * Converte o offset em segundos do clipe dentro do VOD.
 * O campo `vod_offset` da API já entrega isso diretamente (quando disponível).
 *
 * @param {object} clip - objeto de clipe da Twitch API
 * @returns {number} offset em segundos (tempo no VOD onde o clipe começa)
 */
function extractVodOffset(clip) {
    if (typeof clip.vod_offset === 'number') {
        return clip.vod_offset;
    }
    // Fallback: tenta extrair do thumbnail_url que contém o offset no nome do arquivo
    // Ex: .../offset-1234-preview.jpg
    const match = clip.thumbnail_url?.match(/offset-(\d+)/);
    if (match) {
        return parseInt(match[1], 10);
    }
    throw new Error(
        `Não foi possível determinar o offset no VOD para o clipe "${clip.id}". ` +
        'O campo vod_offset não está disponível e o thumbnail_url não contém offset.'
    );
}

/**
 * Função principal do módulo Twitch.
 * Retorna os dados do clipe mais assistido para um dado VOD.
 *
 * @param {string} vodId - ID do VOD da Twitch
 * @returns {Promise<{
 *   peakTime: number,
 *   title: string,
 *   duration: number,
 *   clipUrl: string,
 *   clipId: string,
 *   viewCount: number
 * }>}
 */
export async function getTwitchPeak(vodId) {
    try {
        const accessToken = await getTwitchAccessToken();
        const clips = await fetchClipsForVod(vodId, accessToken);

        // Os clipes já vêm ordenados por view_count pela API quando se usa video_id
        // Garantimos ordenação explícita
        clips.sort((a, b) => b.view_count - a.view_count);
        const topClip = clips[0];

        const peakTime = extractVodOffset(topClip);

        logger.success(
            `Clipe mais assistido: "${topClip.title}" ` +
            `(${topClip.view_count} views) — offset no VOD: ${peakTime}s`
        );

        return {
            peakTime,
            title: topClip.title,
            duration: topClip.duration,  // duração do clipe em segundos
            clipUrl: topClip.url,
            clipId: topClip.id,
            viewCount: topClip.view_count,
        };
    } catch (err) {
        throw new Error(`[Twitch] Falha ao obter pico: ${err.message}`);
    }
}
