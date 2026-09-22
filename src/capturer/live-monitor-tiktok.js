// src/capturer/live-monitor-tiktok.js
// Monitor de lives do TikTok — orientado a evento (WebSocket via
// tiktok-live-mirror.js), não a polling: assim que a sala entra "ao vivo",
// a captação é disparada na hora.
//
// Detecção de melhores momentos ("Opção C" adaptada, ver tiktok-peaks.js):
// como a mesma conexão WebSocket que detecta o status também recebe chat e
// gifts em tempo real, escutamos os dois DURANTE a gravação e priorizamos os
// clipes nas janelas de maior engajamento — gifts pesam mais que chat (é
// dinheiro de verdade, sinal de hype mais confiável). Sem chat/gift no
// período (ex.: sala silenciosa ou live pequena), cai pra distribuição
// uniforme automaticamente.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { PERSONAS } from './personas.js';
import { mirrorTikTokLive } from './tiktok-live-mirror.js';
import { recordLiveStream, cleanupTmpFiles } from './live-recorder.js';
import { monitorTikTokEngagement, getTikTokLivePeaks } from '../platforms/tiktok-peaks.js';
import { processClip } from '../processor/ffmpeg.js';

const CAPTURE_MIN = parseInt(process.env.TIKTOK_LIVE_CAPTURE_MINUTES || process.env.LIVE_CAPTURE_MINUTES || '30', 10);
const COOKIES_PATH = process.env.TIKTOK_COOKIES_PATH || null;

// Rastreia quais personas já estão sendo capturadas (evita duplicatas)
const activeCaptures = new Set();

function getPersonaOutputDir(personaName) {
    return path.resolve(process.env.OUTPUT_DIR || './output', personaName);
}

async function captureFromLive(persona, emitter, { viewerCount } = {}) {
    const { name, displayName, channelUrl: username, clipsPerRun } = persona;

    logger.info(`\n${'═'.repeat(52)}`);
    logger.info(`  🔴 TIKTOK LIVE DETECTADA: ${displayName}`);
    if (viewerCount != null) logger.info(`  👥 ${viewerCount} viewers`);
    logger.info(`${'═'.repeat(52)}\n`);

    activeCaptures.add(name);

    try {
        logger.step(`[TikTokLive] Iniciando gravação de ${CAPTURE_MIN} min...`);

        // Grava + escuta chat/gifts da MESMA sala em paralelo (mesmo padrão
        // da Twitch: recordLiveStream + monitorChatDensity via Promise.all).
        const [recorded, engagement] = await Promise.all([
            recordLiveStream({
                url: `https://www.tiktok.com/@${username}/live`,
                label: username,
                minutesToRecord: CAPTURE_MIN,
                cookiesPath: COOKIES_PATH,
            }),
            monitorTikTokEngagement(emitter, CAPTURE_MIN * 60),
        ]);

        const { filePath, durationSec } = recorded;

        const peaks = getTikTokLivePeaks({
            engagement,
            videoUrl: filePath,
            duration: durationSec,
            title: displayName,
            topN: clipsPerRun,
        });

        const personaDir = getPersonaOutputDir(name);
        fs.mkdirSync(personaDir, { recursive: true });

        const originalOutput = process.env.OUTPUT_DIR;
        process.env.OUTPUT_DIR = personaDir;

        let generated = 0;
        for (let i = 0; i < peaks.length; i++) {
            try {
                await processClip({ ...peaks[i], videoUrl: filePath, layout: persona.layout ?? null, niche: persona.niche ?? 'default' }, i + 1, peaks.length);
                generated++;
            } catch (err) {
                logger.error(`[TikTokLive] Clipe ${i + 1} falhou: ${err.message}`);
            }
        }

        process.env.OUTPUT_DIR = originalOutput;

        // Preserva a gravação bruta (~30min) como candidato a vídeo longo da
        // CONTA PRINCIPAL, em vez de deixar cleanupTmpFiles() descartar — pedido
        // do usuário em 07/09/2026. Cai na mesma pasta que os outros vídeos
        // longos (LONG_VIDEOS_DIR), então runLongVideoCycle() já pega ela
        // naturalmente (getNextLongVideo escaneia o diretório inteiro) sem
        // precisar de uma fonte/fallback dedicada. Nunca lança: falha aqui só
        // significa que essa live em particular não vira vídeo longo, os
        // shorts já foram gerados normalmente de qualquer forma.
        try {
            const longVideosDir = path.resolve(process.env.LONG_VIDEOS_DIR || './output/longos');
            fs.mkdirSync(longVideosDir, { recursive: true });
            const destPath = path.join(longVideosDir, `tiktoklive-${username}-${Date.now()}.mp4`);
            fs.renameSync(filePath, destPath);
            logger.success(`[TikTokLive] Gravação bruta preservada como candidato a vídeo longo: ${destPath}`);
        } catch (err) {
            logger.warn(`[TikTokLive] Não deu pra preservar a gravação bruta como vídeo longo: ${err.message}`);
        }

        cleanupTmpFiles(1);

        logger.success(`[TikTokLive] "${displayName}": ${generated}/${clipsPerRun} clipe(s) gerado(s) → ${personaDir}`);
    } catch (err) {
        logger.error(`[TikTokLive] Erro ao capturar "${displayName}": ${err.message}`);
    } finally {
        activeCaptures.delete(name);
    }
}

