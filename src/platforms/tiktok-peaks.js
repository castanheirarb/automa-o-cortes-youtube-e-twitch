// src/platforms/tiktok-peaks.js
// Detecção de melhores momentos de uma live TikTok — "Opção C" adaptada:
//   1. Engajamento em tempo real (chat + gifts), coletado durante a gravação
//   2. Fallback: distribuição uniforme
//
// O TikTok não tem equivalente às Community Clips da Twitch (não existe API
// de clipes cortados pela comunidade), então a Estratégia 1 daqui já é o
// engajamento — não há um nível intermediário como o Chat Density puro da
// Twitch. Gifts pesam mais que mensagens de chat: mandar mensagem é de graça
// e span de bots/hype fácil, mas presentear custa dinheiro de verdade — é um
// sinal de "está acontecendo algo bom" bem mais forte que volume de chat.

import { logger } from '../utils/logger.js';

const GIFT_WEIGHT = parseInt(process.env.TIKTOK_GIFT_WEIGHT || '10', 10);

// ─── Estratégia 1: Engajamento (chat + gifts) em tempo real ──────────────────

/**
 * Escuta os eventos 'chat' e 'gift' de uma conexão já aberta (o mesmo emitter
 * usado pra detectar status, de tiktok-live-mirror.js) durante a janela de
 * gravação e agrega em buckets de tempo — mesmo formato de saída do
 * monitorChatDensity() da Twitch, pra reaproveitar a mesma lógica de picos.
 *
 * @param {import('node:events').EventEmitter} emitter
 * @param {number} durationSeconds - Duração da gravação (coincide com recordLiveStream)
 * @param {number} [windowSec=30]  - Tamanho da janela de análise em segundos
 * @returns {Promise<Array<{ peakTime: number, density: number }>>}
 */
export function monitorTikTokEngagement(emitter, durationSeconds, windowSec = 30) {
    return new Promise((resolve) => {
        const buckets = {};
        const startTime = Date.now();

        function bump(weight) {
            const elapsedSec = (Date.now() - startTime) / 1000;
            if (elapsedSec > durationSeconds) return;
            const windowIdx = Math.floor(elapsedSec / windowSec);
            buckets[windowIdx] = (buckets[windowIdx] || 0) + weight;
        }

        const onChat = () => bump(1);
        const onGift = (data) => bump(GIFT_WEIGHT * Math.max(1, data?.repeatCount || 1));

        emitter.on('chat', onChat);
        emitter.on('gift', onGift);

        setTimeout(() => {
            emitter.off('chat', onChat);
            emitter.off('gift', onGift);

            const peaks = Object.entries(buckets)
                .map(([idx, score]) => ({
                    peakTime: (parseInt(idx) * windowSec) + (windowSec / 2),
                    density: score,
                }))
                .filter((p) => p.peakTime < durationSeconds)
                .sort((a, b) => b.density - a.density);

            logger.info(`[TikTokEngagement] ${peaks.length} janela(s) com atividade de chat/gift.`);
            resolve(peaks);
        }, durationSeconds * 1000);
    });
}

// ─── Estratégia 2: Uniforme ───────────────────────────────────────────────────

function getPeaksUniform(topN, videoUrl, duration, title) {
    logger.warn('[TikTokPeaks] Fallback: distribuição uniforme de clipes.');
    const step = duration / (topN + 1);
    return Array.from({ length: topN }, (_, i) => ({
        peakTime: Math.floor(step * (i + 1)),
        peakValue: 1 / (topN - i), // decrescente → favorece clipes do início
        title,
        duration,
        videoUrl,
    }));
}

// ─── Dispatcher ───────────────────────────────────────────────────────────────

/**
 * @param {object} params
 * @param {Array}  params.engagement - Output de monitorTikTokEngagement() (pode ser [])
 * @param {string} params.videoUrl   - Path local do arquivo gravado (mp4)
 * @param {number} params.duration   - Duração gravada em segundos
 * @param {string} params.title
 * @param {number} params.topN
 */
export function getTikTokLivePeaks({ engagement = [], videoUrl, duration, title, topN = 5 }) {
    if (engagement.length > 0) {
        logger.info(`[TikTokPeaks] Usando engajamento (${engagement.length} janela(s) disponíveis).`);
        const maxDensity = engagement[0].density; // já ordenado por densidade
        return engagement.slice(0, topN).map((p) => ({
            peakTime: p.peakTime,
            peakValue: p.density / maxDensity, // normalizado 0-1
            title,
            duration,
            videoUrl,
        }));
    }

    return getPeaksUniform(topN, videoUrl, duration, title);
}
