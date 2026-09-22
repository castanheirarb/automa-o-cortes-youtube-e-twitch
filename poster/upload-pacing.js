// poster/upload-pacing.js
// Intervalo mínimo forçado entre posts REAIS por plataforma, independente do
// cron — criado em 2026-09-15 depois que 8 uploads automáticos do Instagram
// em ~40min (rajada, conta nova) travaram todos em "Compartilhando" (0
// publicados), contra 1 publicação manual bem-sucedida no dia anterior.
// Práticas comuns de warm-up de conta nova recomendam espalhar posts ao
// longo do dia em vez de rajada — isso é o mecanismo que aplica isso mesmo
// quando vários slots de cron caem perto um do outro (ex.: round-robin
// pulando de persona em persona rapidamente).
//
// Só limita a FREQUÊNCIA de tentativa — não substitui a humanização de
// digitação/clique (ver poster/human-behavior.js) nem garante que a conta
// não está mais rate-limitada por causa da rajada anterior.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const STATE_PATH = path.resolve('./scheduler/upload-pacing.json');

// Default 0 (sem limite) pra TikTok/YouTube — não mudam comportamento
// existente a menos que configurado. Instagram vem com piso conservador por
// padrão até confirmarmos que a conta se recuperou do incidente de 09/15.
const MIN_INTERVAL_MIN = {
    instagram: parseInt(process.env.INSTAGRAM_MIN_INTERVAL_MIN || '240', 10),
    tiktok: parseInt(process.env.TIKTOK_MIN_INTERVAL_MIN || '0', 10),
    youtube: parseInt(process.env.YOUTUBE_MIN_INTERVAL_MIN || '0', 10),
};

function readState() {
    try {
        return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'));
    } catch {
        return {};
    }
}

function writeState(state) {
    fs.mkdirSync(path.dirname(STATE_PATH), { recursive: true });
    fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/**
 * @param {'instagram'|'tiktok'|'youtube'} platform
 * @returns {number} ms que faltam até a próxima tentativa ser permitida (0 = pode postar agora)
 */
export function msUntilNextAllowed(platform) {
    const minIntervalMs = (MIN_INTERVAL_MIN[platform] || 0) * 60_000;
    if (minIntervalMs <= 0) return 0;
    const last = readState()[platform];
    if (!last) return 0;
    return Math.max(0, minIntervalMs - (Date.now() - last));
}

/** Registra o instante de uma tentativa real (chamar antes do upload, junto com o registry de anti-duplicata). */
export function recordUploadAttempt(platform) {
    const state = readState();
    state[platform] = Date.now();
    writeState(state);
}

/** Loga de forma padronizada quando um post é pulado por estar dentro do intervalo mínimo. */
export function logThrottled(platform, remainingMs) {
    const remainingMin = Math.ceil(remainingMs / 60_000);
    logger.info(`[Pacing] ${platform} — dentro do intervalo mínimo entre posts, faltam ~${remainingMin}min. Pulando este ciclo.`);
}
