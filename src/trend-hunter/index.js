// src/trend-hunter/index.js
import { scoutYouTube } from './youtube-scout.js';
import { scoutTwitch } from './twitch-scout.js';
import { rankTargets } from './ranker.js';
import { logger } from '../utils/logger.js';

export async function runTrendHunter() {
    logger.step('[TrendHunter] Iniciando busca por conteúdo viral...');
    const [youtubeTargets, twitchTargets] = await Promise.all([
        scoutYouTube(),
        scoutTwitch(),
    ]);

    const allTargets = [...youtubeTargets, ...twitchTargets];
    if (allTargets.length === 0) {
        logger.warn('[TrendHunter] Nenhum alvo encontrado.');
        return [];
    }

    try {
        return await rankTargets(allTargets);
    } catch (err) {
        // Uma falha do Gemini (resposta truncada, JSON inválido, etc.) não pode
        // derrubar o serviço inteiro — sem isso o HUNTER ficava 12h parado a cada erro.
        logger.error(`[TrendHunter] Ranker falhou: ${err.message}`);
        return [];
    }
}
