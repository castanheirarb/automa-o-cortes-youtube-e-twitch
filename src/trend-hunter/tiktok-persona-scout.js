// src/trend-hunter/tiktok-persona-scout.js
// Backfill de conteúdo pras personas TikTok (platform: 'tiktok' em
// personas.js) — que não têm VOD arquivado no próprio TikTok, então só dá
// pra capturar de verdade quando o monitor de live pega uma ao vivo (evento
// imprevisível). Enquanto isso não acontece, busca no YouTube lives
// BRUTAS/completas que outros canais já re-hospedaram (ex.: Royal Clipes,
// Lives do Jon) e corta com o NOSSO pipeline normal — cai no mesmo
// tratamento de qualquer "alvo dinâmico" (capturePersona com dynamicTarget).
//
// NUNCA busca pra reaproveitar um corte que outro canal já editou — o filtro
// de duração mínima (MIN_DURATION_SEC) existe justamente pra descartar
// clipes curtos de 60-100s que já são o trabalho editorial de terceiros
// (canais de "cortes"/"clipes") e ficar só com lives longas/brutas, que são
// matéria-prima igual a qualquer VOD do YouTube/Twitch que já usamos.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { PERSONAS } from '../capturer/personas.js';
import { capturePersona } from '../capturer/capturer.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// 10min+ é um proxy razoável pra "live bruta/recap", não corte de terceiro
// (a imensa maioria dos cortes prontos de outros canais fica entre 20s-3min).
const MIN_DURATION_SEC = parseInt(process.env.TIKTOK_BACKFILL_MIN_DURATION || '600', 10);
const MIN_VIEWS = parseInt(process.env.TIKTOK_BACKFILL_MIN_VIEWS || '1000', 10);
const RESULTS_PER_QUERY = 8;
// "tiktok" no termo de busca ajuda a desambiguar nomes que colidem com outra
// coisa famosa (ex.: "Ana McQueen" vs. "Relâmpago McQueen" da Pixar) — vídeo
// de entretenimento/podcast tende a se associar a "tiktok" no ranking de
// relevância do YouTube, filme/desenho infantil não.
const QUERY_SUFFIXES = ['tiktok live completa', 'tiktok resenha completa', 'live corte tiktok'];

// Sinais fortes de conteúdo que NÃO é entretenimento/podcast — jornalismo
// (reportagem sobre prisão/investigação, achado na prática pro "Buzeira": a
// busca trouxe uma matéria do Fantástico/G1 sobre a prisão dele) ou colisão
// de nome com outra coisa famosa (achado na prática pro "Ana McQueen": trouxe
// vídeo do Relâmpago McQueen/Pixar). Filtra por título E por canal.
const BLOCKED_KEYWORDS = [
    // jornalismo/crime — não é o tipo de conteúdo que este pipeline corta
    'g1', 'fantástico', 'fantastico', 'jornal nacional', 'jornal da',
    'polícia', 'policia', 'preso', 'prisão', 'prisao', 'operação policial',
    'investigação', 'investigacao', 'sbt news', 'globo news', 'band news', 'record news',
    // colisão de nome (McQueen/Pixar)
    'relâmpago', 'relampago', 'pixar', 'disney', 'filme carros',
];

function isBlocked(text) {
    const lower = (text || '').toLowerCase();
    return BLOCKED_KEYWORDS.some((kw) => lower.includes(kw));
}

function getPersonaOutputDir(personaName) {
    return path.resolve(process.env.OUTPUT_DIR || './output', personaName);
}

function countExistingClips(personaDir) {
    function walk(dir) {
        let count = 0;
        try {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.isDirectory()) count += walk(path.join(dir, entry.name));
                else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) count++;
            }
        } catch { /* pasta inacessível */ }
        return count;
    }
    return walk(personaDir);
}

async function searchYouTube(query) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const args = ['--dump-json', '--flat-playlist', `ytsearch${RESULTS_PER_QUERY}:${query}`];
    const { stdout } = await execFileAsync(ytDlp, args, { maxBuffer: 10 * 1024 * 1024 });
    return stdout.trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
}

async function findRawLiveCandidates(persona) {
    const seen = new Map();

    for (const suffix of QUERY_SUFFIXES) {
        try {
            const videos = await searchYouTube(`${persona.displayName} ${suffix}`);
            for (const v of videos) {
                if (!v.duration || v.duration < MIN_DURATION_SEC) continue; // provável corte de terceiro
                if ((v.view_count || 0) < MIN_VIEWS) continue;
                if (isBlocked(v.title) || isBlocked(v.uploader)) {
                    logger.warn(`[TikTokBackfill] Descartado (jornalismo/colisão de nome): "${v.title}" (${v.uploader})`);
                    continue;
                }
                if (!seen.has(v.id)) {
                    seen.set(v.id, {
                        platform: 'youtube',
                        title: v.title,
                        url: `https://www.youtube.com/watch?v=${v.id}`,
                        views: v.view_count,
                        creator: v.uploader,
                        duration: v.duration,
                    });
                }
            }
        } catch (err) {
            logger.warn(`[TikTokBackfill] Busca "${persona.displayName} ${suffix}" falhou: ${err.message}`);
        }
    }

    return [...seen.values()].sort((a, b) => b.views - a.views);
}

/**
 * Busca lives brutas/completas já re-hospedadas de personas TikTok e captura
 * com o pipeline normal — só pra personas cuja pasta de output já não tem
 * clipes suficientes (evita rebuscar/reprocessar à toa).
 *
 * @param {object} [opts]
 * @param {number} [opts.minClips=3]
 */
export async function runTikTokPersonaBackfill({ minClips = 3 } = {}) {
    const targets = PERSONAS.filter((p) => p.platform === 'tiktok' && !p.skipBackfillSearch);
    const results = [];

    for (const persona of targets) {
        const personaDir = getPersonaOutputDir(persona.name);
        const existing = countExistingClips(personaDir);

        if (existing >= minClips) {
            logger.info(`[TikTokBackfill] ${persona.displayName}: já tem ${existing} clipe(s) — pulando busca.`);
            continue;
        }

        logger.step(`[TikTokBackfill] Buscando live bruta/completa de "${persona.displayName}"...`);
        const candidates = await findRawLiveCandidates(persona);

        if (candidates.length === 0) {
            logger.warn(`[TikTokBackfill] Nenhum candidato encontrado pra "${persona.displayName}".`);
            results.push({ persona: persona.name, clipsGenerated: 0, error: 'nenhum candidato encontrado' });
            continue;
        }

        const best = candidates[0];
        logger.success(
            `[TikTokBackfill] "${persona.displayName}" → "${best.title}" ` +
            `(${best.views} views, ${Math.round(best.duration / 60)}min, ${best.creator})`
        );

        const result = await capturePersona(persona, { dynamicTarget: best });
        results.push(result);
    }

    return results;
}
