// src/utils/gemini-quota-guard.js
// Circuit breaker compartilhado pra cota diária do Gemini free tier (20
// requisições/dia por modelo — "GenerateRequestsPerDayPerProjectPerModel-FreeTier").
// Sem isso, cada chamador (metadata.js, content-optimizer, face-detect,
// thumbnail.js) descobre a cota estourada por conta própria, gastando o
// round-trip + delay de retry do erro 429 a cada post pelo resto do dia —
// visto em produção em 06/09/2026 (~20h em diante), com Optimizer e Thumbnail
// falhando repetidamente até a meia-noite. Uma vez que QUALQUER chamador
// detecta o 429 de cota, os demais pulam Gemini direto pro fallback
// (Groq/frame simples) pelo resto do cooldown, sem tentar de novo.
//
// Cooldown fixo de 24h a partir da primeira detecção — mais simples e seguro
// que tentar replicar o horário exato de reset da Google (varia por fuso/
// política e não é documentado de forma confiável); o pior caso é ficar em
// fallback por mais algumas horas do que o estritamente necessário, o que é
// inofensivo (Groq já é o fallback testado em produção).

const COOLDOWN_MS = 24 * 60 * 60 * 1000;

let exhaustedAt = null;

const QUOTA_ERROR_PATTERN = /free_tier_requests|RESOURCE_EXHAUSTED|\[429 Too Many Requests\]|Quota exceeded/i;

export function isGeminiQuotaError(err) {
    return QUOTA_ERROR_PATTERN.test(err?.message || '');
}

export function markGeminiQuotaExhausted() {
    if (!exhaustedAt) {
        exhaustedAt = Date.now();
    }
}

export function isGeminiQuotaExhausted() {
    if (!exhaustedAt) return false;
    if (Date.now() - exhaustedAt >= COOLDOWN_MS) {
        exhaustedAt = null; // cooldown expirou — libera nova tentativa
        return false;
    }
    return true;
}
