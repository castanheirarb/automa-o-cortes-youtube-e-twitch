#!/usr/bin/env node
// cli.js — Interface de linha de comando para o Canal Corte.
// Permite capturar vídeos, postar e gerenciar a fila via terminal interativo.
//
// Uso:
//   node cli.js              → Menu interativo
//   node cli.js capture      → Captura todas as personas
//   node cli.js capture brino → Captura uma persona específica
//   node cli.js capture --force → Re-capta mesmo com clipes existentes
//   node cli.js post [--youtube-only|--tiktok-only]
//   node cli.js status       → Mostra estado da fila

import 'dotenv/config';
import readline from 'node:readline';
import path from 'node:path';
import fs from 'node:fs';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

// ─── Cores ANSI ───────────────────────────────────────────────────────────────

const C = {
    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    purple: '\x1b[35m',
    cyan: '\x1b[36m',
    green: '\x1b[32m',
    yellow: '\x1b[33m',
    red: '\x1b[31m',
    blue: '\x1b[34m',
};

const c = (color, text) => `${C[color]}${text}${C.reset}`;

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner() {
    const line = '═'.repeat(58);
    console.log(`\n${c('purple', line)}`);
    console.log(c('purple', '  🎬  CANAL CORTE — Centro de Controle'));
    console.log(c('purple', '  Captura • Processa • Posta • Monitora'));
    console.log(`${c('purple', line)}\n`);
}

// ─── Status da fila ───────────────────────────────────────────────────────────

function showStatus() {
    const STATE_FILE = path.resolve('./scheduler/queue-state.json');
    const OUTPUT_DIR = path.resolve('./output');
    const POSTED_DIR = path.resolve('./postados');

    console.log(`\n${c('cyan', '─── Estado da Fila (Round-Robin) ───────────────────────────────')}`);

    // Estado do round-robin
    try {
        const state = JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        console.log(`  Índice global  : ${c('yellow', String(state.index))}`);
        console.log(`  Última persona : ${c('yellow', state.lastPersona ?? 'nenhuma')}`);
        console.log(`  Último post    : ${c('yellow', state.lastPost ? new Date(state.lastPost).toLocaleString('pt-BR') : 'nunca')}`);
    } catch {
        console.log(`  ${c('dim', 'Estado não encontrado (nenhum post realizado ainda)')}`);
    }

    // Clipes disponíveis por persona (lê dinamicamente do personas.js)
    console.log(`\n${c('cyan', '─── Clipes por Persona ─────────────────────────────────────────')}`);
    const PERSONAS_FILE = path.resolve('./src/capturer/personas.js');
    let personaNames = ['cariani', 'brino', 'bistocone']; // fallback
    try {
        const src = fs.readFileSync(PERSONAS_FILE, 'utf-8');
        const matches = [...src.matchAll(/name:\s*['"]([^'"]+)['"]/g)];
        if (matches.length > 0) personaNames = matches.map((m) => m[1]);
    } catch { /* usa fallback */ }

    for (const name of personaNames) {
        const dir = path.join(OUTPUT_DIR, name);
        let count = 0;
        try {
            count = fs.readdirSync(dir).filter((f) => f.endsWith('.mp4')).length;
        } catch { /* pasta não existe */ }
        const bar = count > 0 ? c('green', '●'.repeat(Math.min(count, 10))) : c('red', '○');
        console.log(`  ${name.padEnd(12)} ${bar} ${c('yellow', String(count))} clipe(s)`);
    }

    // Registry
    const REGISTRY = path.join(POSTED_DIR, 'registry.json');
    try {
        const posted = JSON.parse(fs.readFileSync(REGISTRY, 'utf-8'));
        console.log(`\n${c('cyan', '─── Registry (Deduplicação) ────────────────────────────────────')}`);
        console.log(`  Vídeos já postados: ${c('yellow', String(posted.length))}`);
        if (posted.length > 0) {
            console.log(`  Últimos 3: ${posted.slice(-3).map((f) => c('dim', f)).join(', ')}`);
        }
    } catch { /* registry vazio */ }

    console.log('');
}

