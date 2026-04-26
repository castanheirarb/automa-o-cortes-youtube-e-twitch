// src/capturer/fetcher.js
// Busca o VOD/vídeo mais recente de uma persona.
// YouTube: usa yt-dlp para listar o canal e pegar o ID do último vídeo.
// Twitch:  usa a Helix API para buscar o último VOD arquivado do streamer.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import axios from 'axios';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

function getYtDlpBin() {
    return process.env.YTDLP_PATH?.trim() || 'yt-dlp';
}

// ─── YouTube ──────────────────────────────────────────────────────────────────

/**
 * Busca um vídeo de um canal no YouTube via yt-dlp.
 * Usa --playlist-end N para buscar apenas os N primeiros itens sem baixar nada.
 *
 * @param {string} channelUrl - URL do canal + /videos (ex: https://www.youtube.com/@RenatoCariani/videos)
 * @param {number} [offset=1] - Qual vídeo buscar: 1=mais recente, 2=penúltimo, etc.
 * @returns {Promise<{ videoUrl: string, title: string, duration: number, id: string }>}
 */
export async function fetchLatestYouTubeVideo(channelUrl, offset = 1) {
    const ytDlp = getYtDlpBin();
    logger.info(`[Fetcher] Buscando vídeo #${offset} do canal: ${channelUrl}`);

    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json',
        '--no-playlist',
        '--playlist-end', String(offset),  // Busca os N primeiros
        '--skip-download',
        '--flat-playlist',
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    // yt-dlp com --flat-playlist retorna múltiplas linhas JSON (uma por vídeo)
    const lines = stdout.trim().split('\n').filter(Boolean);
    // Pega a última linha da lista (o offset-ésimo vídeo)
    const entry = JSON.parse(lines[lines.length - 1]);

    const videoUrl = entry.url?.startsWith('http')
        ? entry.url
        : `https://www.youtube.com/watch?v=${entry.id}`;

    logger.info(`[Fetcher] Encontrado (#${offset}): "${entry.title}" → ${videoUrl}`);
    return {
        videoUrl,
        title: entry.title || entry.id,
        duration: entry.duration || null,
        id: entry.id,
    };
}

// ─── Twitch ───────────────────────────────────────────────────────────────────

const TWITCH_API_BASE = 'https://api.twitch.tv/helix';

async function getTwitchToken() {
    const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET) {
        throw new Error('Defina TWITCH_CLIENT_ID e TWITCH_CLIENT_SECRET no .env');
    }
    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: { client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' },
    });
    return res.data.access_token;
}

async function getTwitchUserId(loginName, token) {
    const { TWITCH_CLIENT_ID } = process.env;
    const res = await axios.get(`${TWITCH_API_BASE}/users`, {
        headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        params: { login: loginName },
    });
    const user = res.data.data?.[0];
    if (!user) throw new Error(`Usuário Twitch não encontrado: ${loginName}`);
    return user.id;
}

/**
 * Busca o último VOD arquivado de um canal da Twitch.
 *
 * @param {string} loginName - Nome de usuário Twitch (ex: "renatocariani")
 * @returns {Promise<{ videoUrl: string, title: string, duration: number, id: string }>}
 */
export async function fetchLatestTwitchVOD(loginName) {
    logger.info(`[Fetcher] Buscando último VOD Twitch de: ${loginName}`);
    const { TWITCH_CLIENT_ID } = process.env;

    const token = await getTwitchToken();
    const userId = await getTwitchUserId(loginName, token);

    const res = await axios.get(`${TWITCH_API_BASE}/videos`, {
        headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        params: { user_id: userId, type: 'archive', first: 1 },
    });

    const vod = res.data.data?.[0];
    if (!vod) throw new Error(`Nenhum VOD encontrado para o usuário Twitch: ${loginName}`);

    // Duração no formato "2h30m15s" → converter para segundos
    const durationSec = parseTwitchDuration(vod.duration);
    const videoUrl = `https://www.twitch.tv/videos/${vod.id}`;

    logger.info(`[Fetcher] VOD encontrado: "${vod.title}" (${vod.duration}) → ${videoUrl}`);
    return { videoUrl, title: vod.title, duration: durationSec, id: vod.id };
}

/**
 * Retorna uma lista de VODs arquivados de um canal Twitch.
 * Usado pelo capturer para varrer múltiplos VODs em busca de peaks válidos.
 *
 * @param {string} loginName - Username Twitch
 * @param {number} [count=5] - Quantos VODs buscar
 * @returns {Promise<Array<{ vodId, videoUrl, title, durationSec, userId, createdAt }>>}
 */
export async function fetchTwitchVODList(loginName, count = 5) {
    logger.info(`[Fetcher] Buscando últimos ${count} VODs de: ${loginName}`);
    const { TWITCH_CLIENT_ID } = process.env;
    const token = await getTwitchToken();
    const userId = await getTwitchUserId(loginName, token);

    const res = await axios.get(`${TWITCH_API_BASE}/videos`, {
        headers: { 'Client-Id': TWITCH_CLIENT_ID, Authorization: `Bearer ${token}` },
        params: { user_id: userId, type: 'archive', first: count },
    });

    const vods = res.data.data || [];
    if (vods.length === 0) throw new Error(`Nenhum VOD arquivado para: ${loginName}`);

    logger.info(`[Fetcher] ${vods.length} VOD(s) encontrado(s) para ${loginName}`);

    return vods.map((vod) => ({
        vodId: vod.id,
        videoUrl: `https://www.twitch.tv/videos/${vod.id}`,
        title: vod.title,
        durationSec: parseTwitchDuration(vod.duration),
        userId,
        createdAt: vod.created_at,
    }));
}

/** Converte "2h30m15s" → segundos */
function parseTwitchDuration(str) {
    const match = str.match(/(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?/);
    if (!match) return 0;
    return (parseInt(match[1] || 0) * 3600) +
        (parseInt(match[2] || 0) * 60) +
        parseInt(match[3] || 0);
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * Busca o VOD mais recente de uma persona, roteando para YouTube ou Twitch.
 *
 * @param {import('./personas.js').Persona} persona
 * @returns {Promise<{ videoUrl: string, title: string, duration: number, id: string }>}
 */
export async function fetchLatestVideo(persona) {
    if (persona.platform === 'youtube') {
        const offset = persona.videoOffset ?? 1;
        return fetchLatestYouTubeVideo(persona.channelUrl, offset);
    } else if (persona.platform === 'twitch') {
        return fetchLatestTwitchVOD(persona.channelUrl);
    }
    throw new Error(`Plataforma desconhecida: ${persona.platform}`);
}
