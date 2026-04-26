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

    const top10 = await rankTargets(allTargets);
    return top10;
}
