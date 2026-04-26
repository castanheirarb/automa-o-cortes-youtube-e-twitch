// poster/metadata-validator.js
// Valida e sanitiza metadados antes do upload para garantir:
//  1. Conformidade com as diretrizes do YouTube (advertiser-friendly)
//  2. Unicidade de títulos e hashtags (sem repetição entre posts)
//  3. Ausência de conteúdo ofensivo (filtro de profanidade)
//  4. Regeneração automática via IA quando há problemas

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';
import { checkContentSafety, sanitizeMetadataText } from './content-filter.js';

// ─── Arquivo de histórico de metadados ───────────────────────────────────────

const HISTORY_FILE = path.resolve('./postados/metadata-history.json');

function loadHistory() {
    try {
        return JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
    } catch {
        return { titles: [], hashtags: [], descriptions: [] };
    }
}

function saveHistory(history) {
    fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
    fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
}

export function recordMetadataHistory(titulo, hashtags) {
    const history = loadHistory();
    if (!history.titles.includes(titulo)) history.titles.push(titulo);
    const tags = hashtags.split(/\s+/).filter(Boolean).map((t) => t.toLowerCase());
    for (const tag of tags) {
        if (!history.hashtags.includes(tag)) history.hashtags.push(tag);
    }
    history.titles = history.titles.slice(-500);
    history.hashtags = history.hashtags.slice(-1000);
    saveHistory(history);
}

// ─── Diretrizes do YouTube ────────────────────────────────────────────────────

const YT_RULES = {
    titulo: {
        maxLen: 100,
        warnLen: 70,
        minLen: 20,
        forbiddenPhrases: [
            /\b(você não vai acreditar|incrível|chocante|imperdível|clique aqui|assista agora)\b/i,
            /\b(episode|ep\.?\s*\d+|parte\s+\d+|part\s+\d+|s[ée]rie ep\s*\d+)\b/i,
            /#\w+\s+#\w+\s+#\w+/,
            /^corte\s*#?\d+/i,
            /\bpico\s*(em|@)?\s*\d/i,
            /^\d+__/,
            /^(curte|like|inscreva|shorts?|viral|video|vídeo|clip|clipe)\s*$/i,
        ],
        maxHashtagsInTitle: 5,
        maxEmojis: 2,
        maxCaps: 0.4,
        hookPatterns: [
            /[?!…]/,
            /\b(admitiu|revelou|confessou|errou|perdeu|ganhou|explodiu|chorou|discutiu|reagiu)\b/i,
            /\b(nunca|sempre|primeiro|único|só|pela primeira vez)\b/i,
            /\b(por que|como|quando|quem|o que)\b/i,
            /\b(verdade|segredo|real|aconteceu|ao vivo)\b/i,
        ],
    },
    hashtags: {
        min: 3,
        max: 5,
        maxLenPerTag: 30,
        forbidden: ['#adulto', '#18+', '#xxx', '#nsfw', '#porno', '#spam', '#sexo', '#drogas', '#violencia'],
        mustInclude: ['#shorts'],
    },
    descricao: {
        maxLen: 5000,
        minLen: 20,
        mustHaveCTA: true,
        ctaPatterns: [/inscreva/i, /subscribe/i, /segue/i, /follow/i, /curte/i, /like/i],
    },
};

const TIKTOK_RULES = {
    caption: {
        maxLen: 2200,
        warnLen: 150,
        minLen: 20,
        forbidden: ['#adulto', '#18+', '#xxx', '#nsfw', '#porno', '#spam'],
        mustInclude: ['#shorts'],
        maxHashtags: 10,
        minHashtags: 3,
    },
};

// ─── Validação Principal ──────────────────────────────────────────────────────