// ─── Executa um sub-processo com output ao vivo ───────────────────────────────

async function runLive(command, args, cwd = process.cwd()) {
    return new Promise((resolve, reject) => {
        const proc = execFile(command, args, {
            cwd,
            shell: false,
            env: { ...process.env },
        });

        proc.stdout.pipe(process.stdout);
        proc.stderr.pipe(process.stderr);

        proc.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Processo encerrou com código ${code}`));
        });
    });
}

function nodeCmd() {
    return process.execPath; // node.exe atual
}

// ─── Ações ────────────────────────────────────────────────────────────────────

async function cmdCapture(args) {
    const force = args.includes('--force');
    const target = args.find((a) => !a.startsWith('-'));

    const nodeArgs = ['src/orchestrator.js'];
    if (target) nodeArgs.push(target);
    if (force) nodeArgs.push('--force');

    console.log(`\n${c('purple', '🎬 Iniciando captação...')}`);
    await runLive(nodeCmd(), nodeArgs);
}

async function cmdPost(args) {
    const extraFlags = args.filter((a) => a.startsWith('--'));
    console.log(`\n${c('purple', '📤 Postando próximo vídeo da fila...')}`);
    await runLive(nodeCmd(), ['poster/index.js', '--now', ...extraFlags]);
}

async function cmdCut(args) {
    const url = args[0];
    const qty = args[1] || '5';
    if (!url) {
        console.error(c('red', '  ❌ Uso: cut <URL_DO_VIDEO> [quantidade_de_clipes]'));
        return;
    }
    console.log(`\n${c('purple', `✂️  Cortando ${qty} clipes de: ${url}`)}`);
    await runLive(nodeCmd(), ['src/index.js', url, qty]);
}

// ─── Menu interativo ──────────────────────────────────────────────────────────

async function interactiveMenu() {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const ask = (q) => new Promise((res) => rl.question(q, res));

    while (true) {
        console.log(`${c('cyan', '─── O que deseja fazer? ────────────────────────────────────────')}`);
        console.log(`  ${c('yellow', '1')} — ${c('bold', 'Capturar')} vídeos de todas as personas`);
        console.log(`  ${c('yellow', '2')} — ${c('bold', 'Capturar')} uma persona específica`);
        console.log(`  ${c('yellow', '3')} — ${c('bold', 'Cortar')} a partir de uma URL direta`);
        console.log(`  ${c('yellow', '4')} — ${c('bold', 'Postar')} próximo vídeo da fila agora`);
        console.log(`  ${c('yellow', '5')} — ${c('bold', 'Postar')} só no YouTube`);
        console.log(`  ${c('yellow', '6')} — ${c('bold', 'Postar')} só no TikTok`);
        console.log(`  ${c('yellow', '7')} — ${c('bold', 'Status')} da fila e clipes disponíveis`);
        console.log(`  ${c('yellow', '8')} — ${c('bold', 'Iniciar')} auto-poster agendado (4x ao dia)`);
        console.log(`  ${c('yellow', '9')} — ${c('bold', 'Monitor de Lives')} Twitch (loop contínuo)`);
        console.log(`  ${c('yellow', '0')} — Sair\n`);

        const choice = (await ask(`  Opção: `)).trim();

        console.log('');
        try {
            if (choice === '1') {
                await cmdCapture([]);
            } else if (choice === '2') {
                const persona = (await ask(`  Persona (cariani/brino/bistocone): `)).trim().toLowerCase();
                const force = (await ask(`  Forçar re-captação? (s/n): `)).trim().toLowerCase() === 's';
                await cmdCapture([persona, ...(force ? ['--force'] : [])]);
            } else if (choice === '3') {
                const url = (await ask(`  URL do vídeo: `)).trim();
                const qty = (await ask(`  Quantidade de clipes (padrão 5): `)).trim() || '5';
                await cmdCut([url, qty]);
            } else if (choice === '4') {
                await cmdPost([]);
            } else if (choice === '5') {
                await cmdPost(['--youtube-only']);
            } else if (choice === '6') {
                await cmdPost(['--tiktok-only']);
            } else if (choice === '7') {
                showStatus();
            } else if (choice === '8') {
                rl.close();
                console.log(c('purple', '\n📅 Iniciando auto-poster agendado... (Ctrl+C para encerrar)\n'));
                await runLive(nodeCmd(), ['poster/index.js']);
                return;
            } else if (choice === '9') {
                const persona = (await ask(`  Canal específico? (deixe vazio para todos): `)).trim().toLowerCase();
                rl.close();
                const args = ['src/orchestrator.js', '--live'];
                if (persona) args.push(persona);
                console.log(c('purple', '\n📡 Iniciando monitor de lives... (Ctrl+C para encerrar)\n'));
                await runLive(nodeCmd(), args);
                return;
            } else if (choice === '0') {
                console.log(c('dim', '\n  Até logo!\n'));
                rl.close();
                return;
            } else {
                console.log(c('red', `  Opção inválida: "${choice}"\n`));
            }
        } catch (err) {
            console.error(c('red', `\n  ❌ Erro: ${err.message}\n`));
        }
    }
}

// ─── Organização dos arquivos ─────────────────────────────────────────────────

function showHelp() {
    console.log(`
${c('cyan', 'ORGANIZAÇÃO DAS PASTAS')}

  ${c('yellow', './output/')}                  → Clipes prontos para postar
  ${c('yellow', './output/cariani/')}           → Clipes da persona Renato Cariani
  ${c('yellow', './output/brino/')}             → Clipes da persona Brino (BruninZor)
  ${c('yellow', './output/bistocone/')}         → Clipes da persona Bistocone (Marco Sarcone)
  ${c('yellow', './postados/')}                 → Clipes já postados (movidos após upload)
  ${c('yellow', './postados/registry.json')}    → Lista de arquivos já postados (deduplicação)
  ${c('yellow', './scheduler/queue-state.json')} → Estado do round-robin (índice atual)
  ${c('yellow', './profiles/')}                 → Perfis do Playwright (sessões de login)

${c('cyan', 'COMANDOS DIRETOS (npm run ou node)')}

  ${c('green', 'node cli.js')}                 → Menu interativo (recomendado)
  ${c('green', 'npm run capture')}             → Captura todas as personas
  ${c('green', 'npm run capture:force')}       → Re-captura forçada
  ${c('green', 'npm run poster:now')}          → Posta agora (round-robin)
  ${c('green', 'npm run poster')}              → Auto-poster 4x ao dia
  ${c('green', 'npm run cut -- URL [N]')}      → Corta N clipes de uma URL direta

${c('cyan', 'EXEMPLOS')}

  node cli.js
  node cli.js capture
  node cli.js capture brino --force
  node cli.js post --youtube-only
  node cli.js status
  node src/index.js "https://youtube.com/watch?v=ID" 5
`);
}

// ─── Entrada ──────────────────────────────────────────────────────────────────

async function main() {
    printBanner();

    const args = process.argv.slice(2);
    const cmd = args[0];

    try {
        if (!cmd || cmd === 'help' || cmd === '--help') {
            if (!cmd) {
                showHelp();
                await interactiveMenu();
            } else {
                showHelp();
            }
        } else if (cmd === 'capture') {
            await cmdCapture(args.slice(1));
        } else if (cmd === 'post') {
            await cmdPost(args.slice(1));
        } else if (cmd === 'cut') {
            await cmdCut(args.slice(1));
        } else if (cmd === 'status') {
            showStatus();
        } else {
            console.error(c('red', `  ❌ Comando desconhecido: "${cmd}". Use "node cli.js help" para ajuda.`));
            process.exit(1);
        }
    } catch (err) {
        console.error(c('red', `\n  ❌ Erro: ${err.message}\n`));
        process.exit(1);
    }
}

main();
