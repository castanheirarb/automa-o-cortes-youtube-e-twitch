// bilibili/scout.js
// Escaneia os canais do YouTube em bilibili/sources.js (CURATED_CHANNELS) e
// escolhe o vídeo mais visto ainda não tentado — mesmo padrão do GTA VI
// Hunter (src/trend-hunter/gta6-capture.js scanChannel/scoutTrendingGta6),
// reimplementado aqui pra manter o projeto isolado (não importa nada de
// src/trend-hunter).

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { getChannels, getExperimentalBrChannels, getRobloxChannels } from './sources.js';
import { isAlreadyAttempted } from './registry.js';
import { hasChatReplay, findChatPeak } from './chat-peaks.js';
import { logger } from './logger.js';

// Quantos candidatos (em ordem de views) checar por chat disponível antes de
// desistir e cair pro topo por views puro — checagem via --list-subs é leve,
// mas ainda é 1 chamada de rede por candidato, então não vale checar os 30.
const CHAT_CHECK_LIMIT = parseInt(process.env.BILIBILI_CHAT_CHECK_LIMIT || '15', 10);

// Mesmo teto de capture.js (BILIBILI_FALLBACK_MAX_DURATION_SEC) — um
// candidato SEM chat e mais longo que isso vai ser rejeitado lá na frente de
// qualquer forma (capture.js só corta em torno de pico OU processa inteiro
// até esse teto), então não vale escolher esse candidato aqui pra descobrir
// isso só depois de já ter baixado o vídeo inteiro.
const FALLBACK_MAX_DURATION_SEC = parseInt(process.env.BILIBILI_FALLBACK_MAX_DURATION_SEC || '400', 10);

// Quantos candidatos COM chat disponível (já filtrados pela checagem leve
// hasChatReplay) baixar o replay completo e medir a força real do pico —
// pedido do usuário (08/09/2026): priorizar pico mais forte (proxy de
// danmaku, ver peso do algoritmo do Bilibili — danmaku pesa 0.4, view só
// 0.25) em vez de só o primeiro candidato com chat na ordem de views.
// findChatPeak baixa o JSON inteiro do replay (bem mais caro que
// hasChatReplay), então limitado a poucos candidatos, não todo CHAT_CHECK_LIMIT.
const CHAT_PEAK_COMPARE_LIMIT = parseInt(process.env.BILIBILI_CHAT_PEAK_COMPARE_LIMIT || '5', 10);

const execFileAsync = promisify(execFile);

/**
 * Entre os candidatos (já ordenados por views), acha os que têm replay de
 * chat disponível (checagem leve) e, dentre esses, mede a força real do pico
 * (findChatPeak) pra escolher o de reação MAIS FORTE — não só o primeiro que
 * tiver chat. Retorna null se nenhum candidato tiver um pico válido (chat
 * disponível mas sem densidade suficiente, ou sem chat nenhum).
 * @param {Array} candidates
 * @param {string} label - prefixo do log (ex.: "[Roblox]")
 */
async function selectStrongestChatCandidate(candidates, label = '') {
    const prefix = label ? `${label} ` : '';
    logger.info(`[Bilibili/Scout] ${prefix}Checando replay de chat nos top ${Math.min(CHAT_CHECK_LIMIT, candidates.length)} candidato(s) por views...`);

    const withChat = [];
    for (const candidate of candidates.slice(0, CHAT_CHECK_LIMIT)) {
        const hasChat = await hasChatReplay(candidate.url).catch(() => false);
        if (hasChat) {
            withChat.push(candidate);
            if (withChat.length >= CHAT_PEAK_COMPARE_LIMIT) break;
        }
    }

    if (withChat.length === 0) return null;

    logger.info(`[Bilibili/Scout] ${prefix}Medindo força do pico em ${withChat.length} candidato(s) com chat disponível...`);
    let best = null;
    for (const candidate of withChat) {
        const peak = await findChatPeak(candidate.url).catch(() => null);
        if (peak && (!best || peak.density > best.peak.density)) {
            best = { candidate, peak };
        }
    }

    if (!best) return null;
    logger.success(
        `[Bilibili/Scout] ${prefix}Escolhido (pico mais forte: ${best.peak.density} msg/janela): ` +
        `"${best.candidate.title}" (${best.candidate.views.toLocaleString('pt-BR')} views, ${best.candidate.channel})`
    );
    return best.candidate;
}

