// bilibili/chat-peaks.js
// Detecta o momento de pico de reação do chat ORIGINAL (replay do chat ao
// vivo do YouTube, quando a fonte é VOD de uma live) — usado como proxy do
// que geraria danmaku forte na Bilibili depois. A mecânica (contar mensagens
// por janela de tempo, achar a janela mais densa) é agnóstica de cultura —
// só estatística; o que dá o sinal certo é que o chat sendo medido já é o
// público real da streamer (majoritariamente chinês, no caso das fontes
// atuais), reagindo no momento em que aconteceu — não é uma preferência
// cultural presumida por nós.
//
// Só funciona pra fontes que SÃO VOD de live (o YouTube arquiva o chat nesse
// caso). Vídeo editado/pré-gravado não tem isso — retorna null, e
// bilibili/capture.js cai pro comportamento de processar o vídeo inteiro.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

/**
 * Checagem leve (sem baixar o replay inteiro) se a fonte tem faixa de
 * live_chat disponível — usada por bilibili/scout.js pra PRIORIZAR fontes
 * com chat na hora de escolher qual vídeo processar, em vez de só olhar
 * views. Bem mais barata que findChatPeak() (que baixa o JSON completo).
 * @param {string} sourceUrl
 * @returns {Promise<boolean>}
 */
export async function hasChatReplay(sourceUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    try {
        const { stdout } = await execFileAsync(ytDlp, ['--list-subs', sourceUrl], { maxBuffer: 5 * 1024 * 1024 });
        return stdout.includes('live_chat');
    } catch {
        return false;
    }
}

/**
 * Baixa o replay do chat (se existir) e retorna os timestamps das mensagens
 * (segundos desde o início do vídeo).
 * @param {string} sourceUrl
 * @returns {Promise<number[]>}
 */
async function fetchChatReplayTimestamps(sourceUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const tmpBase = path.join(os.tmpdir(), `bili_chat_${crypto.randomBytes(4).toString('hex')}`);
    const jsonPath = `${tmpBase}.live_chat.json`;

    try {
        await execFileAsync(ytDlp, [
            '--skip-download', '--write-subs',
            '--sub-langs', 'live_chat',
            '-o', tmpBase,
            sourceUrl,
        ], { maxBuffer: 50 * 1024 * 1024 });

        if (!fs.existsSync(jsonPath)) return [];

        // Formato do yt-dlp: um JSON por linha (JSONL), cada um com
        // videoOffsetTimeMsec = milissegundos desde o início do vídeo.
        const lines = fs.readFileSync(jsonPath, 'utf-8').trim().split('\n').filter(Boolean);
        const timestamps = [];
        for (const line of lines) {
            try {
                const entry = JSON.parse(line);
                const offsetMs = entry.videoOffsetTimeMsec ?? entry.replayChatItemAction?.videoOffsetTimeMsec;
                if (offsetMs !== undefined) timestamps.push(Number(offsetMs) / 1000);
            } catch { /* linha corrompida — ignora essa mensagem, não o replay inteiro */ }
        }
        return timestamps;
    } catch (err) {
        logger.info(`[Bilibili/ChatPeaks] Sem replay de chat (provavelmente não é VOD de live): ${err.message.split('\n')[0]}`);
        return [];
    } finally {
        if (fs.existsSync(jsonPath)) fs.unlinkSync(jsonPath);
    }
}

/**
 * Agrupa timestamps em janelas de tempo e ordena por densidade (mais
 * mensagens primeiro) — mesma lógica de src/platforms/twitch-chat.js
 * (monitorChatDensity), só que em lote sobre um replay já completo, em vez
 * de em tempo real sobre uma conexão IRC ao vivo.
 * @param {number[]} timestamps
 * @param {number} windowSec
 */
function computeDensity(timestamps, windowSec) {
    const buckets = new Map();
    for (const t of timestamps) {
        const bucket = Math.floor(t / windowSec) * windowSec;
        buckets.set(bucket, (buckets.get(bucket) || 0) + 1);
    }
    return [...buckets.entries()]
        .map(([bucket, count]) => ({ peakTime: bucket + windowSec / 2, density: count }))
        .sort((a, b) => b.density - a.density);
}

/**
 * Acha o momento de pico de reação do chat de um vídeo-fonte.
 * @param {string} sourceUrl
 * @param {object} [opts]
 * @param {number} [opts.windowSec=20]     - tamanho da janela de agrupamento
 * @param {number} [opts.minMessages=8]    - mínimo de mensagens na janela pra contar como pico real
 * @returns {Promise<{ peakTime: number, density: number } | null>}
 */
export async function findChatPeak(sourceUrl, { windowSec = 20, minMessages = 8 } = {}) {
    logger.info('[Bilibili/ChatPeaks] Verificando replay de chat da fonte...');
    const timestamps = await fetchChatReplayTimestamps(sourceUrl);
    if (timestamps.length === 0) return null;

    const density = computeDensity(timestamps, windowSec);
    const top = density[0];
    if (!top || top.density < minMessages) {
        logger.info(`[Bilibili/ChatPeaks] Pico mais forte tem só ${top?.density || 0} mensagem(ns) em ${windowSec}s (mínimo ${minMessages}) — não confiável, ignorando.`);
        return null;
    }

    logger.success(`[Bilibili/ChatPeaks] Pico encontrado: ~${Math.round(top.peakTime)}s (${top.density} mensagens/${windowSec}s, de ${timestamps.length} mensagens totais no replay)`);
    return top;
}

// ─── Self-test: node bilibili/chat-peaks.js <url> ────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('chat-peaks.js')) {
    const url = process.argv[2];
    if (!url) {
        console.error('Uso: node bilibili/chat-peaks.js <url>');
        process.exit(1);
    }
    findChatPeak(url)
        .then((p) => { console.log(p ? JSON.stringify(p, null, 2) : 'Nenhum pico encontrado (sem replay de chat).'); process.exitCode = 0; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
