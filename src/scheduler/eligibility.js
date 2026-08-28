// src/scheduler/eligibility.js
// Painel de elegibilidade pro YouTube Partner Program (YPP) — mostra, por
// canal, a distância até os requisitos ATUAIS de monetização do YouTube:
//   1.000 inscritos  E  (4.000h de watch time nos últimos 12 meses
//                        OU 10.000.000 views em Shorts nos últimos 90 dias)
//
// Ao contrário do Revenue-Aware Rotation (revenue-weight.js), que só serve
// DEPOIS que um canal já está no YPP, este painel é útil justamente ANTES —
// mostra qual caminho (vídeo longo/watch hours vs Shorts/views) está mais
// perto de bater em cada canal, pra decidir onde focar esforço agora.
//
// CLI:
//   npm run eligibility
//
// Escopos necessários por métrica:
//   Inscritos            → já coberto pelo token atual do Comment Bot (force-ssl).
//   Watch hours / Shorts  → precisa de yt-analytics.readonly (NÃO precisa do
//                           escopo monetário) — mesma reautorização
//                           documentada em poster/youtube-oauth-setup.js.
// Sem o escopo novo, o painel ainda mostra inscritos normalmente e só marca
// watch hours/Shorts como "sem permissão" — nunca quebra o comando inteiro.

import 'dotenv/config';
import path from 'node:path';
import { google } from 'googleapis';
import { logger } from '../utils/logger.js';

const MIN_SUBSCRIBERS = parseInt(process.env.YPP_MIN_SUBSCRIBERS || '1000', 10);
const MIN_WATCH_HOURS = parseInt(process.env.YPP_MIN_WATCH_HOURS || '4000', 10);
const MIN_SHORTS_VIEWS = parseInt(process.env.YPP_MIN_SHORTS_VIEWS || '10000000', 10);

function fmtDate(d) {
    return d.toISOString().slice(0, 10);
}

function pct(value, min) {
    if (value == null) return null;
    return Math.min(100, Math.round((value / min) * 1000) / 10);
}

async function queryMetric(analytics, { startDate, endDate, metrics, dimensions, filters }) {
    const res = await analytics.reports.query({
        ids: 'channel==MINE',
        startDate: fmtDate(startDate),
        endDate: fmtDate(endDate),
        metrics,
        ...(dimensions ? { dimensions } : {}),
        ...(filters ? { filters } : {}),
    });
    const cols = (res.data.columnHeaders ?? []).map((c) => c.name);
    const row = res.data.rows?.[0];
    if (!row) return 0;
    const idx = cols.indexOf(metrics);
    return Number(row[idx]) || 0;
}

async function getSubscriberCount(youtubeClient) {
    const res = await youtubeClient.channels.list({ mine: true, part: ['statistics', 'snippet'] });
    const item = res.data.items?.[0];
    if (!item) return { count: null, title: '?' };
    const stats = item.statistics;
    return {
        // hiddenSubscriberCount=true → o dono escondeu a contagem pública; a
        // API não devolve o número real nem pra própria conta autenticada.
        count: stats?.hiddenSubscriberCount ? null : parseInt(stats.subscriberCount, 10),
        title: item.snippet?.title ?? '?',
    };
}

async function getWatchHours12mo(oauth2Client) {
    const analytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 365 * 86_400_000);
    const minutes = await queryMetric(analytics, { startDate, endDate, metrics: 'estimatedMinutesWatched' });
    return minutes / 60;
}

async function getShortsViews90d(oauth2Client) {
    const analytics = google.youtubeAnalytics({ version: 'v2', auth: oauth2Client });
    const endDate = new Date();
    const startDate = new Date(endDate.getTime() - 90 * 86_400_000);
    return queryMetric(analytics, {
        startDate, endDate, metrics: 'views',
        dimensions: 'creatorContentType',
        filters: 'creatorContentType==SHORTS',
    });
}

function fmtNum(n) {
    if (n == null) return '—';
    return Math.round(n).toLocaleString('pt-BR');
}

function fmtPct(p) {
    if (p == null) return '';
    return `(${p}%)`;
}

/**
 * Calcula o status de elegibilidade de UM canal já autenticado.
 * Cada métrica falha isoladamente (sem permissão, canal novo demais pro
 * range, etc.) — nunca derruba as outras.
 */