async function scanChannel(channelUrl, perChannel) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json', '--flat-playlist',
        '--playlist-end', String(perChannel),
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const v = JSON.parse(line);
        return {
            url: v.url?.startsWith('http') ? v.url : `https://www.youtube.com/watch?v=${v.id}`,
            title: v.title,
            views: v.view_count ?? 0,
            duration: v.duration ?? 0,
            channel: channelUrl,
        };
    });
}

async function scanChannels(channels, perChannel) {
    const all = [];
    for (const channel of channels) {
        try {
            all.push(...await scanChannel(channel, perChannel));
        } catch (err) {
            logger.warn(`[Bilibili/Scout] Falha ao vasculhar ${channel}: ${err.message}`);
        }
    }
    all.sort((a, b) => b.views - a.views);
    return all;
}

/**
 * Vasculha todos os canais curados (conteúdo chinês) e retorna os vídeos
 * recentes ordenados por views (mais visto primeiro).
 * @param {number} [perChannel=10]
 */
export async function scoutChannels(perChannel = 10) {
    const channels = getChannels();
    logger.info(`[Bilibili/Scout] Vasculhando ${channels.length} canal(is)...`);
    return scanChannels(channels, perChannel);
}

/**
 * Escolhe um vídeo do pool experimental BR (ver EXPERIMENTAL_BR_CHANNELS em
 * sources.js, hoje apontando pra aba /shorts) — sem priorizar chat (é só um
 * teste ocasional, não vale o custo extra de checar --list-subs pra isso).
 * Chamado com frequência controlada por BILIBILI_BR_EXPERIMENT_RATE em
 * run.js, não a cada ciclo.
 *
 * Duração: yt-dlp --flat-playlist não retorna duração pra Shorts (vem 0) —
 * diferente de pickChannelVideo (canais normais, duração sempre confiável),
 * aqui duration===0 é tratado como "provavelmente curto, deixa passar" em vez
 * de filtrado fora, já que é exatamente o tipo de conteúdo que queremos desse
 * pool.
 * @param {object} [opts]
 * @param {number} [opts.minDuration=3]
 * @param {number} [opts.maxDuration=120]
 */
export async function pickExperimentalBrVideo({ minDuration = 3, maxDuration = 120 } = {}) {
    const channels = getExperimentalBrChannels();
    if (channels.length === 0) return null;

    logger.info(`[Bilibili/Scout] [BR-experimento] Vasculhando ${channels.length} canal(is) BR...`);
    const candidates = (await scanChannels(channels, 10)).filter((v) =>
        !isAlreadyAttempted(v.url) &&
        (v.duration === 0 || (v.duration >= minDuration && v.duration <= maxDuration))
    );

    if (candidates.length === 0) {
        logger.warn('[Bilibili/Scout] [BR-experimento] Nenhum vídeo novo elegível.');
        return null;
    }

    const top = candidates[0];
    logger.success(`[Bilibili/Scout] [BR-experimento] Escolhido: "${top.title}" (${top.views.toLocaleString('pt-BR')} views, ${top.channel})`);
    return top;
}

/**
 * Retorna o próximo vídeo elegível entre todos os canais curados, ou null se
 * nada novo for encontrado. Prioriza fontes com replay de chat disponível
 * (permite corte por pico de verdade, ver chat-peaks.js) sobre views puro —
 * checa os top CHAT_CHECK_LIMIT candidatos por views nessa ordem e pega o
 * primeiro com chat; se nenhum tiver, cai pro topo por views mesmo (melhor
 * publicar algo do que travar a fila esperando chat que não existe).
 * @param {object} [opts]
 * @param {number} [opts.minDuration=60]  ignora Shorts/trailers curtos demais pra cortar
 * @param {number} [opts.maxDuration=3600]
 */
