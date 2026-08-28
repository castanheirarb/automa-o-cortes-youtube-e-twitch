// src/scheduler/subscriber-weight.js
// Agrega INSCRITOS GANHOS por PERSONA (via src/analytics/*) e converte em
// multiplicador de peso pro round-robin — mesma mecânica do
// revenue-weight.js, mas medindo `subscribersGained` (métrica NÃO-monetária)
// em vez de receita. Ao contrário da receita, isso funciona hoje mesmo, sem
// esperar aprovação no YPP — só precisa do escopo yt-analytics.readonly.
//
// EXPERIMENTAL/TESTE (2026-08-23): ativado sob demanda do usuário
// especificamente pra testar se enviesar o rodízio por conversão de inscrito
// funciona melhor que o rodízio declarado (baseline). Cada post grava o modo
// ativo no momento (ver poster/index.js getActiveRotationMode() e
// poster/metadata-validator.js) — use `npm run compare-rotation` pra comparar
// o resultado real por período, não só confiar no multiplicador cego.
//
// CLI:
//   npm run subscribers          → imprime a tabela agregada por persona
//   npm run subscribers -- --force
//
// Cache: scheduler/subscriber-cache.json (TTL padrão 24h — mesmas variáveis
// de cache do revenue-weight.js não se aplicam aqui, tem as suas próprias
// abaixo pra poder testar independentemente).

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const CACHE_PATH = path.resolve('./scheduler/subscriber-cache.json');
const CACHE_TTL_HOURS = parseFloat(process.env.SUBSCRIBER_CACHE_HOURS || '24');
const LOOKBACK_DAYS = parseInt(process.env.SUBSCRIBER_LOOKBACK_DAYS || '60', 10);
const MIN_SAMPLE = parseInt(process.env.SUBSCRIBER_MIN_SAMPLE || '3', 10);
const MAX_MULTIPLIER = parseFloat(process.env.SUBSCRIBER_MAX_MULTIPLIER || '2');
const MIN_MULTIPLIER = parseFloat(process.env.SUBSCRIBER_MIN_MULTIPLIER || '0.5');

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        const ageH = (Date.now() - new Date(raw.at).getTime()) / 3_600_000;
        if (ageH < CACHE_TTL_HOURS) return raw;
    } catch { /* sem cache válido */ }
    return null;
}