export async function getChannelEligibility({ key, label, oauth2Client, youtubeClient }) {
    const result = { key, label, title: null, subscribers: null, watchHours: null, shortsViews: null, errors: [] };

    try {
        const { count, title } = await getSubscriberCount(youtubeClient);
        result.subscribers = count;
        result.title = title;
    } catch (err) {
        result.errors.push(`inscritos: ${err?.response?.data?.error?.message || err.message}`);
    }

    try {
        result.watchHours = await getWatchHours12mo(oauth2Client);
    } catch (err) {
        result.errors.push(`watch hours: ${err?.response?.data?.error?.message || err.message}`);
    }

    try {
        result.shortsViews = await getShortsViews90d(oauth2Client);
    } catch (err) {
        result.errors.push(`views Shorts: ${err?.response?.data?.error?.message || err.message}`);
    }

    const subsOk = result.subscribers != null && result.subscribers >= MIN_SUBSCRIBERS;
    const watchOk = result.watchHours != null && result.watchHours >= MIN_WATCH_HOURS;
    const shortsOk = result.shortsViews != null && result.shortsViews >= MIN_SHORTS_VIEWS;
    result.eligible = subsOk && (watchOk || shortsOk);
    result.subsOk = subsOk;
    result.watchOk = watchOk;
    result.shortsOk = shortsOk;

    return result;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
    const { COMMENT_BOT_CHANNELS } = await import('../comment-bot/channels.js');
    const { getOAuth2Client, getYouTubeClient } = await import('../comment-bot/youtube-auth.js');

    console.log('\n' + '═'.repeat(78));
    console.log('  🎯  Elegibilidade YPP (YouTube Partner Program)');
    console.log(`  Requisitos: ${MIN_SUBSCRIBERS.toLocaleString('pt-BR')} inscritos + (${MIN_WATCH_HOURS.toLocaleString('pt-BR')}h em 12 meses OU ${MIN_SHORTS_VIEWS.toLocaleString('pt-BR')} views em Shorts em 90 dias)`);
    console.log('═'.repeat(78));

    for (const ch of COMMENT_BOT_CHANNELS) {
        if (!process.env[ch.refreshTokenEnv]) {
            console.log(`\n  ${ch.label}: \x1b[2mpulando — sem ${ch.refreshTokenEnv} no .env\x1b[0m`);
            continue;
        }

        let entry;
        try {
            const oauth2Client = getOAuth2Client(ch);
            const youtubeClient = getYouTubeClient(ch);
            entry = await getChannelEligibility({ key: ch.key, label: ch.label, oauth2Client, youtubeClient });
        } catch (err) {
            console.log(`\n  ${ch.label}: \x1b[31merro (${err.message})\x1b[0m`);
            continue;
        }

        console.log(`\n  ${entry.title ?? ch.label}`);
        console.log(`    Inscritos      : ${fmtNum(entry.subscribers)} / ${fmtNum(MIN_SUBSCRIBERS)} ${fmtPct(pct(entry.subscribers, MIN_SUBSCRIBERS))} ${entry.subsOk ? '✅' : ''}`);
        console.log(`    Watch hours 12m: ${fmtNum(entry.watchHours)}h / ${fmtNum(MIN_WATCH_HOURS)}h ${fmtPct(pct(entry.watchHours, MIN_WATCH_HOURS))} ${entry.watchOk ? '✅' : ''}`);
        console.log(`    Views Shorts 90d: ${fmtNum(entry.shortsViews)} / ${fmtNum(MIN_SHORTS_VIEWS)} ${fmtPct(pct(entry.shortsViews, MIN_SHORTS_VIEWS))} ${entry.shortsOk ? '✅' : ''}`);

        if (entry.eligible) {
            console.log(`    \x1b[32m✅ ELEGÍVEL${entry.watchOk ? ' (via watch hours)' : ''}${entry.shortsOk ? ' (via Shorts)' : ''}\x1b[0m`);
        } else if (!entry.subsOk) {
            console.log(`    \x1b[33m⏳ Faltam inscritos — é o gargalo, nenhum dos dois caminhos de views/watch time importa até bater 1.000.\x1b[0m`);
        } else {
            const closerPath = (entry.watchHours != null && entry.shortsViews != null)
                ? (pct(entry.watchHours, MIN_WATCH_HOURS) >= pct(entry.shortsViews, MIN_SHORTS_VIEWS) ? 'watch hours (vídeo longo)' : 'views de Shorts')
                : null;
            console.log(`    \x1b[33m⏳ Inscritos ok — falta watch time OU views de Shorts.${closerPath ? ` Caminho mais perto: ${closerPath}.` : ''}\x1b[0m`);
        }

        for (const err of entry.errors) {
            logger.warn(`    [Eligibility] ${ch.label} — ${err}`);
        }
    }

    console.log('\n' + '═'.repeat(78) + '\n');
}
