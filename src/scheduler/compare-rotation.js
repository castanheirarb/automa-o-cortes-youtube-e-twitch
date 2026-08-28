// src/scheduler/compare-rotation.js
// Compara o resultado real (inscritos ganhos, views, receita) POR PERÍODO,
// agrupado pelo modo de rodízio que estava ativo em cada post — não é um
// A/B controlado (não dá pra postar o mesmo vídeo duas vezes com dois modos
// diferentes), é uma comparação observacional antes/depois: cada post grava
// em postados/metadata-history.json qual combinação de flags estava ligada
// no momento (poster/index.js getActiveRotationMode()), e este comando
// agrega o resultado de cada vídeo atribuído por esse rótulo.
//
// 'baseline' = pesos declarados em personas.js, sem nenhuma camada extra —
// inclui todo post anterior à existência dessa feature (rótulo ausente).
//
// CLI:
//   npm run compare-rotation

import 'dotenv/config';
import { logger } from '../utils/logger.js';

function fmtNum(n, digits = 2) {
    return Number(n).toFixed(digits);
}

function fmtDateRange(dates) {
    if (dates.length === 0) return '—';
    const sorted = [...dates].sort();
    const first = sorted[0].slice(0, 10);
    const last = sorted[sorted.length - 1].slice(0, 10);
    return first === last ? first : `${first} → ${last}`;
}

async function main() {
    const { COMMENT_BOT_CHANNELS } = await import('../comment-bot/channels.js');
    const { getOAuth2Client } = await import('../comment-bot/youtube-auth.js');
    const { attributeRecentVideos } = await import('../analytics/attribution.js');
    const { fetchVideoMetrics } = await import('../analytics/youtube-analytics.js');

    const days = parseInt(process.argv.find((a) => a.startsWith('--days='))?.split('=')[1] || '90', 10);

    const channelClients = [];
    for (const ch of COMMENT_BOT_CHANNELS) {
        if (!process.env[ch.refreshTokenEnv]) {
            console.log(`  \x1b[2m(pulando "${ch.label}" — sem ${ch.refreshTokenEnv} no .env)\x1b[0m`);
            continue;
        }
        try {
            channelClients.push({ key: ch.key, client: getOAuth2Client(ch) });
        } catch (err) {
            console.log(`  \x1b[2m(pulando "${ch.label}" — ${err.message})\x1b[0m`);
        }
    }

    if (channelClients.length === 0) {
        console.error('\n❌ Nenhum canal com refresh token válido no .env.\n');
        process.exit(1);
    }

    const byMode = new Map(); // mode -> [{videoId, postedAt, metrics}]

    for (const { key, client } of channelClients) {
        try {
            const attributed = await attributeRecentVideos(client);
            if (attributed.length === 0) continue;

            const metrics = await fetchVideoMetrics(client, attributed.map((v) => v.videoId), { days });
            for (const v of attributed) {
                v.metrics = metrics.get(v.videoId) ?? null;
                if (!v.metrics) continue;
                const mode = v.rotationMode || 'baseline';
                if (!byMode.has(mode)) byMode.set(mode, []);
                byMode.get(mode).push(v);
            }
        } catch (err) {
            logger.warn(`[Compare] Canal "${key}" falhou (${err.message}) — seguindo sem esse canal.`);
        }
    }

    console.log('\n' + '═'.repeat(96));
    console.log('  📊  Comparação por modo de rodízio (observacional — não é A/B controlado)');
    console.log('═'.repeat(96));

    if (byMode.size === 0) {
        console.log('\n  Nenhum vídeo atribuído ainda — rode isto depois de alguns dias de posts.\n');
        return;
    }

    console.log(`\n  ${'Modo'.padEnd(22)}${'Amostra'.padEnd(10)}${'Inscritos/vídeo'.padEnd(18)}${'Views/vídeo'.padEnd(14)}${'R$/vídeo'.padEnd(12)}Período`);
    console.log('  ' + '─'.repeat(92));

    // 'baseline' sempre primeiro como referência, resto por amostra decrescente
    const modes = [...byMode.keys()].sort((a, b) => {
        if (a === 'baseline') return -1;
        if (b === 'baseline') return 1;
        return byMode.get(b).length - byMode.get(a).length;
    });

    for (const mode of modes) {
        const videos = byMode.get(mode);
        const n = videos.length;
        const avgSubs = videos.reduce((s, v) => s + v.metrics.subscribersGained, 0) / n;
        const avgViews = videos.reduce((s, v) => s + v.metrics.views, 0) / n;
        const avgRevenue = videos.reduce((s, v) => s + v.metrics.estimatedRevenue, 0) / n;
        const range = fmtDateRange(videos.map((v) => v.postedAt).filter(Boolean));
        console.log(`  ${mode.padEnd(22)}${String(n).padEnd(10)}${fmtNum(avgSubs).padEnd(18)}${fmtNum(avgViews, 0).padEnd(14)}${fmtNum(avgRevenue).padEnd(12)}${range}`);
    }

    console.log('\n  Leitura: compare "inscritos/vídeo" entre os modos — é a métrica que motivou o teste.');
    console.log('  Cuidado: períodos diferentes têm audiência/sazonalidade diferentes — não é prova definitiva,');
    console.log('  só um indício. Amostra pequena (<10 vídeos por modo) ainda não é confiável.');
    console.log('\n' + '═'.repeat(96) + '\n');
}

main().catch((err) => {
    console.error('Erro fatal:', err.message);
    process.exit(1);
});
