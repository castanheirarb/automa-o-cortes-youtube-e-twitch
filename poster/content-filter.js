// poster/content-filter.js
// Filtro de conteúdo ofensivo para garantir monetização.
// Sanitiza transcrições e metadados antes/depois da geração por IA.
//
// Três camadas de proteção:
//   1. sanitizeTranscript()  — limpa a transcrição ANTES de enviar ao LLM
//   2. sanitizeMetadataText() — limpa título/descrição DEPOIS do LLM gerar
//   3. containsOffensiveContent() — verifica se o texto final é seguro
//
// A lista de termos é focada em PT-BR e cobre as categorias que causam
// desmonetização no YouTube conforme as Advertiser-Friendly Guidelines.

import { logger } from './logger.js';

// ─── Lista de termos ofensivos (PT-BR) ──────────────────────────────────────
// Organizados por categoria de risco de desmonetização.
// Regex com word boundaries (\b) para evitar falsos positivos.

const PROFANITY_PATTERNS = [
    // ── Palavrões fortes (desmonetização imediata em título/thumbnail) ────────
    /\b(porra|caralho|cacete|foda[-\s]?se|fodido|fodeu|fudeu|fudido)\b/gi,
    /\b(puta|putaria|puteiro|puto|filha?\s*da\s*puta|fdp|arrombad[oa])\b/gi,
    /\b(buceta|boceta|xoxota|xereca|ppk|piroca|rola|pau\s*no\s*cu)\b/gi,
    /\b(cu\b|cuzão|cuzuda|cuzinho|bunda\s*mole)\b/gi,
    /\b(viado|veado|viad[ãa]o|bicha|bichona|sapatão|sapatona)\b/gi,
    /\b(retardad[oa]|mongoloid[ea]|dement[ea]|imbecil|cretino)\b/gi,
    /\b(vagabund[oa]|piranha|galinha|vadia|vadi[oa]|rapariga)\b/gi,
    /\b(corno|cornudo|chifrudo|gad[oa]|otári[oa]|trouxa)\b/gi,

    // ── Palavrões moderados (receita limitada se no título) ──────────────────
    /\b(merda|bosta|droga|desgraça|desgraçad[oa]|maldito|inferno)\b/gi,
    /\b(idiota|burr[oa]|imbecil|estúpid[oa]|babaca|panaca|energúmen[oa])\b/gi,
    /\b(nojent[oa]|lixo\s*humano|escóri[oa]|verme|parasit[oa])\b/gi,

    // ── Termos de ódio/discriminação (sem receita) ───────────────────────────
    /\b(negr[oa]\s*de\s*merda|preto\s*imundo|macac[oa]|crioulo)\b/gi,
    /\b(racis[mt]|homofóbic[oa]|transfóbic[oa]|xenófob[oa])\b/gi,
    /\b(nazist[oa]|hitler|fascist[oa]|supremacist[oa])\b/gi,

    // ── Termos sexuais (desmonetização em título/thumbnail) ──────────────────
    /\b(sex[oa]|porn[ôo]|safad[oa]|tesud[oa]|gostosa|pelad[oa]|nua?)\b/gi,
    /\b(orgasm[oa]|masturb|ejacul|penetra[çc]|transar|trepar)\b/gi,
    /\b(stripper|prostitu[it]|garota\s*de\s*programa|puteiro)\b/gi,

    // ── Violência explícita ──────────────────────────────────────────────────
    /\b(matar|assassin|suicíd|suicid|esquartej|decapit|estupro|estuprar)\b/gi,
    /\b(massacre|genocíd|tortura[r]?|linchamento|linchar)\b/gi,

    // ── Drogas (desmonetização) ──────────────────────────────────────────────
    /\b(maconha|cocaína|crack|heroína|ecstasy|lsd|metanfetamina)\b/gi,
    /\b(chapado|drogado|noiado|cheirar\s*pó|baseado|beck)\b/gi,
    /\b(traficante|tráfico|biqueira|boca\s*de\s*fumo)\b/gi,

    // ── Termos que o YouTube sinaliza em títulos ─────────────────────────────
    /\b(morreu|morte|morto|cadáver|caixão)\b/gi,
    /\b(tiro|bala|arma|pistola|fuzil|metralhadora)\b/gi,
    /\b(sangue|sangrando|hemorragi|ferimento\s*grave)\b/gi,
];

// ── Substituições limpas para termos comuns em transcrições de lives ─────────
// Mantém o sentido sem usar a palavra ofensiva.

