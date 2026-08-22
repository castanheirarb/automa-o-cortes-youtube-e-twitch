// src/comment-bot/youtube-auth.js
// Cliente OAuth da YouTube Data API v3, um por canal. Client ID/Secret são
// compartilhados (mesmo projeto GCP); o refresh token é específico de cada
// canal (conta Google distinta por trás de cada um). Gerados via
// `node poster/youtube-oauth-setup.js --channel <key>`.

import { google } from 'googleapis';
import { logger } from '../../poster/logger.js';

/**
 * Erro específico pra token revogado/expirado — o monitor usa isso pra
 * desativar só o canal afetado (e não derrubar os outros 2) até o operador
 * rodar o setup de novo.
 */
export class YouTubeAuthError extends Error {
    constructor(channelKey, cause) {
        super(
            `Refresh token inválido/revogado para o canal "${channelKey}". ` +
            `Rode: node poster/youtube-oauth-setup.js --channel ${channelKey}`
        );
        this.name = 'YouTubeAuthError';
        this.channelKey = channelKey;
        this.cause = cause;
    }
}

/**
 * Monta o cliente autenticado da YouTube Data API pra um canal.
 * @param {{key: string, refreshTokenEnv: string}} channelConfig
 * @returns {import('googleapis').youtube_v3.Youtube}
 */
export function getYouTubeClient(channelConfig) {
    const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
    const refreshToken = process.env[channelConfig.refreshTokenEnv]?.trim();

    if (!clientId || !clientSecret) {
        throw new Error(
            'YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET não configurados no .env. ' +
            'Veja a seção "YouTube Data API v3" no .env.example.'
        );
    }
    if (!refreshToken) {
        throw new YouTubeAuthError(channelConfig.key, new Error(`${channelConfig.refreshTokenEnv} ausente`));
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret);
    oauth2Client.setCredentials({ refresh_token: refreshToken });

    // Google raramente reemite um novo refresh_token (revogação/rotação) — se
    // acontecer, o token antigo no .env vira letra morta silenciosamente sem
    // este aviso.
    oauth2Client.on('tokens', (tokens) => {
        if (tokens.refresh_token) {
            logger.warn(
                `[Comment-Bot] Google emitiu um NOVO refresh_token para "${channelConfig.key}" — ` +
                `atualize ${channelConfig.refreshTokenEnv} no .env com o valor novo, o antigo pode parar de funcionar.`
            );
        }
    });

    return google.youtube({ version: 'v3', auth: oauth2Client });
}

const channelIdCache = new Map(); // key: channelConfig.key -> channelId (cache em memória do processo)

/**
 * Resolve o channelId da conta autenticada (custa 1 unidade de cota,
 * cacheado em memória pelo tempo de vida do processo).
 * @param {import('googleapis').youtube_v3.Youtube} youtubeClient
 * @param {string} cacheKey
 */
export async function resolveChannelId(youtubeClient, cacheKey) {
    if (channelIdCache.has(cacheKey)) return channelIdCache.get(cacheKey);

    try {
        const res = await youtubeClient.channels.list({ mine: true, part: ['id', 'snippet'] });
        const channel = res.data.items?.[0];
        if (!channel) throw new Error('Nenhum canal encontrado para esta conta autenticada.');
        channelIdCache.set(cacheKey, { id: channel.id, title: channel.snippet?.title ?? '?' });
        return channelIdCache.get(cacheKey);
    } catch (err) {
        const googleError = err?.response?.data?.error;
        const isAuthError = googleError === 'invalid_grant'
            || googleError?.errors?.[0]?.reason === 'authError'
            || err?.code === 401;
        if (isAuthError) throw new YouTubeAuthError(cacheKey, err);
        throw err;
    }
}
