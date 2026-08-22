// start.js — Canal Corte: Inicia todos os serviços em paralelo.
// Exibe logs de cada serviço com cores diferentes em tempo real.
//
// Uso:
//   node start.js                  → Inicia auto-poster + live monitor + yt-monitor + scanner + trend hunter
//   node start.js --no-live        → Sem monitor de lives Twitch
//   node start.js --no-yt-monitor  → Sem monitor YouTube
//   node start.js --no-poster      → Sem auto-poster
//   node start.js --no-hunter      → Sem trend hunter
//   node start.js --no-sports      → Sem sports monitor (canais de futebol)
//   node start.js --no-stock       → Sem stock watcher (reposição automática)
//   node start.js --no-comment-bot → Sem Comment Bot (resposta automática a comentários)
//
// Pressione Ctrl+C para encerrar todos os serviços.

import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';

// ─── Config ───────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const noLive        = args.includes('--no-live');
const noPoster      = args.includes('--no-poster');
const noHunter      = args.includes('--no-hunter');
const noYtMonitor   = args.includes('--no-yt-monitor');
const noWatchdog    = args.includes('--no-watchdog');
const noSports      = args.includes('--no-sports');
const noStock       = args.includes("--no-stock");
const noCommentBot  = args.includes('--no-comment-bot');
const node = process.execPath;

// ─── Instância Única ──────────────────────────────────────────────────────────
// Impede que 2 execuções de start.js rodem ao mesmo tempo. Sem essa trava, cada
// instância sobe seu próprio AUTO-POSTER com os mesmos horários de cron — nos
// horários agendados, cada processo dispara seu próprio ciclo de upload e o
// upload-lock só serializa o navegador, não evita que 2 vídeos diferentes sejam
// publicados em sequência na mesma plataforma no mesmo horário.
const INSTANCE_LOCK_PATH = path.resolve('./scheduler/start.lock');

function isPidAlive(pid) {
    try { process.kill(pid, 0); return true; } catch { return false; }
}

function ensureSingleInstance() {
    try {
        if (fs.existsSync(INSTANCE_LOCK_PATH)) {
            const lock = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, 'utf8'));
            if (lock?.pid && isPidAlive(lock.pid)) {
                console.error(`\x1b[31m❌ Já existe uma instância do CANAL CORTE rodando (PID ${lock.pid}, iniciada em ${lock.startedAt}).\x1b[0m`);
                console.error('\x1b[31m   Encerre esse processo antes de iniciar outro (evita postagens duplicadas).\x1b[0m');
                console.error(`\x1b[31m   Se o processo já morreu e o lock ficou preso, apague: ${INSTANCE_LOCK_PATH}\x1b[0m`);
                process.exit(1);
            }
        }
    } catch { /* lock corrompido — sobrescreve abaixo */ }

    const dir = path.dirname(INSTANCE_LOCK_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(INSTANCE_LOCK_PATH, JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }));
}

function releaseSingleInstanceLock() {
    try {
        const lock = JSON.parse(fs.readFileSync(INSTANCE_LOCK_PATH, 'utf8'));
        if (lock?.pid === process.pid) fs.unlinkSync(INSTANCE_LOCK_PATH);
    } catch { /* já removido ou corrompido — ignora */ }
}

ensureSingleInstance();

// ─── Cores por serviço ────────────────────────────────────────────────────────

const SCAN_HOURS  = parseFloat(process.env.SCAN_INTERVAL_HOURS || '6');
const HUNT_HOURS  = parseFloat(process.env.TREND_HUNT_HOURS    || '12');
const STOCK_MINUTES = parseFloat(process.env.STOCK_CHECK_MINUTES || '30');
const COMMENT_BOT_HOURS = parseFloat(process.env.COMMENT_BOT_HOURS || '24');