const TRANSCRIPT_REPLACEMENTS = [
    [/\bporra\b/gi, 'caramba'],
    [/\bcaralho\b/gi, 'nossa'],
    [/\bmerda\b/gi, 'droga'],
    [/\bfoda[-\s]?se\b/gi, 'dane-se'],
    [/\bfodeu\b/gi, 'complicou'],
    [/\bfudeu\b/gi, 'complicou'],
    [/\bputa\s*(que\s*pariu|merda)\b/gi, 'putz'],
    [/\bfilh[oa]\s*da\s*puta\b/gi, 'sem-vergonha'],
    [/\bfdp\b/gi, 'sem-vergonha'],
    [/\bcacete\b/gi, 'caramba'],
    [/\bdesgraça(do|da)?\b/gi, 'danado'],
    [/\barrombad[oa]\b/gi, 'abusado'],
    [/\bviado\b/gi, '[censurado]'],
    [/\bvagabund[oa]\b/gi, 'folgado'],
    [/\bcorno\b/gi, 'traído'],
    [/\bbabaca\b/gi, 'bobo'],
    [/\bidiota\b/gi, 'bobo'],
    [/\bburr[oa]\b/gi, 'desinformado'],
    [/\bretardad[oa]\b/gi, '[censurado]'],
    [/\bimbecil\b/gi, 'bobo'],
    [/\bbosta\b/gi, 'coisa ruim'],
    [/\bcu\b/gi, 'traseiro'],
    [/\bcuzão\b/gi, 'covarde'],
    [/\bpiranha\b/gi, '[censurado]'],
    [/\bchapado\b/gi, 'alterado'],
    [/\bbêbado\b/gi, 'alterado'],
    [/\bdrogado\b/gi, 'alterado'],
];

// ─── Funções Públicas ────────────────────────────────────────────────────────

/**
 * Sanitiza a transcrição ANTES de enviar ao LLM.
 * Substitui palavrões por equivalentes limpos para que o modelo
 * não reproduza a linguagem ofensiva no título/descrição.
 *
 * @param {string} transcript - Transcrição bruta do Whisper
 * @returns {string} Transcrição limpa
 */
export function sanitizeTranscript(transcript) {
    if (!transcript) return '';

    let clean = transcript;
    let replacements = 0;

    for (const [pattern, replacement] of TRANSCRIPT_REPLACEMENTS) {
        const before = clean;
        clean = clean.replace(pattern, replacement);
        if (clean !== before) replacements++;
    }

    if (replacements > 0) {
        logger.info(`[ContentFilter] Transcrição sanitizada: ${replacements} substituição(ões)`);
    }

    return clean;
}

/**
 * Sanitiza texto de metadados (título, descrição) DEPOIS da geração pelo LLM.
 * Remove qualquer termo ofensivo que tenha passado pelo filtro do modelo.
 *
 * @param {string} text - Texto gerado pelo LLM
 * @returns {string} Texto limpo
 */
export function sanitizeMetadataText(text) {
    if (!text) return '';

    let clean = text;

    // Aplica substituições conhecidas primeiro
    for (const [pattern, replacement] of TRANSCRIPT_REPLACEMENTS) {
        clean = clean.replace(pattern, replacement);
    }

    // Remove qualquer termo restante que bata nos padrões de profanidade
    for (const pattern of PROFANITY_PATTERNS) {
        clean = clean.replace(pattern, '***');
    }

    // Limpa artefatos de censura (*** repetidos, espaços duplos)
    clean = clean.replace(/\*{3,}/g, '').replace(/\s{2,}/g, ' ').trim();

    // Se ficou muito curto após limpeza, é sinal de que era muito ofensivo
    if (clean.length < 10 && text.length > 20) {
        logger.warn(`[ContentFilter] Texto ficou muito curto após sanitização: "${clean}" (original: "${text.substring(0, 50)}")`);
    }

    return clean;
}

/**
 * Verifica se um texto contém conteúdo ofensivo.
 * Retorna true se o texto é SEGURO, false se contém ofensas.
 *
 * @param {string} text
 * @returns {{ safe: boolean, matches: string[] }}
 */
export function checkContentSafety(text) {
    if (!text) return { safe: true, matches: [] };

    const matches = [];

    for (const pattern of PROFANITY_PATTERNS) {
        const found = text.match(pattern);
        if (found) {
            matches.push(...found);
        }
    }

    if (matches.length > 0) {
        logger.warn(`[ContentFilter] Conteúdo ofensivo detectado: ${matches.slice(0, 5).join(', ')}`);
    }

    return { safe: matches.length === 0, matches: [...new Set(matches)] };
}

/**
 * Sanitiza legendas (SRT) para remover palavrões antes de queimar no vídeo.
 * Substitui por equivalentes limpos ou censura com asteriscos.
 *
 * @param {string} srtContent - Conteúdo do arquivo SRT
 * @returns {string} SRT limpo
 */
export function sanitizeCaptions(srtContent) {
    if (!srtContent) return '';

    let clean = srtContent;
    let count = 0;

    for (const [pattern, replacement] of TRANSCRIPT_REPLACEMENTS) {
        const before = clean;
        clean = clean.replace(pattern, replacement);
        if (clean !== before) count++;
    }

    // Remove termos que não têm substituição limpa
    for (const pattern of PROFANITY_PATTERNS) {
        const before = clean;
        clean = clean.replace(pattern, '***');
        if (clean !== before) count++;
    }

    if (count > 0) {
        logger.info(`[ContentFilter] Legendas sanitizadas: ${count} correção(ões)`);
    }

    return clean;
}