function saveCache(byPersona) {
    try {
        fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
        fs.writeFileSync(CACHE_PATH, JSON.stringify({ at: new Date().toISOString(), byPersona }, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Subscribers] Falha ao salvar cache: ${err.message}`);
    }
}

function median(nums) {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// ─── Coleta + agregação ───────────────────────────────────────────────────────

/**
 * Recalcula inscritos ganhos agregados por persona a partir de 1+ canais autenticados.
 * @param {Array<{key: string, client: import('googleapis').Auth.OAuth2Client}>} channelClients
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<Record<string, {sample, subscribersPerVideo, viewsPerVideo, totalSubscribers}>>}
 */
export async function computeSubscribersByPersona(channelClients, { force = false } = {}) {
    if (!force) {
        const cached = loadCache();
        if (cached) {
            logger.info(`[Subscribers] Usando cache (<${CACHE_TTL_HOURS}h).`);
            return cached.byPersona;
        }
    }

    const { attributeRecentVideos } = await import('../analytics/attribution.js');
    const { fetchVideoMetrics } = await import('../analytics/youtube-analytics.js');

    const perPersonaVideos = new Map();

    for (const { key, client } of channelClients) {
        try {
            const attributed = await attributeRecentVideos(client);
            if (attributed.length === 0) continue;

            const metrics = await fetchVideoMetrics(client, attributed.map((v) => v.videoId), { days: LOOKBACK_DAYS });
            for (const v of attributed) {
                v.metrics = metrics.get(v.videoId) ?? null;
                const pKey = v.persona || (v.niche ? `niche:${v.niche}` : null);
                if (!pKey) continue;
                if (!perPersonaVideos.has(pKey)) perPersonaVideos.set(pKey, []);
                perPersonaVideos.get(pKey).push(v);
            }
        } catch (err) {
            logger.warn(`[Subscribers] Canal "${key}" falhou (${err.message}) — seguindo sem esse canal.`);
        }
    }

    const byPersona = {};
    for (const [persona, videos] of perPersonaVideos) {
        const withMetrics = videos.filter((v) => v.metrics);
        const totalSubscribers = withMetrics.reduce((s, v) => s + v.metrics.subscribersGained, 0);
        const totalViews = withMetrics.reduce((s, v) => s + v.metrics.views, 0);
        byPersona[persona] = {
            sample: withMetrics.length,
            subscribersPerVideo: withMetrics.length > 0 ? totalSubscribers / withMetrics.length : 0,
            viewsPerVideo: withMetrics.length > 0 ? totalViews / withMetrics.length : 0,
            totalSubscribers,
        };
    }

    saveCache(byPersona);
    return byPersona;
}

/**
 * Converte inscritos-ganhos/vídeo de UMA persona em multiplicador relativo à
 * mediana das personas com amostra suficiente. Neutro (1x) quando o dado não
 * é confiável — mesma lógica de revenue-weight.js.
 * @param {Record<string, {sample, subscribersPerVideo}>} byPersona
 * @param {string} personaName
 */
export function subscriberMultiplier(byPersona, personaName) {
    const entry = byPersona[personaName];
    const comparable = Object.values(byPersona).filter((e) => e.sample >= MIN_SAMPLE && e.subscribersPerVideo > 0);

    if (!entry || entry.sample < MIN_SAMPLE || entry.subscribersPerVideo <= 0 || comparable.length < 2) {
        return 1;
    }

    const baseline = median(comparable.map((e) => e.subscribersPerVideo));
    if (baseline <= 0) return 1;

    const ratio = entry.subscribersPerVideo / baseline;
    return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, ratio));
}

// ─── Integração com o round-robin ─────────────────────────────────────────────

/**
 * Retorna as personas com `weight` ajustado por conversão de inscrito, ou a
 * lista ORIGINAL sem custo nenhum quando a flag está desligada ou qualquer
 * etapa falha — nunca lança, o rodízio normal sempre continua funcionando.
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @param {{force?: boolean}} [opts]
 */
export async function getSubscriberAdjustedPersonas(personas, { force = false } = {}) {
    if (process.env.SUBSCRIBER_AWARE_ROTATION !== 'true') return personas;

    try {
        const { COMMENT_BOT_CHANNELS } = await import('../comment-bot/channels.js');
        const { getOAuth2Client } = await import('../comment-bot/youtube-auth.js');

        const channelClients = [];
        for (const ch of COMMENT_BOT_CHANNELS) {
            if (!process.env[ch.refreshTokenEnv]) continue;
            try {
                channelClients.push({ key: ch.key, client: getOAuth2Client(ch) });
            } catch { /* canal sem token válido — pula */ }
        }
        if (channelClients.length === 0) return personas;

        const byPersona = await computeSubscribersByPersona(channelClients, { force });

        return personas.map((p) => {
            const mult = subscriberMultiplier(byPersona, p.name);
            if (mult === 1) return p;
            const baseWeight = p.weight ?? 1;
            const adjusted = Math.max(1, Math.round(baseWeight * mult));
            if (adjusted !== baseWeight) {
                logger.info(`[Subscribers] "${p.displayName}": peso ${baseWeight} → ${adjusted} (${mult.toFixed(2)}x da mediana de inscritos/vídeo)`);
            }
            return adjusted === baseWeight ? p : { ...p, weight: adjusted };
        });
    } catch (err) {
        logger.warn(`[Subscribers] Ajuste por inscritos falhou (${err.message}) — usando pesos declarados normalmente.`);
        return personas;
    }
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
    const { COMMENT_BOT_CHANNELS } = await import('../comment-bot/channels.js');
    const { getOAuth2Client } = await import('../comment-bot/youtube-auth.js');
    const force = process.argv.includes('--force');

    const channelClients = [];
    for (const ch of COMMENT_BOT_CHANNELS) {
        if (!process.env[ch.refreshTokenEnv]) {
            console.log(`  \x1b[2m(pulando "${ch.label}" — sem ${ch.refreshTokenEnv} no .env)\x1b[0m`);
            continue;
        }
        try {
            channelClients.push({ key: ch.key, client: getOAuth2Client(ch) });
        } catch (err) {
            console.log(`  \x1b[2m(pulando "${ch.label}" — ${err.message})\x1b[0m`);
        }
    }

    if (channelClients.length === 0) {
        console.error('\n❌ Nenhum canal com refresh token válido no .env. Rode o oauth-setup primeiro.\n');
        process.exit(1);
    }

    const byPersona = await computeSubscribersByPersona(channelClients, { force });
    const entries = Object.entries(byPersona);

    console.log('\n' + '─'.repeat(92));
    console.log(`  ${'Persona/Nicho'.padEnd(26)}${'Amostra'.padEnd(10)}${'Inscritos/vídeo'.padEnd(18)}${'Views/vídeo'.padEnd(14)}Peso sugerido`);
    console.log('─'.repeat(92));
    if (entries.length === 0) {
        console.log('  Nenhum vídeo atribuído ainda — sem match entre uploads recentes e o histórico local.');
    }
    for (const [persona, e] of entries) {
        const mult = subscriberMultiplier(byPersona, persona);
        console.log(`  ${persona.padEnd(26)}${String(e.sample).padEnd(10)}${e.subscribersPerVideo.toFixed(2).padEnd(18)}${Math.round(e.viewsPerVideo).toString().padEnd(14)}${mult.toFixed(2)}x`);
    }
    console.log('─'.repeat(92));
    console.log(`  Amostra mínima pra confiar no número: ${MIN_SAMPLE} vídeo(s) atribuído(s) — abaixo disso o peso fica neutro (1x).`);
    console.log(`  SUBSCRIBER_AWARE_ROTATION=${process.env.SUBSCRIBER_AWARE_ROTATION === 'true' ? 'true (ativo no poster)' : 'false (só leitura — poster usa pesos declarados)'}\n`);
}
