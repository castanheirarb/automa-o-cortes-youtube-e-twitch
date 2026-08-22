// src/scheduler/hotness.js
// Ranking de "hotness" por persona: mede se o vídeo recente do canal está
// estourando em relação à baseline histórica do PRÓPRIO canal (mediana de views
// dos últimos N vídeos). Assim um canal pequeno com vídeo viral vence um canal
// grande em semana morna.
//
//   score = maxViews(3 vídeos mais recentes) / mediana(últimos N vídeos)
//
//   score ≥ HOTNESS_THRESHOLD (padrão 1.8) → persona considerada "em alta"
//   e fura a fila do round-robin no poster (HOTNESS_MODE=false desativa).
//
// CLI:
//   npm run hotness          → imprime o ranking atual
//
// Cache: scheduler/hotness-cache.json (TTL padrão 60 min — HOTNESS_CACHE_MIN).

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const CACHE_PATH = path.resolve('./scheduler/hotness-cache.json');
const SCAN_PER_CHANNEL = parseInt(process.env.HOTNESS_SCAN_PER_CHANNEL || '12', 10);
const RECENT_WINDOW = 3; // quantos vídeos recentes concorrem ao "pico"
const CACHE_TTL_MIN = parseInt(process.env.HOTNESS_CACHE_MIN || '60', 10);
export const HOTNESS_THRESHOLD = parseFloat(process.env.HOTNESS_THRESHOLD || '1.8');

// ─── Helpers ──────────────────────────────────────────────────────────────────

function median(nums) {
    if (nums.length === 0) return 0;
    const s = [...nums].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** URL de canal YouTube usada para medir a persona (Twitch usa youtubeUrl como proxy). */
function getScoutUrl(persona) {
    if (persona.platform === 'youtube') return persona.channelUrl;
    return persona.youtubeUrl || null;
}

async function scanChannel(channelUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json', '--flat-playlist',
        '--playlist-end', String(SCAN_PER_CHANNEL),
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    return stdout.trim().split('\n').filter(Boolean)
        .map((line) => JSON.parse(line))
        .filter((v) => (v.view_count ?? 0) > 0 && (v.duration ?? 0) >= 60) // ignora lives/erros
        .map((v) => ({ id: v.id, title: v.title, views: v.view_count }));
}

// ─── Cache ────────────────────────────────────────────────────────────────────

function loadCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        const ageMin = (Date.now() - new Date(raw.at).getTime()) / 60_000;
        if (ageMin < CACHE_TTL_MIN) return raw.ranking;
    } catch { /* sem cache válido */ }
    return null;
}

function saveCache(ranking) {
    try {
        fs.writeFileSync(CACHE_PATH, JSON.stringify({ at: new Date().toISOString(), ranking }, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Hotness] Falha ao salvar cache: ${err.message}`);
    }
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/**
 * Ranking de hotness das personas (maior score primeiro).
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @param {{ force?: boolean }} opts - force ignora o cache
 * @returns {Promise<Array<{name, displayName, score, topTitle, topViews, baseline}>>}
 */
export async function getHotnessRanking(personas, { force = false } = {}) {
    if (!force) {
        const cached = loadCache();
        if (cached) {
            logger.info(`[Hotness] Usando cache (<${CACHE_TTL_MIN}min).`);
            return cached;
        }
    }

    logger.info(`[Hotness] Medindo ${personas.length} personas (últimos ${SCAN_PER_CHANNEL} vídeos/canal)...`);

    const results = await Promise.allSettled(personas.map(async (p) => {
        const url = getScoutUrl(p);
        if (!url) return { name: p.name, displayName: p.displayName, score: 0, topTitle: null, topViews: 0, baseline: 0, note: 'sem canal YouTube' };

        const videos = await scanChannel(url);
        if (videos.length < 4) return { name: p.name, displayName: p.displayName, score: 0, topTitle: null, topViews: 0, baseline: 0, note: 'poucos vídeos' };

        const baseline = median(videos.map((v) => v.views));
        const recent = videos.slice(0, RECENT_WINDOW);
        const top = recent.reduce((a, b) => (b.views > a.views ? b : a));
        const score = baseline > 0 ? top.views / baseline : 0;

        return {
            name: p.name,
            displayName: p.displayName,
            score: Math.round(score * 100) / 100,
            topTitle: top.title,
            topViews: top.views,
            baseline: Math.round(baseline),
        };
    }));

    const ranking = results
        .map((r, i) => r.status === 'fulfilled'
            ? r.value
            : { name: personas[i].name, displayName: personas[i].displayName, score: 0, topTitle: null, topViews: 0, baseline: 0, note: `erro: ${r.reason?.message}` })
        .sort((a, b) => b.score - a.score);

    saveCache(ranking);
    return ranking;
}

/**
 * Retorna a persona mais quente ACIMA do threshold, ou null se ninguém estiver
 * em alta (aí o round-robin normal decide).
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @param {(p) => boolean} isEligible - filtro extra (ex.: tem vídeos na pasta)
 */
export async function pickHotPersona(personas, isEligible = () => true) {
    const ranking = await getHotnessRanking(personas);
    const byName = Object.fromEntries(personas.map((p) => [p.name, p]));

    for (const entry of ranking) {
        if (entry.score < HOTNESS_THRESHOLD) break; // ranking ordenado — ninguém mais passa
        const persona = byName[entry.name];
        if (persona && isEligible(persona)) {
            return { persona, entry };
        }
    }
    return null;
}

// ─── CLI ──────────────────────────────────────────────────────────────────────

const isMain = process.argv[1] && import.meta.url.endsWith(path.basename(process.argv[1]));

if (isMain) {
    const { PERSONAS } = await import('../capturer/personas.js');
    const force = process.argv.includes('--force');
    const ranking = await getHotnessRanking(PERSONAS, { force });

    const fmt = (n) => n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1_000 ? `${(n / 1_000).toFixed(0)}k` : String(n);

    console.log('\n' + '─'.repeat(100));
    console.log(`  ${'Persona'.padEnd(24)}${'Score'.padEnd(8)}${'Pico recente'.padEnd(14)}${'Baseline'.padEnd(10)}Vídeo em alta`);
    console.log('─'.repeat(100));
    for (const e of ranking) {
        const hot = e.score >= HOTNESS_THRESHOLD ? '\x1b[31m🔥' : '  ';
        const title = e.topTitle ? e.topTitle.slice(0, 40) : (e.note ?? '—');
        console.log(`${hot} ${e.displayName.padEnd(24)}${String(e.score).padEnd(8)}${fmt(e.topViews).padEnd(14)}${fmt(e.baseline).padEnd(10)}${title}\x1b[0m`);
    }
    console.log('─'.repeat(100));
    console.log(`  🔥 = em alta (score ≥ ${HOTNESS_THRESHOLD}) — fura a fila do round-robin no poster.\n`);
}
