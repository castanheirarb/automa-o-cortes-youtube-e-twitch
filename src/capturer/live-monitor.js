// src/capturer/live-monitor.js
// Monitor de background que detecta lives ativas nas personas Twitch
// e dispara a captação automática quando um canal vai ao ar.

import 'dotenv/config';
import axios from 'axios';
import { logger } from '../utils/logger.js';
import { PERSONAS } from './personas.js';
import { recordLiveStream, cleanupTmpFiles } from './live-recorder.js';
import { monitorChatDensity } from '../platforms/twitch-chat.js';
import { getTwitchLivePeaks } from '../platforms/twitch-peaks.js';
import { processClip } from '../processor/ffmpeg.js';
import path from 'node:path';
import fs from 'node:fs';

const TWITCH_API = 'https://api.twitch.tv/helix';
const POLL_MS = parseInt(process.env.LIVE_POLL_INTERVAL || '120', 10) * 1000;
const CAPTURE_MIN = parseInt(process.env.LIVE_CAPTURE_MINUTES || '30', 10);
const MIN_VIEWERS = parseInt(process.env.LIVE_MIN_VIEWERS || '200', 10);

// Rastreia quais canais já estão sendo capturados (evita duplicatas)
const activeCaptures = new Set();

// ─── Auth ────────────────────────────────────────────────────────────────────

let cachedToken = null;
let tokenExpiry = 0;

async function getToken() {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;

    const { TWITCH_CLIENT_ID, TWITCH_CLIENT_SECRET } = process.env;
    if (!TWITCH_CLIENT_ID || !TWITCH_CLIENT_SECRET || TWITCH_CLIENT_SECRET === 'seu_client_secret_aqui') {
        throw new Error('TWITCH_CLIENT_SECRET não configurado no .env!');
    }

    const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
        params: { client_id: TWITCH_CLIENT_ID, client_secret: TWITCH_CLIENT_SECRET, grant_type: 'client_credentials' },
    });

    cachedToken = res.data.access_token;
    tokenExpiry = Date.now() + (res.data.expires_in - 60) * 1000;
    return cachedToken;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

async function getTwitchHeaders() {
    return {
        'Client-Id': process.env.TWITCH_CLIENT_ID,
        Authorization: `Bearer ${await getToken()}`,
    };
}

/** Retorna info da stream se ao vivo, null se offline */
async function checkIfLive(loginName) {
    const headers = await getTwitchHeaders();
    const res = await axios.get(`${TWITCH_API}/streams`, {
        headers,
        params: { user_login: loginName },
    });
    const stream = res.data.data?.[0];
    return stream ?? null; // tem user_id, game_name, viewer_count, started_at etc.
}

/** Retorna o VOD ID da stream atual (para buscar clips) */
async function getCurrentVodId(userId) {
    const headers = await getTwitchHeaders();
    const res = await axios.get(`${TWITCH_API}/videos`, {
        headers,
        params: { user_id: userId, type: 'archive', first: 1 },
    });
    return res.data.data?.[0]?.id ?? null;
}

function getPersonaOutputDir(personaName) {
    return path.resolve(process.env.OUTPUT_DIR || './output', personaName);
}

// ─── Pipeline de Captação ao Vivo ─────────────────────────────────────────────