export async function pickChannelVideo({ minDuration = 60, maxDuration = 3600 } = {}) {
    const candidates = (await scoutChannels()).filter((v) =>
        !isAlreadyAttempted(v.url) &&
        v.duration >= minDuration &&
        v.duration <= maxDuration
    );

    if (candidates.length === 0) {
        logger.warn('[Bilibili/Scout] Nenhum vídeo novo elegível nos canais curados.');
        return null;
    }

    const chosen = await selectStrongestChatCandidate(candidates);
    if (chosen) return chosen;

    logger.warn('[Bilibili/Scout] Nenhum dos candidatos checados tem pico de chat válido — caindo pro topo por views (sem corte por pico).');
    const top = candidates[0];
    logger.success(`[Bilibili/Scout] Escolhido (SEM chat): "${top.title}" (${top.views.toLocaleString('pt-BR')} views, ${top.channel})`);
    return top;
}

/**
 * Pool PRIORITÁRIO de Roblox (ver ROBLOX_CHANNELS em sources.js, pedido
 * explícito do usuário 05/09/2026) — checado ANTES do pool chinês normal em
 * run.js. Mistura fonte com stream real (KreekCraft, chat disponível) e fonte
 * só de shorts editados (Flamingo, sem chat): trata duration===0 (Shorts, sem
 * duração no flat-playlist) como elegível igual ao pool BR, e ainda assim
 * tenta achar chat nos candidatos de duração normal antes de cair pro topo
 * por views.
 * @param {object} [opts]
 * @param {number} [opts.minDuration=30]
 * @param {number} [opts.maxDuration=21600]
 */
export async function pickRobloxVideo({ minDuration = 30, maxDuration = 6 * 3600 } = {}) {
    const channels = getRobloxChannels();
    if (channels.length === 0) return null;

    logger.info(`[Bilibili/Scout] [Roblox] Vasculhando ${channels.length} canal(is)...`);
    const candidates = (await scanChannels(channels, 10)).filter((v) =>
        !isAlreadyAttempted(v.url) &&
        (v.duration === 0 || (v.duration >= minDuration && v.duration <= maxDuration))
    );

    if (candidates.length === 0) {
        logger.warn('[Bilibili/Scout] [Roblox] Nenhum vídeo novo elegível.');
        return null;
    }

    const chosen = await selectStrongestChatCandidate(candidates, '[Roblox]');
    if (chosen) return chosen;

    // Nenhum candidato com pico de chat válido — entre os SEM chat, só vale escolher um que
    // vá sobreviver ao teto de "vídeo inteiro" de capture.js (Shorts,
    // duration===0, sempre passam; VODs longos sem chat seriam rejeitados
    // depois de já ter baixado tudo).
    const survivable = candidates.filter((v) => v.duration === 0 || v.duration <= FALLBACK_MAX_DURATION_SEC);
    if (survivable.length === 0) {
        logger.warn(`[Bilibili/Scout] [Roblox] Só sobraram candidatos sem chat E longos demais pro teto de vídeo inteiro (${FALLBACK_MAX_DURATION_SEC}s) — nenhum elegível.`);
        return null;
    }

    const top = survivable[0];
    logger.success(`[Bilibili/Scout] [Roblox] Escolhido (SEM chat): "${top.title}" (${top.views.toLocaleString('pt-BR')} views, ${top.channel})`);
    return top;
}

// ─── Self-test: node bilibili/scout.js ───────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('scout.js')) {
    scoutChannels()
        .then((list) => {
            console.log(`\n=== ${list.length} vídeo(s) encontrados — top 10 por views ===`);
            list.slice(0, 10).forEach((v, i) =>
                console.log(`${i + 1}. ${v.title} — ${v.views.toLocaleString('pt-BR')} views (${v.duration}s)`)
            );
            process.exitCode = 0;
        })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
