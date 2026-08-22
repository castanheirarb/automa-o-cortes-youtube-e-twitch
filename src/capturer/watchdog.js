// src/capturer/watchdog.js
// Orquestrador Autônomo da Agenda Esportiva.
//
// Funciona como um "Cão de Guarda" que:
//   1. Consulta o banco (SQLite via Prisma) a cada 10 minutos
//   2. Detecta eventos PENDING que começam nos próximos 15 minutos
//   3. Resolve a URL da live dinamicamente (sem .env estático)
//   4. Spawna sports-radar.js com todas as variáveis injetadas via env
//   5. Mata o processo automaticamente após (expectedDurationHours + 30min)
//   6. Atualiza o status no banco em cada transição
//
// Uso:
//   npm run radar:watchdog
//
// Para adicionar eventos à agenda:
//   npm run radar:add -- "@CazeTV" youtube "2025-06-20 21:00" 4 300 "gol,golaço,pqp"

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';
import { spawn }        from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path              from 'node:path';
import { logger }        from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const prisma    = new PrismaClient();

// ─── Constantes ───────────────────────────────────────────────────────────────

const POLL_INTERVAL_MS = 10 * 60 * 1000; // polling a cada 10 min
const START_WINDOW_MS  = 15 * 60 * 1000; // spawna se o evento começa em ≤ 15 min
const EARLY_START_MS   =  5 * 60 * 1000; // aceita eventos até 5 min atrasados
const GRACE_PERIOD_MS  = 30 * 60 * 1000; // tolerância após fim previsto do jogo

/** Map: scheduleId → { child: ChildProcess, killTimer: NodeJS.Timeout } */
const activeProcesses = new Map();

// ─── Resolução de URL ─────────────────────────────────────────────────────────
//
// YouTube live: https://www.youtube.com/@CazeTV/live
//   Funciona tanto para @alias quanto para URLs canônicas.
//   O yt-dlp resolve a URL da live automaticamente a partir do /live endpoint.
//
// Twitch live:  https://www.twitch.tv/gaules
//   O yt-dlp e o youtube-chat não monitoram Twitch chat nativamente —
//   para Twitch, o Radar usa apenas a captura DVR (sem chat), configurando
//   RADAR_SPIKE_THRESHOLD=0 para entrar em modo de captura por tempo fixo.

function resolveLiveUrl(channelAlias, platform) {
    if (platform === 'youtube') {
        const alias = channelAlias.startsWith('@') ? channelAlias : `@${channelAlias}`;
        return `https://www.youtube.com/${alias}/live`;
    }
    if (platform === 'twitch') {
        const login = channelAlias.replace(/^@/, '').toLowerCase();
        return `https://www.twitch.tv/${login}`;
    }
    throw new Error(`Plataforma desconhecida: "${platform}". Use "youtube" ou "twitch".`);
}

// ─── Spawn do Radar ───────────────────────────────────────────────────────────

