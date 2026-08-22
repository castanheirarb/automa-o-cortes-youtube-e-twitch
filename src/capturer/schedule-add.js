// src/capturer/schedule-add.js
// CLI para gerenciar a Agenda Esportiva do Watchdog.
//
// Adicionar evento:
//   npm run radar:add -- "@CazeTV" youtube "2025-06-20 21:00" 4 300 "gol,golaço,pqp"
//   npm run radar:add -- "gaules"  twitch "2025-06-22 13:00" 5  80 "gol,clutch"
//
//   Argumentos (em ordem):
//     1. channelAlias       Ex: "@CazeTV" ou "gaules"
//     2. platform           "youtube" | "twitch"
//     3. startTime          "YYYY-MM-DD HH:MM"  (horário de Brasília)
//     4. durationHours      (opcional, padrão: 3)
//     5. threshold          (opcional, padrão: 50)
//     6. keywords           (opcional, padrão: "gol,golaço,goool,pqp")
//
// Listar eventos:
//   npm run radar:list
//
// Cancelar evento:
//   npm run radar:cancel -- 3     (ID do evento)

import 'dotenv/config';
import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

// ─── Helpers ──────────────────────────────────────────────────────────────────

function pad(v, w = 20) {
    return String(v ?? '—').padEnd(w);
}

const STATUS_COLORS = {
    PENDING:   '\x1b[33m',  // amarelo
    WATCHING:  '\x1b[32m',  // verde
    COMPLETED: '\x1b[90m',  // cinza
    FAILED:    '\x1b[31m',  // vermelho
};
const RESET = '\x1b[0m';

function colorStatus(s) {
    return `${STATUS_COLORS[s] ?? ''}${s}${RESET}`;
}

// ─── Comandos ─────────────────────────────────────────────────────────────────

async function cmdAdd(args) {
    const [alias, platform, startStr, durStr, threshStr, keywords] = args;

    if (!alias || !platform || !startStr) {
        console.error(
            '\nUso: npm run radar:add -- "<alias>" <platform> "<YYYY-MM-DD HH:MM>" ' +
            '[durationHours] [threshold] ["keywords"]'
        );
        console.error('  Ex: npm run radar:add -- "@CazeTV" youtube "2025-06-20 21:00" 4 300 "gol,golaço"');
        process.exit(1);
    }

    if (platform !== 'youtube' && platform !== 'twitch') {
        console.error(`Plataforma inválida: "${platform}". Use "youtube" ou "twitch".`);
        process.exit(1);
    }

    const startTime = new Date(startStr);
    if (isNaN(startTime)) {
        console.error(`Data/hora inválida: "${startStr}". Use o formato "YYYY-MM-DD HH:MM".`);
        process.exit(1);
    }

    const schedule = await prisma.liveSchedule.create({
        data: {
            channelAlias:         alias,
            platform,
            scheduledStartTime:   startTime,
            expectedDurationHours: parseInt(durStr    || '3',  10),
            baseThreshold:         parseInt(threshStr || '50', 10),
            keywords:              keywords || 'gol,golaço,goool,pqp,vaaai',
            status:                'PENDING',
        },
    });

    const startLocal = schedule.scheduledStartTime.toLocaleString('pt-BR', {
        dateStyle: 'short', timeStyle: 'short',
    });
    const endMs  = schedule.scheduledStartTime.getTime() + schedule.expectedDurationHours * 3_600_000;
    const endLocal = new Date(endMs).toLocaleString('pt-BR', { timeStyle: 'short' });

    console.log(`\n\x1b[32m✅ Evento agendado!\x1b[0m`);
    console.log(`   ID        : ${schedule.id}`);
    console.log(`   Canal     : ${schedule.channelAlias} (${schedule.platform})`);
    console.log(`   Início    : ${startLocal} → ~${endLocal} (+${schedule.expectedDurationHours}h)`);
    console.log(`   Threshold : ${schedule.baseThreshold} msgs/15s`);
    console.log(`   Keywords  : ${schedule.keywords}`);
    console.log(`\n   O Watchdog spawnará o Radar automaticamente 15min antes do início.\n`);
}

async function cmdList() {
    const all = await prisma.liveSchedule.findMany({
        orderBy: { scheduledStartTime: 'asc' },
    });

    if (all.length === 0) {
        console.log('\n  Agenda vazia. Use "npm run radar:add" para agendar eventos.\n');
        return;
    }

    console.log('\n' + '─'.repeat(90));
    console.log(
        `  ${pad('ID', 4)}${pad('Canal', 18)}${pad('Plataforma', 10)}` +
        `${pad('Início', 20)}${pad('Duração', 10)}${pad('Threshold', 11)}Status`
    );
    console.log('─'.repeat(90));

    for (const s of all) {
        const dt = s.scheduledStartTime.toLocaleString('pt-BR', {
            dateStyle: 'short', timeStyle: 'short',
        });
        console.log(
            `  ${pad(s.id, 4)}${pad(s.channelAlias, 18)}${pad(s.platform, 10)}` +
            `${pad(dt, 20)}${pad(`${s.expectedDurationHours}h`, 10)}${pad(s.baseThreshold, 11)}` +
            colorStatus(s.status)
        );
    }
    console.log('─'.repeat(90) + '\n');
}

async function cmdCancel(args) {
    const id = parseInt(args[0], 10);
    if (isNaN(id)) {
        console.error('Uso: npm run radar:cancel -- <ID>');
        process.exit(1);
    }

    const schedule = await prisma.liveSchedule.findUnique({ where: { id } });
    if (!schedule) {
        console.error(`Evento #${id} não encontrado.`);
        process.exit(1);
    }

    if (schedule.status === 'WATCHING') {
        console.error(
            `Evento #${id} está WATCHING (PID ${schedule.spawnedPid ?? '?'}). ` +
            `O Watchdog vai encerrá-lo no próximo ciclo após a atualização do status.`
        );
    }

    await prisma.liveSchedule.update({ where: { id }, data: { status: 'FAILED' } });
    console.log(`\n  Evento #${id} (${schedule.channelAlias}) marcado como FAILED/cancelado.\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    // O modo é determinado pelo script npm que chamou este arquivo.
    // npm define process.env.npm_lifecycle_event automaticamente:
    //   "radar:add"    → adiciona
    //   "radar:list"   → lista
    //   "radar:cancel" → cancela

    const lifecycle = process.env.npm_lifecycle_event || 'radar:add';
    const cmd = lifecycle.split(':')[1] || 'add'; // "radar:list" → "list"
    const args = process.argv.slice(2);

    await prisma.$connect();

    try {
        if (cmd === 'list')        await cmdList();
        else if (cmd === 'cancel') await cmdCancel(args);
        else                       await cmdAdd(args);
    } finally {
        await prisma.$disconnect();
    }
}

main().catch(async (err) => {
    console.error('\x1b[31mErro:', err.message, '\x1b[0m');
    await prisma.$disconnect();
    process.exit(1);
});
