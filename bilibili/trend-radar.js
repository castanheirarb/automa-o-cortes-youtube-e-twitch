// bilibili/trend-radar.js
// Consulta o ranking OFICIAL e público da Bilibili (sem autenticação) para
// saber o que está bombando agora — usado como SINAL pra priorizar qual fonte
// da lista curada (sources.js) vale mais a pena clipar, NUNCA como fonte de
// vídeo em si: repostar o que já está no topo da própria Bilibili é o cenário
// de detecção de duplicata mais fácil que existe (mesmo público, mesma
// plataforma, zero transformação editorial).
//
// Endpoint: https://api.bilibili.com/x/web-interface/ranking/v2?rid={rid}&type=all
// `rid` = partição. 0 = geral (todas). Pra outras partições (jogos, anime...),
// abra https://www.bilibili.com/v/popular/rank/all no navegador, troque de aba
// e leia o rid na URL — não hardcodei uma tabela rid→categoria aqui porque a
// própria API já devolve o nome da partição em `tname` por vídeo (mais
// confiável do que eu adivinhar o número certo).
//
// Uso standalone: node bilibili/trend-radar.js

import 'dotenv/config';
import axios from 'axios';
import { logger } from './logger.js';

function getRids() {
    const raw = process.env.BILIBILI_RADAR_RIDS?.trim();
    const parsed = (raw || '0')
        .split(',')
        .map((s) => parseInt(s.trim(), 10))
        .filter((n) => !Number.isNaN(n));
    return parsed.length > 0 ? parsed : [0];
}

/**
 * Busca o ranking (top vídeos) de uma partição da Bilibili.
 * @param {number} rid
 * @returns {Promise<Array<{ title: string, tag: string, play: number, bvid: string, author: string }>>}
 */
export async function fetchRanking(rid) {
    const { data } = await axios.get('https://api.bilibili.com/x/web-interface/ranking/v2', {
        params: { rid, type: 'all' },
        headers: { 'User-Agent': 'Mozilla/5.0', Referer: 'https://www.bilibili.com/' },
        timeout: 15000,
    });

    if (data.code !== 0) {
        throw new Error(`Bilibili ranking API retornou code ${data.code}: ${data.message}`);
    }

    return (data.data?.list || []).map((v) => ({
        title: v.title,
        tag: v.tname,
        play: v.stat?.view ?? 0,
        bvid: v.bvid,
        author: v.owner?.name,
    }));
}

/**
 * Consulta todas as partições configuradas (BILIBILI_RADAR_RIDS) e retorna o
 * ranking de cada uma — usado pra decidir qual fonte/tema priorizar no
 * próximo ciclo de captura (bilibili/run.js).
 * @returns {Promise<Record<number, Array>>}
 */
export async function scanTrendSignal() {
    const rids = getRids();
    const results = {};

    for (const rid of rids) {
        try {
            const list = await fetchRanking(rid);
            results[rid] = list;
            if (list[0]) {
                logger.info(`[TrendRadar] rid=${rid} (${list[0].tag}): top "${list[0].title}" — ${list[0].play.toLocaleString('pt-BR')} views`);
            }
        } catch (err) {
            logger.warn(`[TrendRadar] Falha ao consultar rid=${rid}: ${err.message}`);
            results[rid] = [];
        }
    }

    return results;
}

// ─── Self-test: node bilibili/trend-radar.js ─────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('trend-radar.js')) {
    const results = await scanTrendSignal();
    for (const [rid, list] of Object.entries(results)) {
        console.log(`\n=== rid=${rid} — top 5 ===`);
        list.slice(0, 5).forEach((v, i) =>
            console.log(`${i + 1}. [${v.tag}] ${v.title} — ${v.play.toLocaleString('pt-BR')} views (${v.author})`)
        );
    }
}
