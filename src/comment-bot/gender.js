// src/comment-bot/gender.js
// Inferência de gênero pelo primeiro nome de exibição de quem comentou —
// usada só pra deixar a resposta gerada soar mais natural (flexão de
// "querido/querida", "obrigado/obrigada" etc.), NUNCA mencionada ao usuário.
//
// Fonte primária: API pública do Censo do IBGE (de graça, sem chave) —
// compara a frequência do nome registrada como feminino vs masculino.
// https://servicodados.ibge.gov.br/api/v2/censos/nomes/{nome}?sexo=f|m
//
// Quando o IBGE não reconhece o nome (comum em nomes estrangeiros, apelidos e
// "gamer tags" de comentaristas do YouTube), quem chama este módulo deve
// tratar `unknown` como "sem inferência" e deixar a IA (que já está gerando a
// resposta de qualquer forma) arriscar um palpite — ver poster/comment-reply.js.
//
// Regra de ouro, deliberada: na dúvida, NEUTRO. Errar silenciosamente uma
// flexão de gênero de vez em quando é um risco muito menor do que arriscar
// sempre — ver a seção de risco no plano de implementação.

import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../../poster/logger.js';

const CACHE_PATH = path.resolve('./tmp/ibge-name-gender-cache.json');
const CACHE_MAX = 5000;
const IBGE_BASE = 'https://servicodados.ibge.gov.br/api/v2/censos/nomes';
const CONFIDENT_RATIO = 0.85; // >= isso: confiança alta
const LEAN_RATIO = 0.55;      // >= isso (e < CONFIDENT_RATIO): confiança baixa
const MIN_TOTAL_FREQ = 20;    // abaixo disso, nome raro demais pra confiar no Censo

// ─── Cache local (JSON, sem expiração — dado censitário é estático) ──────────

function loadCache() {
    try {
        const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf-8'));
        return raw && typeof raw === 'object' ? raw : {};
    } catch {
        return {};
    }
}

function saveCache(cache) {
    try {
        const keys = Object.keys(cache);
        if (keys.length > CACHE_MAX) {
            // FIFO simples: descarta as entradas mais antigas por ordem de inserção
            for (const k of keys.slice(0, keys.length - CACHE_MAX)) delete cache[k];
        }
        fs.mkdirSync(path.dirname(CACHE_PATH), { recursive: true });
        fs.writeFileSync(CACHE_PATH, JSON.stringify(cache), 'utf-8');
    } catch (err) {
        logger.warn(`[Gender] Falha ao salvar cache: ${err.message}`);
    }
}

// ─── Normalização / heurística de "isso nem parece nome" ─────────────────────

function normalizeFirstName(displayName) {
    if (!displayName || typeof displayName !== 'string') return null;

    const firstToken = displayName.trim().split(/\s+/)[0] ?? '';
    const normalized = firstToken
        .normalize('NFD')
        .replace(/[̀-ͯ]/g, '') // remove acentos (marcas combinantes pós-NFD)
        .replace(/[^a-zA-Z]/g, '') // remove dígitos/símbolos/emoji
        .toLowerCase();

    if (normalized.length < 2 || normalized.length > 20) return null;

    // Heurística de handle/gamer-tag: token original tinha dígito/underscore,
    // ou é tudo maiúsculo com 6+ letras (comum em apelidos, raro em nomes
    // próprios digitados normalmente).
    const looksLikeHandle = /[0-9_]/.test(firstToken) || /^[A-Z]{6,}$/.test(firstToken);
    if (looksLikeHandle) return null;

    return normalized;
}

// ─── Consulta ao IBGE ──────────────────────────────────────────────────────

async function fetchIbgeFrequency(nome, sexo) {
    const url = `${IBGE_BASE}/${encodeURIComponent(nome)}?sexo=${sexo}`;
    const { data } = await axios.get(url, { timeout: 5000 });
    const entry = Array.isArray(data) ? data[0] : null;
    const res = entry?.res ?? [];
    return res.reduce((sum, r) => sum + (r.frequencia ?? 0), 0);
}

async function queryIbgeGender(nome) {
    const [freqF, freqM] = await Promise.all([
        fetchIbgeFrequency(nome, 'f').catch(() => 0),
        fetchIbgeFrequency(nome, 'm').catch(() => 0),
    ]);

    const total = freqF + freqM;
    if (total < MIN_TOTAL_FREQ) return { gender: 'unknown', confidence: 0, source: 'ibge' };

    const ratioF = freqF / total;
    const ratioM = freqM / total;
    const [winner, ratio] = ratioF >= ratioM ? ['f', ratioF] : ['m', ratioM];

    if (ratio >= CONFIDENT_RATIO) return { gender: winner, confidence: ratio, source: 'ibge' };
    if (ratio >= LEAN_RATIO) return { gender: winner, confidence: ratio, source: 'ibge' };
    return { gender: 'unknown', confidence: ratio, source: 'ibge' }; // perto de 50/50 — unissex
}

/**
 * Infere o gênero provável a partir do nome de exibição de um comentarista.
 * Nunca lança exceção — pior caso retorna `unknown`.
 *
 * @param {string} displayName
 * @returns {Promise<{ gender: 'm'|'f'|'unknown', confidence: number, source: 'ibge'|'none' }>}
 */
export async function inferGenderFromName(displayName) {
    const firstName = normalizeFirstName(displayName);
    if (!firstName) return { gender: 'unknown', confidence: 0, source: 'none' };

    const cache = loadCache();
    if (cache[firstName]) return cache[firstName];

    let result;
    try {
        result = await queryIbgeGender(firstName);
    } catch (err) {
        logger.warn(`[Gender] Consulta ao IBGE falhou para "${firstName}": ${err.message}`);
        result = { gender: 'unknown', confidence: 0, source: 'none' };
    }

    cache[firstName] = result;
    saveCache(cache);
    return result;
}

// Execução standalone: node src/comment-bot/gender.js "Nome 1" "Nome 2" ...
if (process.argv[1] && path.basename(process.argv[1]) === 'gender.js') {
    const names = process.argv.slice(2);
    if (names.length === 0) {
        console.log('Uso: node src/comment-bot/gender.js "Maria Silva" "João123" "xX_ProGamer_Xx" "Alex"');
        process.exit(1);
    }
    const results = await Promise.all(names.map(async (n) => [n, await inferGenderFromName(n)]));
    for (const [name, result] of results) {
        console.log(`${name.padEnd(24)} → ${JSON.stringify(result)}`);
    }
}
