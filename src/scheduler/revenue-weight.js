// src/scheduler/revenue-weight.js
// Agrega receita por PERSONA (via src/analytics/*) e converte em multiplicador
// de peso pro round-robin do poster — personas com receita/vídeo acima da
// mediana ganham turnos extras, abaixo perdem. Sinal complementar ao Hotness
// (hotness.js mede audiência/pico, não dinheiro).
//
// CLI:
//   npm run revenue          → imprime a tabela agregada por persona
//   npm run revenue -- --force  → ignora o cache e busca de novo
//
// Cache: scheduler/revenue-cache.json (TTL padrão 24h — REVENUE_CACHE_HOURS).
// Ativado por REVENUE_AWARE_ROTATION=true no .env (default false) — desligado,
// getRevenueAdjustedPersonas() é um passthrough sem custo nenhum. Requer os
// canais autorizados com escopo yt-analytics(.-monetary).readonly (ver
// poster/youtube-oauth-setup.js); sem isso, ou sem monetização ativa (YPP) no
// canal, cai silenciosamente pra pesos declarados (1x) em vez de quebrar o
// rodízio — ver revenueMultiplier().

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const CACHE_PATH = path.resolve('./scheduler/revenue-cache.json');
const CACHE_TTL_HOURS = parseFloat(process.env.REVENUE_CACHE_HOURS || '24');
const LOOKBACK_DAYS = parseInt(process.env.REVENUE_LOOKBACK_DAYS || '60', 10);
// Amostra mínima de vídeos atribuídos pra confiar no número — evita que 1
// vídeo sortudo/azarado dispare um multiplicador extremo.
const MIN_SAMPLE = parseInt(process.env.REVENUE_MIN_SAMPLE || '3', 10);
const MAX_MULTIPLIER = parseFloat(process.env.REVENUE_MAX_MULTIPLIER || '2');
const MIN_MULTIPLIER = parseFloat(process.env.REVENUE_MIN_MULTIPLIER || '0.5');

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
        logger.warn(`[Revenue] Falha ao salvar cache: ${err.message}`);
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
 * Recalcula a receita agregada por persona a partir de 1+ canais autenticados.
 * @param {Array<{key: string, client: import('googleapis').Auth.OAuth2Client}>} channelClients
 * @param {{force?: boolean}} [opts]
 * @returns {Promise<Record<string, {sample, revenuePerVideo, viewsPerVideo, totalRevenue}>>}
 */
export async function computeRevenueByPersona(channelClients, { force = false } = {}) {
    if (!force) {
        const cached = loadCache();
        if (cached) {
            logger.info(`[Revenue] Usando cache (<${CACHE_TTL_HOURS}h).`);
            return cached.byPersona;
        }
    }

    const { attributeRecentVideos } = await import('../analytics/attribution.js');
    const { fetchVideoMetrics } = await import('../analytics/youtube-analytics.js');

    const perPersonaVideos = new Map(); // persona/nicho -> [{videoId, metrics, ...}]

    for (const { key, client } of channelClients) {
        try {
            const attributed = await attributeRecentVideos(client);
            if (attributed.length === 0) continue;

            const metrics = await fetchVideoMetrics(client, attributed.map((v) => v.videoId), { days: LOOKBACK_DAYS });
            for (const v of attributed) {
                v.metrics = metrics.get(v.videoId) ?? null;
                const pKey = v.persona || (v.niche ? `niche:${v.niche}` : null);
                if (!pKey) continue; // post antigo sem persona registrada (histórico anterior a esta feature)
                if (!perPersonaVideos.has(pKey)) perPersonaVideos.set(pKey, []);
                perPersonaVideos.get(pKey).push(v);
            }
        } catch (err) {
            logger.warn(`[Revenue] Canal "${key}" falhou (${err.message}) — seguindo sem esse canal.`);
        }
    }

    const byPersona = {};
    for (const [persona, videos] of perPersonaVideos) {
        const withRevenue = videos.filter((v) => v.metrics);
        const totalRevenue = withRevenue.reduce((s, v) => s + v.metrics.estimatedRevenue, 0);
        const totalViews = withRevenue.reduce((s, v) => s + v.metrics.views, 0);
        byPersona[persona] = {
            sample: withRevenue.length,
            revenuePerVideo: withRevenue.length > 0 ? totalRevenue / withRevenue.length : 0,
            viewsPerVideo: withRevenue.length > 0 ? totalViews / withRevenue.length : 0,
            totalRevenue,
        };
    }

    saveCache(byPersona);
    return byPersona;
}

