// src/platforms/twitch-chat.js
// Monitora o chat IRC da Twitch durante uma gravação ao vivo e calcula
// a densidade de mensagens por janela de tempo para encontrar os picos de hype.
// Conexão anônima (read-only) — não precisa de auth.

import WebSocket from 'ws';
import { logger } from '../utils/logger.js';

const IRC_URL = 'wss://irc-ws.chat.twitch.tv:443';
const ANON_NICK = 'justinfan' + Math.floor(Math.random() * 80000 + 10000);

/**
 * Monitora o chat de um canal Twitch por `durationSeconds` segundos.
 * Retorna um array de picos ordenados por densidade de mensagens.
 *
 * @param {string} channel - Nome do canal (sem #), ex: 'alanzoka'
 * @param {number} durationSeconds - Duração total do monitoramento (coincide com a gravação)
 * @param {number} windowSec - Tamanho da janela de análise em segundos (padrão: 30)
 * @returns {Promise<Array<{ peakTime: number, density: number }>>}
 */
export async function monitorChatDensity(channel, durationSeconds, windowSec = 30) {
    return new Promise((resolve) => {
        const normalizedChannel = channel.toLowerCase().replace(/^#/, '');
        const buckets = {}; // { windowIndex: count }
        const startTime = Date.now();

        logger.info(`[Chat] Conectando ao chat de #${normalizedChannel} (${durationSeconds}s)...`);

        const ws = new WebSocket(IRC_URL);

        ws.on('open', () => {
            ws.send(`NICK ${ANON_NICK}`);
            ws.send(`JOIN #${normalizedChannel}`);
            logger.info(`[Chat] Conectado a #${normalizedChannel} como ${ANON_NICK}`);
        });

        ws.on('message', (raw) => {
            const msg = raw.toString();

            // Responde ao ping para manter a conexão viva
            if (msg.startsWith('PING')) {
                ws.send('PONG :tmi.twitch.tv');
                return;
            }

            // Conta apenas mensagens de chat (PRIVMSG)
            if (msg.includes('PRIVMSG')) {
                const elapsedSec = (Date.now() - startTime) / 1000;
                const windowIdx = Math.floor(elapsedSec / windowSec);
                buckets[windowIdx] = (buckets[windowIdx] || 0) + 1;
            }
        });

        ws.on('error', (err) => {
            logger.warn(`[Chat] Erro no WebSocket: ${err.message} — continuando sem dados de chat.`);
        });

        // Encerra após durationSeconds
        const timeout = setTimeout(() => {
            ws.close();
            logger.info(`[Chat] Monitor encerrado. ${Object.keys(buckets).length} janela(s) com atividade.`);

            // Converte buckets em array de peaks (peakTime = centro da janela)
            const peaks = Object.entries(buckets)
                .map(([idx, count]) => ({
                    peakTime: (parseInt(idx) * windowSec) + (windowSec / 2),
                    density: count,
                }))
                .filter((p) => p.peakTime < durationSeconds) // descarta janelas além da gravação
                .sort((a, b) => b.density - a.density);      // mais denso primeiro

            peaks.forEach((p, i) => {
                logger.info(`  [Chat] Pico #${i + 1}: ${Math.floor(p.peakTime)}s — ${p.density} mensagens`);
            });

            resolve(peaks);
        }, durationSeconds * 1000);

        ws.on('close', () => clearTimeout(timeout));
    });
}