function spawnRadar(schedule, liveUrl) {
    const radarScript = path.join(__dirname, 'sports-radar.js');

    // Toda a config é injetada via env — o sports-radar.js não lê o .env estático
    // quando RADAR_WATCHDOG_MODE=1 (dotenv.config({ override: false }) não sobrescreve)
    const injectedEnv = {
        ...process.env,                                          // herda PATH, FFMPEG_PATH etc.
        LIVE_SPORTS_URL:         liveUrl,
        RADAR_SPIKE_THRESHOLD:   String(schedule.baseThreshold),
        RADAR_KEYWORDS:          schedule.keywords,
        RADAR_SPIKE_WINDOW_MS:   '15000',
        RADAR_COOLDOWN_MS:       '120000',
        RADAR_CLIP_BEFORE_SEC:   '150',
        RADAR_CLIP_AFTER_SEC:    '30',
        RADAR_STREAM_OFFSET_SEC: '0',
        RADAR_OUTPUT_DIR:        path.resolve(`./output/sports-radar/${schedule.id}`),
        RADAR_WATCHDOG_MODE:     '1',
        RADAR_SCHEDULE_ID:       String(schedule.id),
    };

    logger.step(
        `[Watchdog] Spawnando Radar — Schedule #${schedule.id} | ` +
        `${schedule.channelAlias} (${schedule.platform})`
    );
    logger.info(`[Watchdog] URL: ${liveUrl}`);
    logger.info(`[Watchdog] Threshold: ${schedule.baseThreshold} | Keywords: ${schedule.keywords}`);

    // spawn com stdio:inherit → logs do radar aparecem no mesmo terminal
    const child = spawn(process.execPath, [radarScript], {
        env:   injectedEnv,
        stdio: 'inherit',
    });

    child.on('error', (err) => {
        logger.error(`[Watchdog] Erro ao iniciar radar #${schedule.id}: ${err.message}`);
    });

    child.on('close', async (code, signal) => {
        logger.info(
            `[Watchdog] Radar #${schedule.id} encerrado ` +
            `(code: ${code ?? '-'}, signal: ${signal ?? '-'})`
        );
        cleanupEntry(schedule.id);

        const finalStatus = (code === 0 || signal === 'SIGTERM') ? 'COMPLETED' : 'FAILED';
        await markStatus(schedule.id, finalStatus).catch(() => {});
    });

    return child;
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

function scheduleAutoKill(scheduleId, durationMs) {
    return setTimeout(async () => {
        logger.info(
            `[Watchdog] Tempo esgotado para schedule #${scheduleId} ` +
            `— encerrando radar automaticamente.`
        );
        await killSchedule(scheduleId, 'COMPLETED');
    }, durationMs);
}

async function killSchedule(scheduleId, finalStatus = 'COMPLETED') {
    const entry = activeProcesses.get(scheduleId);
    if (!entry) return;

    clearTimeout(entry.killTimer);

    if (entry.child && !entry.child.killed) {
        entry.child.kill('SIGTERM');
        // SIGKILL de segurança após 10s caso SIGTERM seja ignorado
        setTimeout(() => {
            if (entry.child && !entry.child.killed) {
                entry.child.kill('SIGKILL');
            }
        }, 10_000);
    }

    cleanupEntry(scheduleId);
    await markStatus(scheduleId, finalStatus).catch(() => {});
}

function cleanupEntry(scheduleId) {
    const entry = activeProcesses.get(scheduleId);
    if (entry) clearTimeout(entry.killTimer);
    activeProcesses.delete(scheduleId);
}

// ─── DB helpers ───────────────────────────────────────────────────────────────

async function markStatus(id, status, extra = {}) {
    await prisma.liveSchedule
        .update({ where: { id }, data: { status, ...extra } })
        .catch(() => {});
}

async function resetStaleWatching() {
    // Na inicialização, eventos WATCHING são de uma run anterior — perdemos o PID.
    // Voltam para PENDING para serem re-avaliados no próximo poll.
    const stale = await prisma.liveSchedule.findMany({ where: { status: 'WATCHING' } });
    if (stale.length > 0) {
        logger.warn(
            `[Watchdog] ${stale.length} evento(s) WATCHING sem processo ativo — ` +
            `resetando para PENDING.`
        );
        await prisma.liveSchedule.updateMany({
            where: { status: 'WATCHING' },
            data:  { status: 'PENDING', spawnedPid: null },
        });
    }
}

// ─── Ciclo de Polling ─────────────────────────────────────────────────────────

async function poll() {
    const now       = new Date();
    const windowEnd = new Date(now.getTime() + START_WINDOW_MS);
    const windowBeg = new Date(now.getTime() - EARLY_START_MS); // tolera 5 min atrasados

    const upcoming = await prisma.liveSchedule.findMany({
        where: {
            status:             'PENDING',
            scheduledStartTime: { gte: windowBeg, lte: windowEnd },
        },
        orderBy: { scheduledStartTime: 'asc' },
    });

    for (const schedule of upcoming) {
        if (activeProcesses.has(schedule.id)) continue; // já rodando

        let liveUrl;
        try {
            liveUrl = resolveLiveUrl(schedule.channelAlias, schedule.platform);
        } catch (err) {
            logger.error(`[Watchdog] Schedule #${schedule.id}: ${err.message}`);
            await markStatus(schedule.id, 'FAILED');
            continue;
        }

        const child     = spawnRadar(schedule, liveUrl);
        const totalMs   = schedule.expectedDurationHours * 3_600_000 + GRACE_PERIOD_MS;
        const killTimer = scheduleAutoKill(schedule.id, totalMs);

        activeProcesses.set(schedule.id, { child, killTimer });
        await markStatus(schedule.id, 'WATCHING', { spawnedPid: child.pid ?? null });

        const killInMin = Math.round(totalMs / 60_000);
        logger.success(
            `[Watchdog] Radar #${schedule.id} ativo (PID ${child.pid}) — ` +
            `auto-kill em ${killInMin}min`
        );
    }

    // Status log periódico
    const active = activeProcesses.size;
    if (active > 0) {
        logger.info(`[Watchdog] Processos radar ativos: ${active}`);
    } else {
        logger.info('[Watchdog] Nenhum radar ativo no momento.');
    }
}

// ─── Shutdown Gracioso ────────────────────────────────────────────────────────

async function gracefulShutdown(signal) {
    logger.info(`[Watchdog] ${signal} recebido — encerrando ${activeProcesses.size} radar(es)...`);

    for (const [id] of activeProcesses) {
        // Volta para PENDING: o watchdog pode retomar na próxima inicialização
        await killSchedule(id, 'PENDING');
    }

    await prisma.$disconnect();
    process.exit(0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    const pollMin  = POLL_INTERVAL_MS / 60_000;
    const winMin   = START_WINDOW_MS  / 60_000;

    console.log('\n\x1b[36m' + '═'.repeat(62) + '\x1b[0m');
    console.log('\x1b[36m  WATCHDOG — Agenda Esportiva CorteCerto\x1b[0m');
    console.log(`\x1b[36m  Polling: a cada ${pollMin}min | Janela de início: ${winMin}min\x1b[0m`);
    console.log(`\x1b[36m  Tolerância pós-jogo: ${GRACE_PERIOD_MS / 60_000}min\x1b[0m`);
    console.log('\x1b[36m' + '═'.repeat(62) + '\x1b[0m\n');

    await prisma.$connect();
    logger.success('[Watchdog] Banco de dados conectado (SQLite).');

    // Reset de eventos órfãos da run anterior
    await resetStaleWatching();

    // Mostra agenda carregada
    const allPending = await prisma.liveSchedule.findMany({
        where:   { status: 'PENDING' },
        orderBy: { scheduledStartTime: 'asc' },
    });
    if (allPending.length > 0) {
        logger.info(`[Watchdog] ${allPending.length} evento(s) PENDING na agenda:`);
        for (const s of allPending) {
            logger.info(
                `  #${s.id} ${s.channelAlias} (${s.platform}) — ` +
                `${s.scheduledStartTime.toLocaleString('pt-BR')} | ` +
                `${s.expectedDurationHours}h | threshold: ${s.baseThreshold}`
            );
        }
    } else {
        logger.warn('[Watchdog] Agenda vazia. Use "npm run radar:add" para agendar eventos.');
    }

    // Primeiro poll imediato
    await poll().catch((err) => logger.error(`[Watchdog] Poll error: ${err.message}`));

    // Polling periódico
    setInterval(async () => {
        await poll().catch((err) => logger.error(`[Watchdog] Poll error: ${err.message}`));
    }, POLL_INTERVAL_MS);

    process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
    process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
    process.on('uncaughtException', (err) => {
        logger.error(`[Watchdog] Uncaught exception: ${err.message}`);
    });

    logger.info('[Watchdog] Aguardando eventos agendados. Pressione Ctrl+C para encerrar.');
}

main().catch((err) => {
    console.error('\x1b[31m[Watchdog] Fatal:', err.message, '\x1b[0m');
    process.exit(1);
});
