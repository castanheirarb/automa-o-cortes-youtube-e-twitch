// src/comment-bot/monitor.js
// Monitor de background do Comment Bot — responde comentários novos do
// YouTube automaticamente via API (sem Playwright), em todos os canais.
// Espelha a arquitetura de src/capturer/youtube-monitor.js /
// sports-monitor.js: loop while(true) + for...of sequencial + sleep entre
// ciclos, cache FIFO em disco.
//
// Uso via orchestrator: node src/orchestrator.js --comment-monitor
// Flags:  --dry-run  → loga a resposta sem publicar (nunca chama comments.insert)
//         --once     → roda 1 ciclo completo e sai (teste manual)

import 'dotenv/config';
import { COMMENT_BOT_CHANNELS } from './channels.js';
import { getYouTubeClient, resolveChannelId, YouTubeAuthError } from './youtube-auth.js';
import { fetchNewComments, postReply } from './youtube-comments.js';
import { loadHistory, saveHistory, pushEntry, hasEntry, countRepliedInLast24h } from './history.js';
import { logger } from '../../poster/logger.js';

const POLL_MS = parseInt(process.env.COMMENT_BOT_INTERVAL || '900', 10) * 1000;
const MAX_PER_CYCLE = parseInt(process.env.COMMENT_REPLY_MAX_PER_CYCLE || '10', 10);
const MAX_PER_DAY = parseInt(process.env.COMMENT_REPLY_MAX_PER_DAY || '50', 10);

// Espaçamento humano: em produção (fora de dry-run) o bot roda 1x/dia e pode
// ter várias respostas pendentes na mesma passada — respondê-las todas em
// rajada de poucos segundos é o padrão mais óbvio de bot. Um atraso aleatório
// antes de CADA resposta real espalha isso ao longo de alguns minutos,
// mesma lógica de poster/accounts.js (distribuição entre contas extras).
const REPLY_DELAY_MIN_SEC = parseInt(process.env.COMMENT_REPLY_DELAY_MIN_SEC || '30', 10);
const REPLY_DELAY_MAX_SEC = parseInt(process.env.COMMENT_REPLY_DELAY_MAX_SEC || '240', 10);

function randomReplyDelayMs() {
    const min = REPLY_DELAY_MIN_SEC * 1000;
    const max = REPLY_DELAY_MAX_SEC * 1000;
    return min + Math.random() * (max - min);
}

// Canais que falharam auth nesta execução — evita tentar (e logar erro) de
// novo a cada ciclo; só volta ao normal reiniciando o processo, depois de
// `node poster/youtube-oauth-setup.js --channel <key>` ser rodado de novo.
const disabledChannels = new Set();
// { channelKey -> { client, channelId, title } } — resolvido uma vez por processo.
const clientCache = new Map();

async function getChannelClient(channel) {
    if (clientCache.has(channel.key)) return clientCache.get(channel.key);

    const client = getYouTubeClient(channel);
    const { id, title } = await resolveChannelId(client, channel.key);
    const resolved = { client, channelId: id, title };
    clientCache.set(channel.key, resolved);
    logger.info(`[Comment-Bot] "${channel.label}" autenticado — canal "${title}" (${id}).`);
    return resolved;
}

/**
 * Roda 1 ciclo completo pra 1 canal: busca comentários novos, aplica os
 * portões de segurança, gera e (se não for dry-run) publica a resposta.
 */
