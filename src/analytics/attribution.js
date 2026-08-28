// src/analytics/attribution.js
// Casa vídeos reais do canal (via YouTube Data API) com o histórico local de
// posts (postados/metadata-history.json, que já sabe qual persona/nicho
// gerou cada título) — necessário porque o upload via Playwright
// (poster/uploaders/youtube.js) NUNCA retorna o videoId do vídeo publicado,
// então não existe outra ponte entre "arquivo local que subimos" e "vídeo no
// YouTube" além do título (gerado por IA, específico o suficiente pra não
// colidir na prática). Vídeo sem match (ex.: renomeado manualmente no Studio
// depois de postado) fica só sem dado de receita — não quebra nada.

import { google } from 'googleapis';
import { getRecentPosts } from '../../poster/metadata-validator.js';
import { logger } from '../../poster/logger.js';

async function getUploadsPlaylistId(youtubeClient) {
    const res = await youtubeClient.channels.list({ mine: true, part: ['contentDetails'] });
    return res.data.items?.[0]?.contentDetails?.relatedPlaylists?.uploads ?? null;
}

async function listRecentUploads(youtubeClient, playlistId, maxResults) {
    const items = [];
    let pageToken;
    do {
        const res = await youtubeClient.playlistItems.list({
            playlistId,
            part: ['snippet'],
            maxResults: 50,
            pageToken,
        });
        for (const it of res.data.items ?? []) {
            const videoId = it.snippet?.resourceId?.videoId;
            if (!videoId) continue;
            items.push({ videoId, title: it.snippet.title ?? '', publishedAt: it.snippet.publishedAt });
        }
        pageToken = res.data.nextPageToken;
    } while (pageToken && items.length < maxResults);
    return items.slice(0, maxResults);
}

/**
 * Busca os uploads recentes do canal autenticado e casa por TÍTULO EXATO
 * (case-insensitive) com o histórico local de posts.
 * @param {import('googleapis').Auth.OAuth2Client} oauth2Client
 * @param {{maxResults?: number, postsLimit?: number}} [opts]
 * @returns {Promise<Array<{videoId, title, persona, niche, postedAt}>>} só os que deram match
 */
export async function attributeRecentVideos(oauth2Client, { maxResults = 150, postsLimit = 500 } = {}) {
    const youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client });

    const playlistId = await getUploadsPlaylistId(youtubeClient);
    if (!playlistId) throw new Error('Não encontrei a playlist de uploads do canal autenticado.');

    const uploads = await listRecentUploads(youtubeClient, playlistId, maxResults);
    const posts = getRecentPosts(postsLimit);

    // Título mais recente vence em caso de colisão rara (IA raramente repete
    // título verbatim — a validação de duplicata em metadata-validator.js já
    // desencoraja isso na origem).
    const byTitle = new Map();
    for (const p of posts) {
        if (!p.titulo) continue;
        byTitle.set(p.titulo.trim().toLowerCase(), p);
    }

    const attributed = [];
    let unmatched = 0;
    for (const v of uploads) {
        const post = byTitle.get(v.title.trim().toLowerCase());
        if (post) {
            attributed.push({
                videoId: v.videoId,
                title: v.title,
                persona: post.persona,
                niche: post.niche,
                // 'baseline' cobre todo post anterior a essa feature (campo
                // inexistente no histórico antigo) — é o grupo de controle
                // natural pra comparação em src/scheduler/compare-rotation.js.
                rotationMode: post.rotationMode || 'baseline',
                postedAt: post.postedAt,
            });
        } else {
            unmatched++;
        }
    }

    if (unmatched > 0) {
        logger.info(`[Analytics] ${unmatched}/${uploads.length} vídeo(s) do canal sem match no histórico local (fora da janela ou renomeados).`);
    }

    return attributed;
}
