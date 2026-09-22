// bilibili/stats.js
// Painel de audiência — mesmo padrão dos outros painéis do projeto (npm run
// eligibility, npm run revenue): consulta a API pública da Bilibili (mesma
// família da API de ranking já usada em trend-radar.js, sem autenticação) e
// mostra inscritos da conta + estatísticas de cada vídeo publicado.
//
// Uso: npm run bilibili:stats

import 'dotenv/config';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const REGISTRY_FILE = path.resolve('./bilibili/state/registry.json');
const COOKIES_PATH = path.resolve(process.env.BILIBILI_COOKIES_PATH || './bilibili/profiles/bilibili-cookies.json');

/**
 * x/web-interface/view exige sessão autenticada pra não cair no 412 anti-bot
 * (diferente da API de ranking, que é aberta) — reaproveita o mesmo
 * cookies.json já usado pelo uploader (bilibili/login.js), só pra leitura.
 */
function buildAuthHeaders() {
    const headers = { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' };
    try {
        const data = JSON.parse(fs.readFileSync(COOKIES_PATH, 'utf-8'));
        const cookies = data.cookie_info?.cookies || [];
        if (cookies.length > 0) {
            headers.Cookie = cookies.map((c) => `${c.name}=${c.value}`).join('; ');
        }
    } catch { /* sem cookies salvos ainda — segue sem, só a API de ranking funciona sem sessão */ }
    return headers;
}

const API_HEADERS = buildAuthHeaders();

/**
 * @param {string} uid
 * @returns {Promise<{ follower: number, following: number }>}
 */
export async function fetchAccountStats(uid) {
    const { data } = await axios.get('https://api.bilibili.com/x/relation/stat', {
        params: { vmid: uid },
        headers: API_HEADERS,
        timeout: 15000,
    });
    if (data.code !== 0) throw new Error(`code ${data.code}: ${data.message}`);
    return { follower: data.data.follower, following: data.data.following };
}

/**
 * @param {string} bvid
 * @returns {Promise<{ bvid: string, title: string, view: number, like: number, coin: number, favorite: number, share: number, reply: number, danmaku: number }>}
 */
export async function fetchVideoStats(bvid) {
    const { data } = await axios.get('https://api.bilibili.com/x/web-interface/view', {
        params: { bvid },
        headers: API_HEADERS,
        timeout: 15000,
    });
    if (data.code !== 0) throw new Error(`code ${data.code}: ${data.message}`);
    const { stat, title } = data.data;
    return { bvid, title, ...stat };
}

function getPublishedVideos({ limit } = {}) {
    let registry;
    try {
        registry = JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    } catch {
        return [];
    }
    const published = Object.values(registry)
        .filter((entry) => entry.published && entry.bvid)
        .sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)); // mais recente primeiro

    return limit ? published.slice(0, limit) : published;
}

/**
 * @param {object} [opts]
 * @param {number} [opts.limit] - só os N vídeos mais recentes (padrão: todos)
 */
export async function printStatsReport({ limit } = {}) {
    const uid = process.env.BILIBILI_ACCOUNT_UID?.trim();

    console.log(`\n=== Bilibili — Painel de Audiência${limit ? ` (${limit} mais recentes)` : ''} ===\n`);

    if (uid) {
        try {
            const acc = await fetchAccountStats(uid);
            console.log(`Inscritos: ${acc.follower.toLocaleString('pt-BR')}  |  Seguindo: ${acc.following.toLocaleString('pt-BR')}\n`);
        } catch (err) {
            logger.warn(`Falha ao buscar dados da conta: ${err.message}`);
        }
    } else {
        logger.warn('BILIBILI_ACCOUNT_UID não configurado no .env — pulando inscritos da conta.\n');
    }

    const published = getPublishedVideos({ limit });
    if (published.length === 0) {
        console.log('Nenhum vídeo publicado com bvid registrado ainda.');
        return;
    }

    console.log(`${published.length} vídeo(s) publicado(s):\n`);
    for (const entry of published) {
        try {
            const s = await fetchVideoStats(entry.bvid);
            console.log(`- ${entry.title || s.title}`);
            console.log(`  https://www.bilibili.com/video/${entry.bvid}`);
            console.log(
                `  views: ${s.view.toLocaleString('pt-BR')} | likes: ${s.like.toLocaleString('pt-BR')} | ` +
                `moedas: ${s.coin.toLocaleString('pt-BR')} | favoritos: ${s.favorite.toLocaleString('pt-BR')} | ` +
                `compart.: ${s.share.toLocaleString('pt-BR')} | comentários: ${s.reply.toLocaleString('pt-BR')} | ` +
                `danmaku: ${s.danmaku.toLocaleString('pt-BR')}\n`
            );
        } catch (err) {
            logger.warn(`Falha ao buscar stats de ${entry.bvid}: ${err.message}`);
        }
    }
}

// ─── Self-test: node bilibili/stats.js ───────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('stats.js')) {
    printStatsReport()
        .then(() => { process.exitCode = 0; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