const SERVICES = [
    {
        id: 'POSTER',
        label: '📅 AUTO-POSTER',
        color: '\x1b[35m',   // magenta
        cmd: [node, ['poster/index.js']],
        enabled: !noPoster,
        restartDelay: 10_000,
    },
    {
        id: 'LIVE',
        label: '📡 LIVE MONITOR',
        color: '\x1b[36m',   // ciano
        cmd: [node, ['src/orchestrator.js', '--live']],
        enabled: !noLive,
        restartDelay: 15_000,
    },
    {
        id: 'SCANNER',
        label: '🔍 SCANNER',
        color: '\x1b[32m',   // verde
        // O scanner roda uma vez e encerra — o launcher reinicia de SCAN_HOURS em SCAN_HOURS
        cmd: [node, ['src/orchestrator.js']],
        enabled: true,
        restartDelay: SCAN_HOURS * 3600 * 1000,
    },
    {
        id: 'HUNTER',
        label: '🎯 TREND HUNTER',
        color: '\x1b[33m',   // amarelo
        // Busca conteúdo viral em canais configurados e gera clipes automaticamente
        cmd: [node, ['src/orchestrator.js', '--hunt']],
        enabled: !noHunter,
        restartDelay: HUNT_HOURS * 3600 * 1000,
    },
    {
        id: 'YT-MONITOR',
        label: '📺 YT MONITOR',
        color: '\x1b[34m',   // azul
        // Polling continuo dos canais YouTube das personas — detecta VODs novos em ~10min
        cmd: [node, ['src/orchestrator.js', '--youtube-monitor']],
        enabled: !noYtMonitor,
        restartDelay: 15_000,
    },
    {
        id: 'SPORTS-MONITOR',
        label: '⚽ SPORTS MONITOR',
        color: '\x1b[32m',   // verde
        // Polling continuo dos canais de futebol (sports-channels.js) — detecta
        // jogos completos novos e minera gols via chat replay/heatmap automaticamente.
        cmd: [node, ['src/orchestrator.js', '--sports-monitor']],
        enabled: !noSports,
        restartDelay: 15_000,
    },
    {
        id: 'STOCK',
        label: '📦 STOCK WATCHER',
        color: '\x1b[33m',   // amarelo
        // Vigia de estoque: confere o nível de conteúdo de todas as fontes
        // (personas, Canal da Fé, Trend Hunter, vídeos longos) e repõe o que
        // estiver abaixo do mínimo (STOCK_MIN_*). Roda uma vez e encerra —
        // reinicia a cada STOCK_CHECK_MINUTES (padrão 30min).
        cmd: [node, ['src/stock-watcher.js']],
        enabled: !noStock,
        restartDelay: STOCK_MINUTES * 60 * 1000,
    },
    {
        id: 'COMMENT-BOT',
        label: '💬 COMMENT BOT',
        color: '\x1b[36m',   // ciano
        // Responde comentários novos do YouTube automaticamente via API (sem
        // navegador/perfil Playwright) — ver COMMENT_BOT_* no .env. Começa em
        // dry-run por padrão (COMMENT_BOT_DRY_RUN=true) até ser validado.
        // Roda 1 passada e encerra (--once) — o launcher reinicia de
        // COMMENT_BOT_HOURS em COMMENT_BOT_HOURS (padrão 24h = 1x/dia),
        // mesmo padrão do Scanner/Trend Hunter/Stock Watcher acima.
        cmd: [node, ['src/orchestrator.js', '--comment-monitor', '--once']],
        enabled: !noCommentBot,
        restartDelay: COMMENT_BOT_HOURS * 3600 * 1000,
    },
    {
        id: 'WATCHDOG',
        label: '⚽ WATCHDOG',
        color: '\x1b[32m',   // verde
        // Agenda esportiva: consulta o banco a cada 10min e spawna o Radar
        // automaticamente quando um jogo agendado começa.
        // Para agendar: npm run radar:add -- "@CazeTV" youtube "2025-06-20 21:00" 4
        cmd: [node, ['src/capturer/watchdog.js']],
        enabled: !noWatchdog,
        restartDelay: 30_000,
    },
];

const RESET = '\x1b[0m';
const DIM = '\x1b[2m';
const BOLD = '\x1b[1m';
const GREEN = '\x1b[32m';
const RED = '\x1b[31m';
const YELLOW = '\x1b[33m';

// ─── Logger ───────────────────────────────────────────────────────────────────

function ts() {
    return new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
}

function log(color, label, line) {
    const prefix = `${DIM}[${ts()}]${RESET} ${color}${BOLD}[${label}]${RESET} `;
    process.stdout.write(prefix + line + '\n');
}