async function processChannel(channel, { dryRun }) {
    const { client, channelId } = await getChannelClient(channel);

    // Import tardio pra manter monitor.js sem depender de poster/* no topo
    // do arquivo (mesmo padrão de dynamic import já usado em poster/index.js
    // pros módulos de vídeo longo) — evita ciclo de import desnecessário.
    const { classifyIncomingComment, classifyOutgoingReply } = await import('../../poster/comment-safety.js');
    const { generateReply } = await import('../../poster/comment-reply.js');

    let comments;
    try {
        comments = await fetchNewComments(client, channelId);
    } catch (err) {
        logger.warn(`[Comment-Bot] "${channel.label}" — falha ao buscar comentários: ${err.message}`);
        return;
    }

    const history = loadHistory(channel.historyFile);

    // ── Guarda de bootstrap: 1ª execução deste canal — marca tudo como visto
    // SEM responder, pra não bombardear um backlog antigo de comentários.
    if (history.length === 0 && comments.length > 0) {
        for (const c of comments) pushEntry(history, { id: c.commentId, status: 'seeded' });
        saveHistory(channel.historyFile, history);
        logger.warn(
            `[Comment-Bot] "${channel.label}" — histórico vazio: ${comments.length} comentário(s) ` +
            `existente(s) marcados como já vistos, sem responder (bootstrap).`
        );
        return;
    }

    const newComments = comments.filter((c) => c.commentId && !hasEntry(history, c.commentId));
    if (newComments.length === 0) {
        logger.info(`[Comment-Bot] "${channel.label}": sem novidades.`);
        return;
    }

    let repliedThisCycle = 0;
    let dirty = false;

    for (const comment of newComments) {
        // Sem escrever no histórico: fatos permanentes (auto-comentário, já
        // respondido pelo dono, comentário sem permissão de resposta) que
        // fetchNewComments recheca ao vivo — não vale gastar slot de cache.
        if (!comment.canReply || comment.hasOwnerReplyAlready || comment.authorChannelId === channelId) {
            continue;
        }

        const incoming = classifyIncomingComment(comment.text, { channelKey: channel.key });
        if (!incoming.shouldReply) {
            pushEntry(history, { id: comment.commentId, status: 'skipped', reason: incoming.reason });
            dirty = true;
            continue;
        }

        if (countRepliedInLast24h(history) >= MAX_PER_DAY) {
            logger.warn(`[Comment-Bot] "${channel.label}" — limite diário (${MAX_PER_DAY}) atingido, retomando no próximo ciclo dentro da janela de 24h.`);
            break; // não marca — tenta de novo quando a janela liberar
        }
        if (repliedThisCycle >= MAX_PER_CYCLE) {
            logger.info(`[Comment-Bot] "${channel.label}" — limite por ciclo (${MAX_PER_CYCLE}) atingido, resto fica pro próximo ciclo.`);
            break; // não marca — tenta de novo no próximo ciclo
        }

        let replyText;
        try {
            replyText = await generateReply(comment.text, { channelKey: channel.key, authorName: comment.authorDisplayName });
        } catch (err) {
            logger.warn(`[Comment-Bot] "${channel.label}" — geração de resposta falhou: ${err.message}`);
            pushEntry(history, { id: comment.commentId, status: 'skipped', reason: `generation_failed:${err.message}` });
            dirty = true;
            continue;
        }

        let outgoing = classifyOutgoingReply(replyText);
        if (!outgoing.safe) {
            // 1 retry mais conservador antes de desistir (mesmo padrão do
            // retry único de metadata.js em erro crítico de validação).
            try {
                const retryText = await generateReply(
                    `${comment.text}\n\n[INSTRUÇÃO EXTRA: seja mais curto, mais genérico e mais conservador — a resposta anterior foi rejeitada pelo filtro de segurança]`,
                    { channelKey: channel.key, authorName: comment.authorDisplayName }
                );
                outgoing = classifyOutgoingReply(retryText);
            } catch { /* mantém o veredito reprovado do 1º try */ }
        }
        if (!outgoing.safe) {
            pushEntry(history, { id: comment.commentId, status: 'skipped', reason: outgoing.reason });
            dirty = true;
            continue;
        }

        const finalText = outgoing.cleaned;

        if (dryRun) {
            logger.info(
                `[Comment-Bot] 🧪 (DRY-RUN) "${channel.label}" — @${comment.authorDisplayName}: ` +
                `"${comment.text.slice(0, 80)}" → "${finalText}"`
            );
            pushEntry(history, { id: comment.commentId, status: 'dry-run' });
            dirty = true;
            continue;
        }

        const delayMs = randomReplyDelayMs();
        logger.info(`[Comment-Bot] Aguardando ${Math.round(delayMs / 1000)}s antes de responder (espaçamento humano)...`);
        await new Promise((r) => setTimeout(r, delayMs));

        try {
            await postReply(client, comment.commentId, finalText);
            pushEntry(history, { id: comment.commentId, status: 'replied' });
            saveHistory(channel.historyFile, history); // salva imediatamente — segurança contra crash
            dirty = false;
            repliedThisCycle++;
            logger.success(`[Comment-Bot] "${channel.label}" — respondeu @${comment.authorDisplayName}: "${finalText}"`);
        } catch (err) {
            const reason = err?.response?.data?.error?.errors?.[0]?.reason;
            const permanent = reason === 'commentsDisabled' || reason === 'forbidden' || err?.code === 403;
            if (permanent) {
                pushEntry(history, { id: comment.commentId, status: 'skipped', reason: `post_failed:${reason || err.message}` });
                dirty = true;
            } else {
                logger.warn(`[Comment-Bot] "${channel.label}" — falha transitória ao postar, tenta de novo no próximo ciclo: ${err.message}`);
            }
        }
    }

    if (dirty) saveHistory(channel.historyFile, history);
}

/**
 * Inicia o Comment Bot. Roda pra sempre (ou 1 ciclo, com `once: true`).
 * @param {string[]} filterNames - chaves de canal (ver channels.js), vazio = todos
 * @param {{ dryRun?: boolean, once?: boolean }} [opts]
 */
export async function startCommentBot(filterNames = [], opts = {}) {
    const dryRun = opts.dryRun ?? (process.env.COMMENT_BOT_DRY_RUN !== 'false');
    const once = opts.once === true;

    const targets = filterNames.length > 0
        ? COMMENT_BOT_CHANNELS.filter((c) => filterNames.includes(c.key))
        : COMMENT_BOT_CHANNELS;

    if (targets.length === 0) {
        logger.error('[Comment-Bot] Nenhum canal corresponde ao filtro fornecido.');
        return;
    }

    if (dryRun) {
        logger.warn('[Comment-Bot] 🧪 DRY-RUN ativo — respostas serão logadas, NUNCA publicadas. Defina COMMENT_BOT_DRY_RUN=false pra ligar de vez.');
    }

    // eslint-disable-next-line no-constant-condition
    while (true) {
        for (const channel of targets) {
            if (disabledChannels.has(channel.key)) continue;
            try {
                await processChannel(channel, { dryRun });
            } catch (err) {
                if (err instanceof YouTubeAuthError) {
                    disabledChannels.add(channel.key);
                    logger.error(`[Comment-Bot] ${err.message} — canal "${channel.label}" desativado até reiniciar o processo.`);
                } else {
                    logger.warn(`[Comment-Bot] Erro inesperado em "${channel.label}": ${err.message}`);
                }
            }
        }

        if (once) return;

        logger.info(`[Comment-Bot] Próxima checagem em ${POLL_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}
