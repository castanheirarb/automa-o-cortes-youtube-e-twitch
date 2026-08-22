// src/capturer/sports-radar.js
// Agente Radar Esportivo — monitora o chat de uma live de futebol no YouTube,
// detecta picos de reação (gols) via algoritmo de sliding-window e captura
// automaticamente os últimos minutos via DVR do yt-dlp.
//
// Uso:
//   npm run radar:start
//   LIVE_SPORTS_URL=https://www.youtube.com/watch?v=XXXXX npm run radar:start
//
// Variáveis de ambiente relevantes (.env):
//   LIVE_SPORTS_URL          URL completa da live (obrigatório)
//   RADAR_KEYWORDS           Lista separada por vírgula (padrão abaixo)
//   RADAR_SPIKE_THRESHOLD    Qtd de keyword hits para disparar captura (padrão: 50)
//   RADAR_SPIKE_WINDOW_MS    Janela deslizante em ms (padrão: 15000 = 15s)
//   RADAR_COOLDOWN_MS        Tempo mínimo entre capturas em ms (padrão: 120000 = 2min)
//   RADAR_CLIP_BEFORE_SEC    Segundos antes do gol a capturar (padrão: 150 = 2.5min)
//   RADAR_CLIP_AFTER_SEC     Segundos depois do gol a capturar (padrão: 30)
//   RADAR_STREAM_OFFSET_SEC  Offset inicial se o radar foi ligado depois da live começar
//   RADAR_OUTPUT_DIR         Diretório de saída (padrão: ./output/sports-radar)

// Quando rodado pelo Watchdog (RADAR_WATCHDOG_MODE=1), todas as vars já estão
// injetadas via spawn env — dotenv não deve sobrescrever os valores injetados.
// Quando rodado standalone (npm run radar:start), carrega o .env normalmente.
import dotenv from 'dotenv';
dotenv.config({ override: false }); // nunca sobrescreve vars já definidas no processo

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../utils/logger.js';
import { processLocalClip } from '../processor/ffmpeg.js';

const execFileAsync = promisify(execFile);

// ─── Configuração via .env ────────────────────────────────────────────────────

const LIVE_URL    = process.env.LIVE_SPORTS_URL;
const THRESHOLD   = parseInt(process.env.RADAR_SPIKE_THRESHOLD  || '50',  10);
const WINDOW_MS   = parseInt(process.env.RADAR_SPIKE_WINDOW_MS  || '15000', 10);
const COOLDOWN_MS = parseInt(process.env.RADAR_COOLDOWN_MS      || '120000', 10);
const BEFORE_SEC  = parseInt(process.env.RADAR_CLIP_BEFORE_SEC  || '150', 10);
const AFTER_SEC   = parseInt(process.env.RADAR_CLIP_AFTER_SEC   || '30',  10);
const OFFSET_SEC  = parseInt(process.env.RADAR_STREAM_OFFSET_SEC || '0',  10);
const OUTPUT_DIR  = path.resolve(process.env.RADAR_OUTPUT_DIR   || './output/sports-radar');

const KEYWORDS = (
    process.env.RADAR_KEYWORDS ||
    'gol,golaço,goool,goooool,gooool,golaço,vaaai,vaaaaai,pqp,que golaço,que gol'
)
    .toLowerCase()
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

// ─── Estado do agente ─────────────────────────────────────────────────────────

const spikeWindow  = []; // timestamps (ms) de keyword hits dentro da janela ativa
let lastCaptureMs  = 0;
let goalCount      = 0;
let radarStartMs   = Date.now();
let chatClient     = null;

// ─── Utilitários ──────────────────────────────────────────────────────────────

