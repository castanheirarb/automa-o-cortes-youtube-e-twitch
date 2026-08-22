// poster/comment-safety.js
// Portão de segurança nos DOIS sentidos pro Comment Bot — não-negociável,
// independe da decisão de "responder tudo sem revisão humana":
//   1. classifyIncomingComment() decide se um comentário MERECE resposta.
//   2. classifyOutgoingReply()  valida a resposta gerada pela IA antes de publicar.
//
// Deliberadamente regex/keyword, sem chamada de IA — mesmo padrão já usado em
// poster/content-filter.js: mais rápido, determinístico e auditável (dá pra
// apontar exatamente qual padrão disparou). Upgrade documentado, não
// implementado: um 2º passe via LLM (ex. Groq rápido) só nos casos
// "de fronteira" que passarem no regex mas tiverem alguma palavra de cautela.

import { checkContentSafety, sanitizeMetadataText } from './content-filter.js';
import { logger } from './logger.js';

// ── Spam / autopromoção ───────────────────────────────────────────────────
const SPAM_PATTERNS = [
    /https?:\/\/\S+/i,
    /\b(bit\.ly|wa\.me|t\.me|linktr\.ee)\b/i,
    /\bconfi(ra|ram)\s+(meu|nosso)\s+canal\b/i,
    /\bganhe?\s+dinheiro\b/i,
    /\bclique\s+no\s+link\b/i,
    /\blink\s+na\s+bio\b/i,
    /\binscreva[-\s]?se\s+no\s+meu\b/i,
    /\b\d{2}\s?9?\d{4}[-\s]?\d{4}\b/, // padrão de telefone BR
];

// ── Crise / autolesão — NUNCA responder, só pular ────────────────────────
const CRISIS_PATTERNS = [
    /\bquero\s+morrer\b/i,
    /\bvou\s+me\s+matar\b/i,
    /\bn[ãa]o\s+aguento\s+mais\s+viver\b/i,
    /\bautomutila[çc][ãa]o\b/i,
    /\bme\s+cort(ar|ei|o)\b/i,
    /\bsuic[íi]d/i,
    /\bpensando\s+em\s+desistir\s+de\s+tudo\b/i,
];

// ── Pedidos que exigem julgamento humano (dinheiro, contato, aconselhamento) ──
const SENSITIVE_REQUEST_PATTERNS = [
    /\bme\s+manda\s+(seu\s+)?(zap|whatsapp|numero|número|pix)\b/i,
    /\bme\s+chama\s+no\s+(whatsapp|zap|instagram|insta|direct|dm)\b/i,
    /\bpode\s+me\s+emprestar\b/i,
    /\bpreciso\s+de\s+dinheiro\b/i,
    /\bposso\s+tomar\s+(esse|este)\s+rem[ée]dio\b/i,
    /\bvou\s+ser\s+processad[oa]\b/i,
    /\bcomo\s+(tirar|conseguir)\s+visto\b/i,
    /\bqual\s+advogado\b/i,
];

// ── Filtro extra pro canal infantil: nunca reagir a troca de dado pessoal ────
const KIDS_EXTRA_PATTERNS = [
    /\btenho\s+\d{1,2}\s+anos\b/i,
    /\bonde\s+voc[êe]\s+mora\b/i,
    /\bvamos\s+nos\s+encontrar\b/i,
    /\bqual\s+sua\s+escola\b/i,
];

function firstMatch(text, patterns) {
    for (const p of patterns) {
        if (p.test(text)) return p.source;
    }
    return null;
}

/**
 * Decide se um comentário recebido merece resposta automática.
 * @param {string} text
 * @param {{ channelKey?: string }} [opts]
 * @returns {{ shouldReply: boolean, reason: string|null }}
 */
export function classifyIncomingComment(text, { channelKey } = {}) {
    if (!text || text.trim().length === 0) {
        return { shouldReply: false, reason: 'empty' };
    }

    const safety = checkContentSafety(text);
    if (!safety.safe) {
        return { shouldReply: false, reason: `hate_or_profanity:${safety.matches[0]}` };
    }

    const spamHit = firstMatch(text, SPAM_PATTERNS);
    if (spamHit) return { shouldReply: false, reason: `spam:${spamHit}` };

    const crisisHit = firstMatch(text, CRISIS_PATTERNS);
    if (crisisHit) {
        logger.warn(`[Comment-Safety] Comentário com sinal de crise/autolesão detectado — pulando sem responder (sem escalonamento automático).`);
        return { shouldReply: false, reason: `crisis:${crisisHit}` };
    }

    const sensitiveHit = firstMatch(text, SENSITIVE_REQUEST_PATTERNS);
    if (sensitiveHit) return { shouldReply: false, reason: `sensitive_request:${sensitiveHit}` };

    if (channelKey === 'infantil') {
        const kidsHit = firstMatch(text, KIDS_EXTRA_PATTERNS);
        if (kidsHit) return { shouldReply: false, reason: `kids_personal_info:${kidsHit}` };
    }

    return { shouldReply: true, reason: null };
}

/**
 * Valida a resposta gerada pela IA antes de publicar.
 * @param {string} text
 * @returns {{ safe: boolean, reason: string|null, cleaned: string }}
 */
export function classifyOutgoingReply(text) {
    const cleaned = sanitizeMetadataText(text ?? '');

    if (!cleaned || cleaned.trim().length < 2) {
        return { safe: false, reason: 'empty_after_sanitize', cleaned };
    }

    const safety = checkContentSafety(cleaned);
    if (!safety.safe) {
        return { safe: false, reason: `unsafe_output:${safety.matches[0]}`, cleaned };
    }

    const spamHit = firstMatch(cleaned, SPAM_PATTERNS);
    if (spamHit) return { safe: false, reason: `output_is_spam:${spamHit}`, cleaned };

    return { safe: true, reason: null, cleaned };
}
