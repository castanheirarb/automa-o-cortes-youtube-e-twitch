// src/scheduler/audience-recent.js
// Painel de audiência dos ÚLTIMOS 3 vídeos publicados de verdade em cada
// canal — views/likes/comentários via YouTube Data API v3 (videos.list),
// SEM depender da YouTube Analytics API (essa está desabilitada no projeto
// GCP atual — ver eligibility.js — e mesmo quando habilitada teria só
// watch-time agregado por canal, não por vídeo individual sem mais setup).
// Data API v3 já funciona hoje com os tokens existentes.
//
// Custo de cota: 3 chamadas "list" por canal (channels.list + playlistItems.list
// + videos.list) = 3 unidades. Com os 4 canais, ~12 unidades por rodada —
// irrisório contra a cota diária padrão de 10.000 unidades do projeto
// (compartilhada com Comment Bot, oauth-setup, eligibility, etc.).
//
// CLI:
//   npm run audience

import 'dotenv/config';
import path from 'node:path';
import { google } from 'googleapis';
import { logger } from '../utils/logger.js';
import { attributeRecentVideos } from '../analytics/attribution.js';

async function getUploadsPlaylistId(youtubeClient) {
    const res = await youtubeClient.channels.list({ mine: true, part: ['contentDetails', 'snippet'] });
    const item = res.data.items?.[0];
    return {
        playlistId: item?.contentDetails?.relatedPlaylists?.uploads ?? null,
        channelTitle: item?.snippet?.title ?? null,
    };
}

async function listLastVideoIds(youtubeClient, playlistId, maxResults) {
    const res = await youtubeClient.playlistItems.list({
        playlistId,
        part: ['snippet'],
        maxResults,
    });
    return (res.data.items ?? [])
        .map((it) => ({
            videoId: it.snippet?.resourceId?.videoId,
            title: it.snippet?.title ?? '',
            publishedAt: it.snippet?.publishedAt,
        }))
        .filter((v) => v.videoId);
}

async function getVideoStats(youtubeClient, videoIds) {
    if (videoIds.length === 0) return new Map();
    const res = await youtubeClient.videos.list({ id: videoIds, part: ['statistics'] });
    const map = new Map();
    for (const item of res.data.items ?? []) {
        map.set(item.id, {
            views: parseInt(item.statistics?.viewCount ?? '0', 10),
            likes: item.statistics?.likeCount != null ? parseInt(item.statistics.likeCount, 10) : null,
            comments: item.statistics?.commentCount != null ? parseInt(item.statistics.commentCount, 10) : null,
        });
    }
    return map;
}

/**
 * Últimos N vídeos publicados de um canal já autenticado, com estatísticas
 * públicas (views/likes/comentários) e, quando possível, a persona/nicho que
 * gerou o post (via casamento de título com postados/metadata-history.json —
 * ver src/analytics/attribution.js). Cada etapa falha isolada: erro de
 * atribuição não derruba as estatísticas, e vice-versa.
 * @param {{key: string, label: string, refreshTokenEnv: string}} channelConfig
 * @param {import('googleapis').Auth.OAuth2Client} oauth2Client
 * @param {import('googleapis').youtube_v3.Youtube} youtubeClient
 * @param {number} [count]
 */
export async function getRecentAudience(channelConfig, oauth2Client, youtubeClient, count = 3) {
    const { playlistId, channelTitle } = await getUploadsPlaylistId(youtubeClient);
    if (!playlistId) throw new Error('Não encontrei a playlist de uploads do canal autenticado.');

    const uploads = await listLastVideoIds(youtubeClient, playlistId, count);
    const statsMap = await getVideoStats(youtubeClient, uploads.map((v) => v.videoId));

    let attributionByVideoId = new Map();
    try {
        const attributed = await attributeRecentVideos(oauth2Client, { maxResults: 200 });
        attributionByVideoId = new Map(attributed.map((a) => [a.videoId, a]));
    } catch (err) {
        logger.warn(`[Audience] ${channelConfig.label} — atribuição de persona falhou (${err.message}), seguindo só com estatísticas.`);
    }

    return {
        channelTitle,
        videos: uploads.map((v) => ({
            ...v,
            ...(statsMap.get(v.videoId) ?? { views: null, likes: null, comments: null }),
            persona: attributionByVideoId.get(v.videoId)?.persona ?? null,
            niche: attributionByVideoId.get(v.videoId)?.niche ?? null,
        })),
    };
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

function fmtNum(n) {
    if (n == null) return '—';
    return n.toLocaleString('pt-BR');
}

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
    const { COMMENT_BOT_CHANNELS } = await import('../comment-bot/channels.js');
    const { getOAuth2Client, getYouTubeClient } = await import('../comment-bot/youtube-auth.js');

    console.log('\n' + '═'.repeat(78));
    console.log('  📊  Audiência — últimos 3 vídeos por canal');
    console.log('  (views/likes/comentários via YouTube Data API v3, sem Analytics API)');
    console.log('═'.repeat(78));

    for (const ch of COMMENT_BOT_CHANNELS) {
        if (!process.env[ch.refreshTokenEnv]) {
            console.log(`\n  ${ch.label}: \x1b[2mpulando — sem ${ch.refreshTokenEnv} no .env\x1b[0m`);
            continue;
        }

        try {
            const oauth2Client = getOAuth2Client(ch);
            const youtubeClient = getYouTubeClient(ch);
            const { channelTitle, videos } = await getRecentAudience(ch, oauth2Client, youtubeClient, 3);

            console.log(`\n  ${channelTitle ?? ch.label}`);
            if (videos.length === 0) {
                console.log('    \x1b[2mNenhum vídeo encontrado na playlist de uploads.\x1b[0m');
                continue;
            }
            for (const v of videos) {
                const personaTag = v.persona ? ` [${v.persona}${v.niche ? '/' + v.niche : ''}]` : '';
                console.log(`    • ${v.title}${personaTag}`);
                console.log(`      👁 ${fmtNum(v.views)} views  👍 ${fmtNum(v.likes)}  💬 ${fmtNum(v.comments)}  (${v.publishedAt?.slice(0, 10) ?? '?'})`);
            }
        } catch (err) {
            const msg = err?.response?.data?.error?.message || err.message;
            console.log(`\n  ${ch.label}: \x1b[31merro (${msg})\x1b[0m`);
        }
    }

    console.log('\n' + '═'.repeat(78) + '\n');
}