/**
 * Inicia o monitor de lives do TikTok. Abre uma conexão WebSocket por persona
 * e fica escutando o evento 'status' — nunca faz polling.
 *
 * @param {string[]} [filterNames] - Se informado, monitora só essas personas (ex: ['algumusuario'])
 */
export async function startTikTokLiveMonitor(filterNames = []) {
    // Bug conhecido do tiktok-live-connector (confirmado em 2.4.3 E 2.4.4, o
    // mais recente publicado — não é algo resolvido por upgrade):
    // getTopViewerAttributes() em dist/legacy.js chama .map() em
    // webcastObject.ranksList sem checar undefined. O TikTok não manda esse
    // campo em toda mensagem WebcastRoomUserSeqMessage (contagem de
    // espectadores) — é comum faltar em lives pequenas, exatamente o caso das
    // personas monitoradas aqui. A exceção nasce dentro do event emitter
    // interno da lib (WebcastWebSocketClient.emit → onMessage), antes de
    // chegar em qualquer listener nosso — try/catch normal não alcança.
    // Sem essa rede de segurança, era uma exceção não tratada que matava o
    // processo inteiro toda vez que qualquer sala monitorada ficava ao vivo,
    // e o start.js reiniciava em loop infinito (visto em 04-05/09/2026).
    // A conexão WebSocket em si não é afetada — só essa mensagem específica é
    // perdida. Qualquer outra exceção não reconhecida ainda derruba o
    // processo normalmente (o restart do start.js continua sendo a rede de
    // segurança pra bugs de verdade).
    process.on('uncaughtException', (err) => {
        if (err?.stack?.includes('tiktok-live-connector')) {
            logger.warn(`[TikTokLiveMonitor] Exceção da lib tiktok-live-connector ignorada (bug conhecido, ranksList undefined): ${err.message}`);
            return;
        }
        logger.error(`[TikTokLiveMonitor] Exceção não tratada: ${err.stack || err.message}`);
        process.exit(1);
    });

    const tiktokPersonas = PERSONAS.filter((p) => p.platform === 'tiktok');
    const targets = filterNames.length > 0
        ? tiktokPersonas.filter((p) => filterNames.includes(p.name))
        : tiktokPersonas;

    if (targets.length === 0) {
        logger.error('[TikTokLiveMonitor] Nenhuma persona TikTok encontrada. Verifique personas.js.');
        return;
    }

    const names = targets.map((p) => p.displayName).join(', ');
    logger.info(`\n📡 TikTok Live Monitor iniciado — monitorando: ${names}`);
    logger.info(`   Orientado a evento (WebSocket) | Gravação: ${CAPTURE_MIN} min\n`);

    const connections = targets.map((persona) => {
        const { emitter } = mirrorTikTokLive(persona.channelUrl);

        emitter.on('status', ({ live }) => {
            if (!live) {
                logger.info(`[TikTokLiveMonitor] ${persona.displayName}: offline.`);
                return;
            }
            if (activeCaptures.has(persona.name)) {
                logger.info(`[TikTokLiveMonitor] ${persona.displayName}: captura já em andamento — ignorando novo evento.`);
                return;
            }
            logger.info(`[TikTokLiveMonitor] 🔴 ${persona.displayName} está ao vivo!`);
            captureFromLive(persona, emitter).catch((e) => {
                logger.error(`[TikTokLiveMonitor] captureFromLive("${persona.name}") rejeitou: ${e.message}`);
            });
        });

        emitter.on('error', (err) => {
            logger.warn(`[TikTokLiveMonitor] ${persona.displayName}: erro na conexão — ${err.message}`);
        });

        return { persona, emitter };
    });

    // Mantém o processo vivo (as conexões WebSocket já cuidam da própria
    // reconexão com backoff — não há loop de polling aqui).
    await new Promise(() => {});

    // eslint-disable-next-line no-unreachable
    return connections;
}