async function captureFromLive(persona, streamInfo) {
    const { name, displayName, channelUrl: loginName, clipsPerRun } = persona;
    const { viewer_count, started_at, user_id, title: streamTitle } = streamInfo;

    logger.info(`\n${'═'.repeat(52)}`);
    logger.info(`  🔴 LIVE DETECTADA: ${displayName}`);
    logger.info(`  👥 ${viewer_count} viewers | 🕐 ${new Date(started_at).toLocaleTimeString('pt-BR')}`);
    logger.info(`  📡 "${streamTitle}"`);
    logger.info(`${'═'.repeat(52)}\n`);

    activeCaptures.add(name);

    try {
        // 1. Grava live + monitora chat em paralelo
        logger.step(`[LiveCapture] Iniciando gravação de ${CAPTURE_MIN} min...`);

        const [recorded, chatDensity] = await Promise.all([
            recordLiveStream(loginName, CAPTURE_MIN),
            monitorChatDensity(loginName, CAPTURE_MIN * 60),
        ]);

        const { filePath, durationSec } = recorded;

        // 2. Detecta melhores momentos (Opção C)
        const vodId = await getCurrentVodId(user_id).catch(() => null);
        logger.step('[LiveCapture] Detectando melhores momentos (Opção C)...');

        const peaks = await getTwitchLivePeaks({
            broadcasterId: user_id,
            streamStartedAt: started_at,
            clientId: process.env.TWITCH_CLIENT_ID,
            token: await getToken(),
            chatDensity,
            videoUrl: filePath,   // arquivo LOCAL já gravado
            duration: durationSec,
            title: streamTitle || displayName,
            topN: clipsPerRun,
        });

        logger.success(`[LiveCapture] ${peaks.length} pico(s) identificado(s).`);

        // 3. Processa clipes
        const personaDir = getPersonaOutputDir(name);
        fs.mkdirSync(personaDir, { recursive: true });

        const originalOutput = process.env.OUTPUT_DIR;
        process.env.OUTPUT_DIR = personaDir;

        let generated = 0;
        for (let i = 0; i < peaks.length; i++) {
            try {
                await processClip({ ...peaks[i], videoUrl: filePath }, i + 1, peaks.length);
                generated++;
            } catch (err) {
                logger.error(`[LiveCapture] Clipe ${i + 1} falhou: ${err.message}`);
            }
        }

        process.env.OUTPUT_DIR = originalOutput;

        // 4. Limpa arquivo temporário da gravação
        cleanupTmpFiles(1);

        logger.success(`[LiveCapture] "${displayName}": ${generated}/${clipsPerRun} clipe(s) gerado(s) → ${personaDir}`);

    } catch (err) {
        logger.error(`[LiveCapture] Erro ao capturar "${displayName}": ${err.message}`);
    } finally {
        activeCaptures.delete(name);
    }
}

// ─── Loop de Polling ──────────────────────────────────────────────────────────

/**
 * Inicia o monitor de lives. Fica em loop até o processo ser encerrado.
 *
 * @param {string[]} [filterNames] - Se informado, monitora só essas personas (ex: ['alanzoka'])
 */
export async function startLiveMonitor(filterNames = []) {
    const twitchPersonas = PERSONAS.filter((p) => p.platform === 'twitch');
    const targets = filterNames.length > 0
        ? twitchPersonas.filter((p) => filterNames.includes(p.name))
        : twitchPersonas;

    if (targets.length === 0) {
        logger.error('[LiveMonitor] Nenhuma persona Twitch encontrada. Verifique personas.js.');
        return;
    }

    const names = targets.map((p) => p.displayName).join(', ');
    logger.info(`\n📡 Live Monitor iniciado — monitorando: ${names}`);
    logger.info(`   Polling a cada ${POLL_MS / 1000}s | Mín. viewers: ${MIN_VIEWERS} | Gravação: ${CAPTURE_MIN} min\n`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        for (const persona of targets) {
            // Pula se já está em captação
            if (activeCaptures.has(persona.name)) {
                logger.info(`[LiveMonitor] ${persona.displayName}: captura em andamento — pulando.`);
                continue;
            }

            try {
                const streamInfo = await checkIfLive(persona.channelUrl);

                if (!streamInfo) {
                    logger.info(`[LiveMonitor] ${persona.displayName}: offline.`);
                    continue;
                }

                if (streamInfo.viewer_count < MIN_VIEWERS) {
                    logger.info(`[LiveMonitor] ${persona.displayName}: ao vivo mas com apenas ${streamInfo.viewer_count} viewers (mín: ${MIN_VIEWERS}).`);
                    continue;
                }

                // Live detectada acima do threshold → dispara captação em background
                logger.info(`[LiveMonitor] 🔴 ${persona.displayName} está ao vivo com ${streamInfo.viewer_count} viewers!`);
                captureFromLive(persona, streamInfo).catch((e) => {
                    logger.error(`[LiveMonitor] captureFromLive("${persona.name}") rejeitou: ${e.message}`);
                });

            } catch (err) {
                logger.warn(`[LiveMonitor] Erro ao checar "${persona.displayName}": ${err.message}`);
            }
        }

        logger.info(`[LiveMonitor] Próxima checagem em ${POLL_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}
