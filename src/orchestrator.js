// src/orchestrator.js
// Script top-level para captação automática de todas as personas (ou uma específica).
//
// Uso:
//   node src/orchestrator.js                   → captura todas as personas (VODs)
//   node src/orchestrator.js cariani           → captura só cariani
//   node src/orchestrator.js cariani --force   → força re-captação
//   node src/orchestrator.js --live            → monitor de lives Twitch (loop contínuo)
//   node src/orchestrator.js --live alanzoka   → monitora só o alanzoka ao vivo
//   node src/orchestrator.js --comment-monitor → Comment Bot (responde comentários do YouTube via API)
//   node src/orchestrator.js --comment-monitor main --dry-run --once → 1 ciclo de teste, só canal principal

import 'dotenv/config';
import { PERSONAS, PERSONAS_MAP } from './capturer/personas.js';
import { capturePersona, captureAll } from './capturer/capturer.js';
import { initBinaries } from './processor/ffmpeg.js';
import { runTrendHunter } from './trend-hunter/index.js';
import { logger } from './utils/logger.js';

async function main() {
    initBinaries();

    const args = process.argv.slice(2);
    const liveMode         = args.includes('--live');
    const huntMode         = args.includes('--hunt');
    const ytMonitorMode    = args.includes('--youtube-monitor');
    const sportsMonitorMode = args.includes('--sports-monitor');
    const commentMonitorMode = args.includes('--comment-monitor');
    const dryRunFlag = args.includes('--dry-run');
    const onceFlag = args.includes('--once');
    const force = args.includes('--force');
    const namedArgs = args.filter((a) => !a.startsWith('--'));

    if (commentMonitorMode) {
        // ── Modo Comment Bot ───────────────────────────────────────────────────
        const { startCommentBot } = await import('./comment-bot/monitor.js');
        const { COMMENT_BOT_CHANNELS } = await import('./comment-bot/channels.js');

        const filterNames = namedArgs.length > 0 ? namedArgs : [];

        console.log('\x1b[36m');
        console.log('═'.repeat(56));
        console.log('  💬  CANAL CORTE — Comment Bot (YouTube)');
        if (filterNames.length > 0) {
            console.log(`  Canal(is): ${filterNames.join(', ')}`);
        } else {
            console.log(`  Canais: ${COMMENT_BOT_CHANNELS.map((c) => c.label).join(', ')}`);
        }
        if (dryRunFlag) console.log('  🧪 Modo DRY-RUN — nada será publicado.');
        console.log('  Pressione Ctrl+C para encerrar.');
        console.log('═'.repeat(56));
        console.log('\x1b[0m');

        await startCommentBot(filterNames, { dryRun: dryRunFlag || undefined, once: onceFlag });

    } else if (sportsMonitorMode) {
        // ── Modo Sports Monitor ───────────────────────────────────────────────
        const { startSportsMonitor } = await import('./capturer/sports-monitor.js');
        const { SPORTS_CHANNELS } = await import('./capturer/sports-channels.js');

        const filterNames = namedArgs.length > 0 ? namedArgs : [];

        console.log('\x1b[32m');
        console.log('═'.repeat(56));
        console.log('  ⚽  CANAL CORTE — Sports Monitor');
        if (filterNames.length > 0) {
            console.log(`  Monitorando: ${filterNames.join(', ')}`);
        } else {
            console.log(`  Monitorando ${SPORTS_CHANNELS.length} canal(is): ${SPORTS_CHANNELS.map((c) => c.displayName).join(', ')}`);
        }
        console.log('  Pressione Ctrl+C para encerrar.');
        console.log('═'.repeat(56));
        console.log('\x1b[0m');

        await startSportsMonitor(filterNames);

    } else if (ytMonitorMode) {
        // ── Modo YouTube Monitor ──────────────────────────────────────────────
        const { startYouTubeMonitor } = await import('./capturer/youtube-monitor.js');

        const filterNames = namedArgs.length > 0 ? namedArgs : [];

        console.log('\x1b[34m');
        console.log('═'.repeat(56));
        console.log('  📺  CANAL CORTE — YouTube Monitor');
        if (filterNames.length > 0) {
            console.log(`  Monitorando: ${filterNames.join(', ')}`);
        } else {
            const { PERSONAS } = await import('./capturer/personas.js');
            const yt = PERSONAS.filter((p) => p.platform === 'youtube').map((p) => p.displayName);
            console.log(`  Monitorando ${yt.length} canal(is): ${yt.join(', ')}`);
        }
        console.log('  Pressione Ctrl+C para encerrar.');
        console.log('═'.repeat(56));
        console.log('\x1b[0m');

        await startYouTubeMonitor(filterNames);

    } else if (huntMode) {
        // ── Modo Trend Hunter ─────────────────────────────────────────────────
        logger.info('[Orchestrator] Modo Trend Hunter ativado.');
        const targets = await runTrendHunter();
        if (targets.length > 0) {
            logger.info(`[Orchestrator] Top ${targets.length} alvos selecionados. Iniciando captação...`);
            // Grava em output/trendhunter — mesma pasta da persona virtual do
            // poster, para os clipes entrarem no round-robin (nada de órfãos)
            const dummyPersona = { name: 'trendhunter', displayName: 'Trend Hunter', clipsPerRun: 3 };
            for (const target of targets) {
                await capturePersona(dummyPersona, { dynamicTarget: target });
            }
        } else {
            logger.warn('[Orchestrator] Nenhum alvo encontrado pelo Trend Hunter.');
        }
    } else if (liveMode) {
        // ── Modo Monitor de Lives (Twitch) ─────────────────────────────────
        // Importação dinâmica para não carregar ws/axios se não for necessário
        const { startLiveMonitor } = await import('./capturer/live-monitor.js');

        // Filtra personas Twitch se nome(s) fornecido(s)
        const filterNames = namedArgs.length > 0 ? namedArgs : [];

        console.log('\x1b[35m');
        console.log('═'.repeat(56));
        console.log('  📡  CANAL CORTE — Monitor de Lives (Twitch)');
        if (filterNames.length > 0) {
            console.log(`  Monitorando: ${filterNames.join(', ')}`);
        } else {
            const twitch = PERSONAS.filter((p) => p.platform === 'twitch').map((p) => p.displayName);
            console.log(`  Monitorando ${twitch.length} canal(is): ${twitch.join(', ')}`);
        }
        console.log('  Pressione Ctrl+C para encerrar.');
        console.log('═'.repeat(56));
        console.log('\x1b[0m');

        await startLiveMonitor(filterNames);

    } else {
        // ── Modo VOD (YouTube + Twitch arquivado) ─────────────────────────────
        const targetName = namedArgs[0];

        if (targetName) {
            const persona = PERSONAS_MAP[targetName.toLowerCase()];
            if (!persona) {
                const names = PERSONAS.map((p) => p.name).join(', ');
                console.error(`\x1b[31m  ❌  Persona "${targetName}" não encontrada.\x1b[0m`);
                console.error(`  Disponíveis: ${names}`);
                process.exit(1);
            }
            await capturePersona(persona, { force, minClips: 3 });
        } else {
            await captureAll(PERSONAS, { force, minClips: 3 });
        }
    }
}

main().catch((err) => {
    console.error('\x1b[31m  Erro fatal:', err.message, '\x1b[0m');
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
});