function sysLog(msg, color = YELLOW) {
    process.stdout.write(`\n${DIM}[${ts()}]${RESET} ${color}${BOLD}[SISTEMA]${RESET} ${msg}\n\n`);
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(active) {
    const line = '═'.repeat(60);
    console.log(`\n\x1b[35m${line}\x1b[0m`);
    console.log('\x1b[35m\x1b[1m  🎬  CANAL CORTE — Central de Operações\x1b[0m');
    console.log(`\x1b[35m  Serviços ativos: ${active.map((s) => s.label).join('  |  ')}\x1b[0m`);
    console.log(`\x1b[35m  Iniciado em: ${new Date().toLocaleString('pt-BR')}\x1b[0m`);
    console.log(`\x1b[35m  Pressione Ctrl+C para encerrar tudo.\x1b[0m`);
    console.log(`\x1b[35m${line}\x1b[0m\n`);
}

// ─── Process Manager ──────────────────────────────────────────────────────────

const processes = new Map(); // id → ChildProcess
let shuttingDown = false;

function startService(service) {
    if (shuttingDown) return;

    const [exe, cliArgs] = service.cmd;
    const proc = spawn(exe, cliArgs, {
        cwd: path.resolve('.'),
        env: { ...process.env },
        stdio: ['ignore', 'pipe', 'pipe'],
    });

    processes.set(service.id, proc);
    sysLog(`${service.label} iniciado (PID ${proc.pid})`, service.color);

    // Prefixed stdout
    proc.stdout.on('data', (data) => {
        data.toString().split('\n').forEach((line) => {
            if (line.trim()) log(service.color, service.id, line);
        });
    });

    // Prefixed stderr (mesma cor, mais dimmed)
    proc.stderr.on('data', (data) => {
        data.toString().split('\n').forEach((line) => {
            if (line.trim()) log(service.color + DIM, service.id, line);
        });
    });

    proc.on('close', (code) => {
        if (shuttingDown) return;
        const icon = code === 0 ? '✅' : '⚠️';
        const delay = service.restartDelay;
        sysLog(
            `${icon} ${service.label} encerrou (código ${code ?? '??'}). Reiniciando em ${delay / 1000}s...`,
            code === 0 ? GREEN : YELLOW
        );
        // NUNCA encerra o processo pai — reinicia o serviço filho sempre
        setTimeout(() => startService(service), delay);
    });

    proc.on('error', (err) => {
        sysLog(`${RED}❌ Erro ao iniciar ${service.label}: ${err.message}`, RED);
    });
}

// ─── Graceful Shutdown ────────────────────────────────────────────────────────

function shutdown() {
    if (shuttingDown) return;
    shuttingDown = true;

    sysLog('Encerrando todos os serviços...', RED);

    for (const [id, proc] of processes) {
        try {
            sysLog(`Encerrando ${id} (PID ${proc.pid})...`, DIM);
            proc.kill('SIGTERM');
        } catch { /* já encerrado */ }
    }

    setTimeout(() => {
        releaseSingleInstanceLock();
        sysLog('Tudo encerrado. Até logo!');
        process.exit(0);
    }, 2000);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('uncaughtException', (err) => {
    sysLog(`Erro fatal no launcher: ${err.message}`, RED);
    console.error(err);
});

// ─── Status periódico ─────────────────────────────────────────────────────────

function printStatus() {
    if (shuttingDown) return;

    const OUTPUT_DIR = path.resolve('./output');
    const STATE_FILE = path.resolve('./scheduler/queue-state.json');

    let clips = {};
    try {
        function countMp4s(dir) {
            let n = 0;
            for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
                if (e.isDirectory()) n += countMp4s(path.join(dir, e.name));
                else if (e.isFile() && e.name.toLowerCase().endsWith('.mp4')) n++;
            }
            return n;
        }
        const dirs = fs.readdirSync(OUTPUT_DIR, { withFileTypes: true }).filter((d) => d.isDirectory());
        for (const d of dirs) {
            const count = countMp4s(path.join(OUTPUT_DIR, d.name));
            if (count > 0) clips[d.name] = count;
        }
    } catch { /* sem output ainda */ }

    let state = {};
    try { state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8')); } catch { /* ok */ }

    const clipStr = Object.keys(clips).length > 0
        ? Object.entries(clips).map(([k, n]) => `${k}:${n}`).join(' | ')
        : 'nenhum';

    const nextPersona = state.lastPersona ?? '—';

    console.log('');
    console.log(`\x1b[2m${'─'.repeat(60)}\x1b[0m`);
    console.log(`\x1b[2m  📊 STATUS  [${ts()}]\x1b[0m`);
    console.log(`\x1b[2m  Clipes disponíveis: ${clipStr}\x1b[0m`);
    console.log(`\x1b[2m  Última persona postada: ${nextPersona} | Índice: ${state.index ?? 0}\x1b[0m`);
    console.log(`\x1b[2m${'─'.repeat(60)}\x1b[0m\n`);
}

// ─── Main ─────────────────────────────────────────────────────────────────────

const active = SERVICES.filter((s) => s.enabled);

if (active.length === 0) {
    console.error('❌ Nenhum serviço habilitado. Use sem --no-live e --no-poster.');
    process.exit(1);
}

printBanner(active);

// Inicia cada serviço com delay escalonado para não sobrecarregar no boot
active.forEach((service, i) => {
    setTimeout(() => startService(service), i * 3000);
});

// Exibe status resumido a cada 15 minutos
setInterval(printStatus, 15 * 60 * 1000);

// Status imediato após 10s (quando serviços já estão rodando)
setTimeout(printStatus, 10_000);