/** Converte segundos totais para "HH:MM:SS" (formato aceito pelo --download-sections do yt-dlp) */
function toHMS(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

/** Posição estimada no stream em segundos (delta desde o início do radar + offset inicial) */
function streamOffsetNow() {
    return OFFSET_SEC + (Date.now() - radarStartMs) / 1000;
}

/** Extrai o videoId de qualquer variante de URL do YouTube */
function extractVideoId(url) {
    const patterns = [
        /[?&]v=([a-zA-Z0-9_-]{11})/,
        /youtu\.be\/([a-zA-Z0-9_-]{11})/,
        /\/live\/([a-zA-Z0-9_-]{11})/,
        /\/shorts\/([a-zA-Z0-9_-]{11})/,
    ];
    for (const re of patterns) {
        const m = url.match(re);
        if (m) return m[1];
    }
    return null;
}

// ─── Algoritmo de Spike (Sliding Window) ─────────────────────────────────────
//
// Mantém um array de timestamps de hits de keyword.
// A cada novo hit:
//   1. Adiciona o timestamp atual ao array
//   2. Remove entradas mais antigas que WINDOW_MS (janela deslizante)
//   3. Retorna a contagem atual de hits na janela
//
// Se a contagem >= THRESHOLD e não estiver em cooldown → GOL detectado.

function recordKeywordHit() {
    const now = Date.now();
    spikeWindow.push(now);

    // Expulsa entradas fora da janela deslizante
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < spikeWindow.length && spikeWindow[i] < cutoff) i++;
    if (i > 0) spikeWindow.splice(0, i);

    return spikeWindow.length;
}

function isInCooldown() {
    return (Date.now() - lastCaptureMs) < COOLDOWN_MS;
}

// ─── Monitor de Chat (youtube-chat) ──────────────────────────────────────────

async function startChatMonitor(url) {
    const videoId = extractVideoId(url);
    if (!videoId) throw new Error(`Não foi possível extrair o videoId de: ${url}`);

    let LiveChat;
    try {
        ({ LiveChat } = await import('youtube-chat'));
    } catch {
        throw new Error(
            'Pacote "youtube-chat" não instalado.\n' +
            'Execute: npm install youtube-chat\n' +
            'Depois reinicie o radar.'
        );
    }

    chatClient = new LiveChat({ videoId });

    chatClient.on('chat', (item) => {
        // Monta o texto completo da mensagem (texto + emojis por shortcut)
        const text = (item.message || [])
            .map((part) => part.text || part?.emoji?.shortcuts?.[0] || '')
            .join('')
            .toLowerCase();

        const hit = KEYWORDS.some((kw) => text.includes(kw));
        if (!hit) return;

        const count = recordKeywordHit();

        logger.info(
            `[Radar] Keyword "${text.slice(0, 45).trim()}" | ` +
            `Spike: ${count}/${THRESHOLD} (${WINDOW_MS / 1000}s)`
        );

        if (count >= THRESHOLD && !isInCooldown()) {
            onGoalDetected().catch((err) =>
                logger.error(`[Radar] Erro ao processar gol: ${err.message}`)
            );
        }
    });

    chatClient.on('error', (err) => {
        logger.warn(`[Radar] Erro no chat: ${err.message}`);
    });

    chatClient.on('end', () => {
        logger.warn('[Radar] Chat encerrado (live terminou ou foi desconectado).');
        process.exit(0);
    });

    const started = await chatClient.start();
    if (!started) {
        throw new Error(
            'Não foi possível conectar ao chat. ' +
            'Verifique se a live está ao vivo e se a URL está correta.'
        );
    }

    logger.success(`[Radar] Chat conectado — videoId: ${videoId}`);
}

// ─── Detecção de Gol ──────────────────────────────────────────────────────────

async function onGoalDetected() {
    goalCount++;
    lastCaptureMs = Date.now();
    spikeWindow.length = 0; // reset da janela após disparo para evitar re-trigger imediato

    const offsetNow  = streamOffsetNow();
    const clipStart  = Math.max(0, offsetNow - BEFORE_SEC);
    const clipEnd    = offsetNow + AFTER_SEC;
    const clipDurSec = clipEnd - clipStart;

    logger.step(
        `[Radar] GOL #${goalCount} DETECTADO! ` +
        `Offset: ${toHMS(offsetNow)} | ` +
        `Capturando: ${toHMS(clipStart)} → ${toHMS(clipEnd)} (~${Math.round(clipDurSec)}s)`
    );

    const rawFile = await captureDVR(clipStart, clipEnd, goalCount);
    if (!rawFile) {
        logger.error(`[Radar] Captura DVR do gol #${goalCount} falhou — sem arquivo raw.`);
        return;
    }

    logger.step(`[Radar] Enviando gol #${goalCount} para pipeline 9:16 (blur background)...`);
    try {
        const processed = await processLocalClip(rawFile, OUTPUT_DIR, `gol-${goalCount}`);
        logger.success(`[Radar] Gol #${goalCount} pronto para upload: ${path.basename(processed)}`);

        // Remove o arquivo raw após processamento com sucesso
        try { fs.unlinkSync(rawFile); } catch { /* ignora */ }

        // Posta imediatamente via express-poster (sem afetar o round-robin)
        try {
            const { postExpressClip } = await import('../../poster/express-poster.js');
            await postExpressClip(processed);
        } catch (postErr) {
            logger.error(`[Radar] Express post falhou para gol #${goalCount}: ${postErr.message}`);
        }
    } catch (err) {
        logger.error(`[Radar] Pipeline falhou para gol #${goalCount}: ${err.message}`);
    }
}