export function validateMetadata(metadata) {
    const errors = [];
    const warnings = [];
    let score = 100;

    const { titulo = '', descricao = '', hashtags = '' } = metadata;
    const history = loadHistory();

    // ── VERIFICAÇÃO DE CONTEÚDO OFENSIVO (NOVA — prioridade máxima) ──────────
    const tituloSafety = checkContentSafety(titulo);
    if (!tituloSafety.safe) {
        errors.push(`Título contém linguagem ofensiva: '${tituloSafety.matches.slice(0, 3).join(', ')}' — DESMONETIZAÇÃO GARANTIDA`);
        score -= 80;
    }

    const descSafety = checkContentSafety(descricao);
    if (!descSafety.safe) {
        errors.push(`Descrição contém linguagem ofensiva: '${descSafety.matches.slice(0, 3).join(', ')}'`);
        score -= 40;
    }

    const hashSafety = checkContentSafety(hashtags);
    if (!hashSafety.safe) {
        errors.push(`Hashtags contêm linguagem ofensiva: '${hashSafety.matches.slice(0, 3).join(', ')}'`);
        score -= 50;
    }

    // ── TÍTULO ────────────────────────────────────────────────────────────────
    if (titulo.length < YT_RULES.titulo.minLen) {
        errors.push(`Título muito curto (${titulo.length} chars, mín ${YT_RULES.titulo.minLen})`);
        score -= 30;
    }

    if (titulo.length > YT_RULES.titulo.maxLen) {
        errors.push(`Título excede limite do YouTube (${titulo.length}/${YT_RULES.titulo.maxLen} chars)`);
        score -= 20;
    } else if (titulo.length > YT_RULES.titulo.warnLen) {
        warnings.push(`Título longo — pode ser cortado em mobile (${titulo.length}/${YT_RULES.titulo.warnLen})`);
        score -= 5;
    }

    for (const pattern of YT_RULES.titulo.forbiddenPhrases) {
        if (pattern.test(titulo)) {
            errors.push(`Título contém expressão proibida: '${titulo.match(pattern)?.[0]}'`);
            score -= 25;
        }
    }

    const upperCount = (titulo.match(/[A-ZÁÉÍÓÚÃÕÂÊÎÔÛÑ]/g) || []).length;
    const letterCount = (titulo.match(/[a-zA-ZÀ-ÿ]/g) || []).length;
    if (letterCount > 0 && upperCount / letterCount > YT_RULES.titulo.maxCaps) {
        warnings.push(`Título com excesso de maiúsculas (${Math.round(upperCount / letterCount * 100)}%)`);
        score -= 10;
    }

    const hashtagsInTitle = (titulo.match(/#\w+/g) || []).length;
    if (hashtagsInTitle > YT_RULES.titulo.maxHashtagsInTitle) {
        warnings.push(`Título com ${hashtagsInTitle} hashtags — máx ${YT_RULES.titulo.maxHashtagsInTitle}`);
        score -= 10;
    }

    const emojiCount = (titulo.match(/[\u{1F300}-\u{1FAFF}]/gu) || []).length;
    if (emojiCount > YT_RULES.titulo.maxEmojis) {
        warnings.push(`Título com ${emojiCount} emojis — máx ${YT_RULES.titulo.maxEmojis}`);
        score -= 5;
    }

    const hasHook = YT_RULES.titulo.hookPatterns.some((p) => p.test(titulo));
    if (!hasHook) {
        warnings.push('Título sem gatilho de engajamento');
        score -= 15;
    }

    const duplicateTitle = history.titles.find(
        (t) => t.toLowerCase() === titulo.toLowerCase()
    );
    if (duplicateTitle) {
        errors.push(`Título já usado: '${duplicateTitle}'`);
        score -= 40;
    }

    const titleWords = new Set(titulo.toLowerCase().split(/\s+/).filter((w) => w.length > 3));
    for (const prevTitle of history.titles.slice(-50)) {
        const prevWords = prevTitle.toLowerCase().split(/\s+/).filter((w) => w.length > 3);
        const matches = prevWords.filter((w) => titleWords.has(w)).length;
        if (prevWords.length > 0 && matches / prevWords.length > 0.8) {
            warnings.push(`Título similar a post anterior: '${prevTitle}'`);
            score -= 15;
            break;
        }
    }

    // ── HASHTAGS ─────────────────────────────────────────────────────────────
    const tagList = hashtags.split(/\s+/).filter((t) => t.startsWith('#') && t.length > 1);

    if (tagList.length < YT_RULES.hashtags.min) {
        errors.push(`Poucas hashtags (${tagList.length}, mín ${YT_RULES.hashtags.min})`);
        score -= 15;
    }

    if (tagList.length > YT_RULES.hashtags.max) {
        warnings.push(`Muitas hashtags (${tagList.length}, máx ${YT_RULES.hashtags.max})`);
        score -= 5;
    }

    const hasShorts = tagList.some((t) => t.toLowerCase() === '#shorts');
    if (!hasShorts) {
        errors.push('Hashtag #shorts ausente');
        score -= 30;
    }

    for (const tag of tagList) {
        if (tag.length > YT_RULES.hashtags.maxLenPerTag) {
            warnings.push(`Hashtag longa: '${tag}'`);
            score -= 3;
        }
        if (YT_RULES.hashtags.forbidden.includes(tag.toLowerCase())) {
            errors.push(`Hashtag proibida: '${tag}'`);
            score -= 50;
        }
    }

    const historyLower = history.hashtags.map((h) => h.toLowerCase());
    const usedTags = tagList.filter((t) => historyLower.includes(t.toLowerCase()));
    if (usedTags.length === tagList.length && tagList.length > 0) {
        warnings.push('Todas as hashtags já usadas — rotacione');
        score -= 20;
    } else if (usedTags.length > tagList.length * 0.6) {
        warnings.push(`${usedTags.length}/${tagList.length} hashtags repetidas`);
        score -= 8;
    }

    const uniqueTags = new Set(tagList.map((t) => t.toLowerCase()));
    if (uniqueTags.size < tagList.length) {
        errors.push('Hashtags duplicadas no mesmo post');
        score -= 20;
    }

    // ── DESCRIÇÃO ─────────────────────────────────────────────────────────────
    if (descricao.length < YT_RULES.descricao.minLen) {
        warnings.push(`Descrição curta (${descricao.length} chars)`);
        score -= 10;
    }

    if (descricao.length > YT_RULES.descricao.maxLen) {
        errors.push(`Descrição excede limite (${descricao.length}/${YT_RULES.descricao.maxLen})`);
        score -= 15;
    }

    if (YT_RULES.descricao.mustHaveCTA) {
        const hasCTA = YT_RULES.descricao.ctaPatterns.some((p) => p.test(descricao));
        if (!hasCTA) {
            warnings.push('Descrição sem CTA');
            score -= 8;
        }
    }

    return { valid: errors.length === 0, errors, warnings, score: Math.max(0, score) };
}

// ─── Auto-sanitização ────────────────────────────────────────────────────────

export function sanitizeMetadata(metadata) {
    let { titulo, descricao, hashtags } = metadata;

    // Sanitiza conteúdo ofensivo PRIMEIRO
    titulo = sanitizeMetadataText(titulo);
    descricao = sanitizeMetadataText(descricao);

    if (titulo.length > YT_RULES.titulo.maxLen) {
        titulo = titulo.substring(0, YT_RULES.titulo.maxLen - 3) + '...';
    }

    if ((titulo.match(/#\w+/g) || []).length > YT_RULES.titulo.maxHashtagsInTitle) {
        const seen = new Set();
        titulo = titulo.replace(/#(\w+)/g, (match) => {
            const lower = match.toLowerCase();
            if (seen.has(lower)) return '';
            seen.add(lower);
            return match;
        }).replace(/\s{2,}/g, ' ').trim();
    }

    const tagList = hashtags.split(/\s+/).filter((t) => t.startsWith('#'));
    if (!tagList.some((t) => t.toLowerCase() === '#shorts')) {
        tagList.unshift('#shorts');
    }
    const uniqueTags = [...new Set(tagList.map((t) => t.toLowerCase()))];
    // Remove hashtags proibidas
    const safeTags = uniqueTags.filter((t) => !YT_RULES.hashtags.forbidden.includes(t));
    hashtags = safeTags.slice(0, YT_RULES.hashtags.max).join(' ');

    if (descricao.length > YT_RULES.descricao.maxLen) {
        descricao = descricao.substring(0, YT_RULES.descricao.maxLen - 50) + '...\nInscreva-se para mais cortes!';
    }

    const hasCTA = YT_RULES.descricao.ctaPatterns.some((p) => p.test(descricao));
    if (!hasCTA) {
        descricao = descricao.trimEnd() + '\n\nInscreva-se para mais cortes! 🎬';
    }

    return { titulo, descricao, hashtags };
}

// ─── Validação com log formatado ─────────────────────────────────────────────

export function validateAndLog(metadata) {
    const result = validateMetadata(metadata);

    const icon = result.score >= 80 ? '✅' : result.score >= 50 ? '⚠️' : '❌';
    logger.info(`[Validator] ${icon} Score: ${result.score}/100`);

    for (const err of result.errors) {
        logger.error(`[Validator] ❌ ${err}`);
    }
    for (const warn of result.warnings) {
        logger.warn(`[Validator] ⚠️  ${warn}`);
    }

    const sanitized = sanitizeMetadata(metadata);

    return { ...sanitized, _validation: result };
}

export function validateTikTokCaption(caption) {
    const errors = [];
    const warnings = [];
    let score = 100;

    if (!caption || caption.trim().length === 0) {
        return { valid: false, errors: ['Caption vazio'], warnings: [], score: 0 };
    }

    // Verifica conteúdo ofensivo
    const safety = checkContentSafety(caption);
    if (!safety.safe) {
        errors.push(`Caption contém linguagem ofensiva: '${safety.matches.slice(0, 3).join(', ')}'`);
        score -= 60;
    }

    if (caption.length > TIKTOK_RULES.caption.maxLen) {
        errors.push(`Caption excede limite (${caption.length}/${TIKTOK_RULES.caption.maxLen})`);
        score -= 30;
    }

    if (caption.length > TIKTOK_RULES.caption.warnLen) {
        warnings.push(`Caption longo — ~150 chars visíveis (${caption.length} chars)`);
        score -= 5;
    }

    const tagList = caption.match(/#\w+/g) || [];

    if (tagList.length < TIKTOK_RULES.caption.minHashtags) {
        warnings.push(`Poucas hashtags (${tagList.length})`);
        score -= 10;
    }

    if (tagList.length > TIKTOK_RULES.caption.maxHashtags) {
        warnings.push(`Muitas hashtags (${tagList.length})`);
        score -= 10;
    }

    const hasShorts = tagList.some((t) => t.toLowerCase() === '#shorts');
    if (!hasShorts) {
        warnings.push('Caption sem #shorts');
        score -= 8;
    }

    for (const forbidden of TIKTOK_RULES.caption.forbidden) {
        if (caption.toLowerCase().includes(forbidden)) {
            errors.push(`Hashtag proibida: '${forbidden}'`);
            score -= 50;
        }
    }

    return { valid: errors.length === 0, errors, warnings, score: Math.max(0, score) };
}