/**
 * Converte receita/vídeo de UMA persona em multiplicador relativo à mediana
 * das personas com amostra suficiente. Neutro (1x) sempre que o dado não é
 * confiável: amostra pequena, sem receita (canal ainda não monetizado) ou
 * menos de 2 personas comparáveis.
 * @param {Record<string, {sample, revenuePerVideo}>} byPersona
 * @param {string} personaName
 * @returns {number}
 */
export function revenueMultiplier(byPersona, personaName) {
    const entry = byPersona[personaName];
    const comparable = Object.values(byPersona).filter((e) => e.sample >= MIN_SAMPLE && e.revenuePerVideo > 0);

    if (!entry || entry.sample < MIN_SAMPLE || entry.revenuePerVideo <= 0 || comparable.length < 2) {
        return 1;
    }

    const baseline = median(comparable.map((e) => e.revenuePerVideo));
    if (baseline <= 0) return 1;

    const ratio = entry.revenuePerVideo / baseline;
    return Math.min(MAX_MULTIPLIER, Math.max(MIN_MULTIPLIER, ratio));
}

// ─── Integração com o round-robin ─────────────────────────────────────────────

/**
 * Retorna as personas com `weight` ajustado pela receita real, ou a lista
 * ORIGINAL sem nenhuma cópia/custo quando a feature está desligada
 * (REVENUE_AWARE_ROTATION!=='true') ou qualquer etapa falha — nunca lança,
 * o rodízio normal sempre continua funcionando com os pesos declarados em
 * personas.js.
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @param {{force?: boolean}} [opts]
 */
export async function getRevenueAdjustedPersonas(personas, { force = false } = {}) {
    if (process.env.REVENUE_AWARE_ROTATION !== 'true') return personas;

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

        const byPersona = await computeRevenueByPersona(channelClients, { force });

        return personas.map((p) => {
            const mult = revenueMultiplier(byPersona, p.name);
            if (mult === 1) return p;
            const baseWeight = p.weight ?? 1;
            const adjusted = Math.max(1, Math.round(baseWeight * mult));
            if (adjusted !== baseWeight) {
                logger.info(`[Revenue] "${p.displayName}": peso ${baseWeight} → ${adjusted} (${mult.toFixed(2)}x da mediana)`);
            }
            return adjusted === baseWeight ? p : { ...p, weight: adjusted };
        });
    } catch (err) {
        logger.warn(`[Revenue] Ajuste de receita falhou (${err.message}) — usando pesos declarados normalmente.`);
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

    const byPersona = await computeRevenueByPersona(channelClients, { force });
    const entries = Object.entries(byPersona);

    console.log('\n' + '─'.repeat(92));
    console.log(`  ${'Persona/Nicho'.padEnd(26)}${'Amostra'.padEnd(10)}${'R$/vídeo'.padEnd(14)}${'Views/vídeo'.padEnd(14)}Peso sugerido`);
    console.log('─'.repeat(92));
    if (entries.length === 0) {
        console.log('  Nenhum vídeo atribuído ainda — sem match entre uploads recentes e o histórico local.');
    }
    for (const [persona, e] of entries) {
        const mult = revenueMultiplier(byPersona, persona);
        console.log(`  ${persona.padEnd(26)}${String(e.sample).padEnd(10)}${e.revenuePerVideo.toFixed(2).padEnd(14)}${Math.round(e.viewsPerVideo).toString().padEnd(14)}${mult.toFixed(2)}x`);
    }
    console.log('─'.repeat(92));
    console.log(`  Amostra mínima pra confiar no número: ${MIN_SAMPLE} vídeo(s) atribuído(s) — abaixo disso o peso fica neutro (1x).`);
    console.log(`  REVENUE_AWARE_ROTATION=${process.env.REVENUE_AWARE_ROTATION === 'true' ? 'true (ativo no poster)' : 'false (só leitura — poster usa pesos declarados)'}\n`);
}
