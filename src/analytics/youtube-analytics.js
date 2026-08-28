// src/analytics/youtube-analytics.js
// Wrapper sobre a YouTube Analytics API v2 — métricas de receita/visualização
// por vídeo. Usado por src/scheduler/revenue-weight.js pra enviesar o
// rodízio a favor de quem realmente monetiza, não só quem viraliza.
//
// Requer os escopos yt-analytics.readonly + yt-analytics-monetary.readonly no
// refresh token do canal (ver poster/youtube-oauth-setup.js) — tokens gerados
// ANTES dessa mudança só têm o escopo de comentário; refaça o setup daquele
// canal se a consulta monetária falhar por escopo insuficiente.

import { google } from 'googleapis';
import { logger } from '../../poster/logger.js';

// Limite prático de IDs por filtro `video==id1,id2,...` numa única chamada —
// a API não documenta um teto oficial, mas URLs muito longas podem estourar
// limites de query string; 200 é um lote seguro.
const MAX_VIDEOS_PER_QUERY = 200;

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

function rowsToMap(res) {
    const cols = (res.data.columnHeaders ?? []).map((c) => c.name);
    const map = new Map();
    for (const row of res.data.rows ?? []) {
        const entry = Object.fromEntries(cols.map((name, idx) => [name, row[idx]]));
        map.set(entry.video, entry);
    }
    return map;
}

/**
 * Busca métricas de receita/visualização por vídeo para uma lista de IDs, num
 * canal só (a API sempre resolve `channel==MINE` a partir do token usado).
 * Sem monetização ativa (YPP) no canal, os campos de receita vêm zerados —
 * não é erro. Sem PERMISSÃO pro escopo monetário (token antigo), cai
 * automaticamente pra métricas não-monetárias em vez de derrubar o ciclo.
 *
 * @param {import('googleapis').Auth.OAuth2Client} oauth2Client
 * @param {string[]} videoIds
 * @param {{days?: number}} [opts]
 * @returns {Promise<Map<string, {views, estimatedMinutesWatched, estimatedRevenue, estimatedAdRevenue, cpm}>>}
 */
export async function fetchVideoMetrics(oauth2Client, videoIds, { days = 60 } = {}) {
    if (videoIds.length === 0) return new Map();

    const analytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - days * 86_400_000);

    const results = new Map();

    for (let i = 0; i < videoIds.length; i += MAX_VIDEOS_PER_QUERY) {
        const batch = videoIds.slice(i, i + MAX_VIDEOS_PER_QUERY);
        const baseQuery = {
            ids: 'channel==MINE',
            startDate: fmtDate(startDate),
            endDate: fmtDate(endDate),
            dimensions: 'video',
            filters: `video==${batch.join(',')}`,
            maxResults: batch.length,
        };

        let rows;
        try {
            const res = await analytics.reports.query({
                ...baseQuery,
                metrics: 'views,estimatedMinutesWatched,subscribersGained,estimatedRevenue,estimatedAdRevenue,cpm',
            });
            rows = rowsToMap(res);
        } catch (err) {
            const msg = err?.response?.data?.error?.message || err.message;
            logger.warn(`[Analytics] Consulta com métricas monetárias falhou (${msg}) — tentando sem receita (token sem o escopo novo?).`);
            const res = await analytics.reports.query({
                ...baseQuery,
                metrics: 'views,estimatedMinutesWatched,subscribersGained',
            });
            rows = rowsToMap(res);
        }

        for (const [videoId, entry] of rows) {
            results.set(videoId, {
                views: Number(entry.views) || 0,
                estimatedMinutesWatched: Number(entry.estimatedMinutesWatched) || 0,
                subscribersGained: Number(entry.subscribersGained) || 0,
                estimatedRevenue: Number(entry.estimatedRevenue) || 0,
                estimatedAdRevenue: Number(entry.estimatedAdRevenue) || 0,
                cpm: Number(entry.cpm) || 0,
            });
        }
    }

    return results;
}
