// src/capturer/tiktok-live-mirror.js
//
// Espelhamento de dados/status de uma sala TikTok LIVE monitorada.
//
// Escopo estrito:
//   - Consome apenas o canal de EVENTOS PÚBLICOS da sala (o mesmo WebSocket
//     "webcast" que o player web usa para chat, contagem de espectadores,
//     presentes e status on/off). NÃO baixa nem faz proxy do stream de
//     vídeo/áudio, nem usa chaves/URLs de CDN privadas.
//   - Não faz polling agressivo: a conexão é orientada a eventos (push via
//     WebSocket). O único polling é o de reconexão, com backoff exponencial.
//
// Depende de `tiktok-live-connector` (biblioteca open-source amplamente
// usada por overlays/alertas de live — não afiliada à TikTok):
//   npm install tiktok-live-connector

import { EventEmitter } from 'node:events';
import { logger } from '../utils/logger.js';

const MAX_RECONNECT_DELAY_MS = 60_000;
const BASE_RECONNECT_DELAY_MS = 2_000;

/**
 * Espelha os eventos públicos de uma sala TikTok LIVE (chat, gifts,
 * contagem de espectadores, status da transmissão) em um EventEmitter local.
 *
 * Eventos emitidos:
 *   'status'   → { live: boolean, roomId?: string }
 *   'chat'     → { user, comment }
 *   'gift'     → { user, giftName, repeatCount }
 *   'viewers'  → { count }
 *   'error'    → Error
 *   'ended'    → (sala saiu do ar / conexão encerrada permanentemente)
 *
 * @param {string} username - @handle da conta monitorada (sem o "@")
 * @returns {{ emitter: EventEmitter, stop: () => Promise<void> }}
 */
export function mirrorTikTokLive(username) {
    if (!username) throw new Error('username é obrigatório.');

    const emitter = new EventEmitter();
    let stopped = false;
    let reconnectAttempt = 0;
    let connection = null;
    let reconnectTimer = null;

    async function connect() {
        if (stopped) return;

        // Import dinâmico: mantém a dependência opcional até o módulo ser usado.
        // WebcastPushConnection só existe no subpath /legacy na v2+ (a raiz do
        // pacote exporta a nova TikTokLiveConnection) — importar da raiz aqui
        // resolve undefined e quebra o "new" logo abaixo.
        const { WebcastPushConnection } = await import('tiktok-live-connector/legacy');

        const options = {};
        if (process.env.EULERSTREAM_API_KEY) {
            options.signApiKey = process.env.EULERSTREAM_API_KEY;
        }
        // Sessão de conta dedicada (opcional) — só ajuda a ver lives restritas
        // (subscriber-only/idade); status/chat/gift públicos funcionam sem isso.
        if (process.env.TIKTOK_SESSION_ID && process.env.TIKTOK_TT_TARGET_IDC) {
            options.session = {
                cookie: {
                    type: 'cookie',
                    value: {
                        sessionId: process.env.TIKTOK_SESSION_ID,
                        ttTargetIdc: process.env.TIKTOK_TT_TARGET_IDC,
                    },
                },
            };
        }

        connection = new WebcastPushConnection(username, options);

        connection.on('streamEnd', () => {
            logger.info(`[TikTokMirror] @${username}: live encerrada.`);
            emitter.emit('status', { live: false });
            emitter.emit('ended');
        });

        connection.on('chat', (data) => {
            emitter.emit('chat', { user: data.uniqueId, comment: data.comment });
        });

        connection.on('gift', (data) => {
            emitter.emit('gift', {
                user: data.uniqueId,
                giftName: data.giftName,
                repeatCount: data.repeatCount,
            });
        });

        connection.on('roomUser', (data) => {
            if (typeof data.viewerCount === 'number') {
                emitter.emit('viewers', { count: data.viewerCount });
            }
        });

        connection.on('disconnected', () => {
            if (stopped) return;
            logger.warn(`[TikTokMirror] @${username}: desconectado — agendando reconexão.`);
            scheduleReconnect();
        });

        try {
            const state = await connection.connect();
            reconnectAttempt = 0; // reset do backoff após sucesso
            logger.success(`[TikTokMirror] @${username}: conectado (roomId ${state.roomId}).`);
            emitter.emit('status', { live: true, roomId: state.roomId });
        } catch (err) {
            // Sala offline não é erro — apenas ainda não há transmissão ativa.
            logger.info(`[TikTokMirror] @${username}: sala offline (${err.message}).`);
            emitter.emit('status', { live: false });
            scheduleReconnect();
        }
    }

    function scheduleReconnect() {
        if (stopped || reconnectTimer) return;

        const delay = Math.min(
            BASE_RECONNECT_DELAY_MS * 2 ** reconnectAttempt,
            MAX_RECONNECT_DELAY_MS,
        );
        reconnectAttempt++;

        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            connect().catch((err) => emitter.emit('error', err));
        }, delay);
    }

    connect().catch((err) => emitter.emit('error', err));

    async function stop() {
        stopped = true;
        if (reconnectTimer) clearTimeout(reconnectTimer);
        if (connection) {
            try {
                connection.disconnect();
            } catch {
                // conexão já pode estar fechada — ignora.
            }
        }
    }

    return { emitter, stop };
}