// ─── Captura DVR via yt-dlp ───────────────────────────────────────────────────
//
// O yt-dlp suporta --download-sections "*HH:MM:SS-HH:MM:SS" para
// baixar cirurgicamente uma seção de uma live com DVR ativado.
// O stream timestamp é calculado a partir do início da live (OFFSET_SEC + delta).

async function captureDVR(startSec, endSec, goalNum) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const ts      = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rawFile = path.join(OUTPUT_DIR, `raw-gol-${goalNum}-${ts}.mp4`);
    const section = `*${toHMS(startSec)}-${toHMS(endSec)}`;

    logger.info(`[Radar] yt-dlp --download-sections "${section}" → ${path.basename(rawFile)}`);

    try {
        await execFileAsync(ytDlp, [
            '--download-sections', section,
            // Corta exatamente no ponto pedido: sem isto o yt-dlp corta no keyframe
            // anterior e o clipe começa com segundos SEM ÁUDIO (áudio dessincronizado).
            '--force-keyframes-at-cuts',
            '--extractor-args', 'youtube:player_client=android',
            '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
            '--merge-output-format', 'mp4',
            '--no-playlist',
            '-o', rawFile,
            LIVE_URL,
        ], { timeout: 8 * 60 * 1000 }); // 8 min de timeout para download

        logger.success(`[Radar] DVR capturado: ${path.basename(rawFile)}`);
        return rawFile;
    } catch (err) {
        logger.error(`[Radar] Falha no DVR: ${err.message.split('\n')[0]}`);
        return null;
    }
}

// ─── Banner de inicialização ──────────────────────────────────────────────────

function printBanner() {
    const cooldownMin = (COOLDOWN_MS / 60000).toFixed(1);
    const windowSec   = WINDOW_MS / 1000;
    const beforeMin   = (BEFORE_SEC / 60).toFixed(1);

    console.log('\n\x1b[33m' + '═'.repeat(62) + '\x1b[0m');
    console.log('\x1b[33m  RADAR ESPORTIVO — CorteCerto\x1b[0m');
    console.log(`\x1b[33m  Live  : ${LIVE_URL}\x1b[0m`);
    console.log(`\x1b[33m  Spike : ${THRESHOLD} keywords em ${windowSec}s | Cooldown: ${cooldownMin}min\x1b[0m`);
    console.log(`\x1b[33m  Clipe : -${beforeMin}min antes → +${AFTER_SEC}s depois do gol\x1b[0m`);
    if (OFFSET_SEC > 0) {
        console.log(`\x1b[33m  Offset: +${toHMS(OFFSET_SEC)} (radar ligado após início da live)\x1b[0m`);
    }
    console.log(`\x1b[33m  Keys  : [${KEYWORDS.join(', ')}]\x1b[0m`);
    console.log('\x1b[33m' + '═'.repeat(62) + '\x1b[0m\n');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
    if (!LIVE_URL) {
        logger.error(
            '[Radar] LIVE_SPORTS_URL não definida no .env\n' +
            '  Exemplo: LIVE_SPORTS_URL=https://www.youtube.com/watch?v=XXXXX'
        );
        process.exit(1);
    }

    printBanner();
    radarStartMs = Date.now();

    try {
        await startChatMonitor(LIVE_URL);
    } catch (err) {
        logger.error(`[Radar] Falha ao iniciar: ${err.message}`);
        process.exit(1);
    }

    process.on('SIGINT', () => {
        logger.info(`[Radar] Encerrando. Gols capturados: ${goalCount}`);
        chatClient?.stop?.();
        process.exit(0);
    });

    logger.info('[Radar] Monitorando chat em tempo real. Pressione Ctrl+C para encerrar.');
}

main();
