// src/comment-bot/youtube-comments.js
// Wrapper fino sobre a YouTube Data API v3 pra ler/responder comentários.
// Nomes propositalmente genéricos (não YouTube-específicos) pra um futuro
// src/comment-bot/tiktok.js poder implementar a mesma forma sem reescrever
// o monitor.

/**
 * Busca os comentários mais recentes do canal inteiro numa única chamada
 * (equivalente à caixa de entrada unificada do YouTube Studio) — muito mais
 * barato em cota do que iterar vídeo por vídeo.
 *
 * @param {import('googleapis').youtube_v3.Youtube} youtubeClient
 * @param {string} channelId
 * @returns {Promise<Array<{
 *   threadId: string, commentId: string, text: string,
 *   authorChannelId: string|null, authorDisplayName: string,
 *   canReply: boolean, hasOwnerReplyAlready: boolean, publishedAt: string,
 * }>>}
 */
export async function fetchNewComments(youtubeClient, channelId, { maxResults = 50 } = {}) {
    let res;
    try {
        res = await youtubeClient.commentThreads.list({
            part: ['snippet', 'replies'],
            allThreadsRelatedToChannelId: channelId,
            order: 'time',
            maxResults,
            textFormat: 'plainText',
        });
    } catch (err) {
        const reason = err?.response?.data?.error?.errors?.[0]?.reason;
        if (reason === 'commentsDisabled') {
            // Canal/vídeo com comentários desativados (comum no conteúdo
            // "feito para crianças") — não é erro, é esperado.
            return [];
        }
        throw err;
    }

    const items = res.data.items ?? [];

    return items.map((thread) => {
        const topLevel = thread.snippet?.topLevelComment;
        const snippet = topLevel?.snippet;
        const ownerReplied = (thread.replies?.comments ?? []).some(
            (reply) => reply.snippet?.authorChannelId?.value === channelId
        );

        return {
            threadId: thread.id,
            commentId: topLevel?.id,
            text: snippet?.textOriginal ?? snippet?.textDisplay ?? '',
            authorChannelId: snippet?.authorChannelId?.value ?? null,
            authorDisplayName: snippet?.authorDisplayName ?? '',
            canReply: thread.snippet?.canReply !== false,
            hasOwnerReplyAlready: ownerReplied,
            publishedAt: snippet?.publishedAt ?? null,
        };
    });
}

/**
 * Responde um comentário existente (NÃO cria um comentário novo — para isso
 * seria `commentThreads.insert`, que é um endpoint diferente).
 *
 * @param {import('googleapis').youtube_v3.Youtube} youtubeClient
 * @param {string} parentCommentId
 * @param {string} text
 */
export async function postReply(youtubeClient, parentCommentId, text) {
    await youtubeClient.comments.insert({
        part: ['snippet'],
        requestBody: {
            snippet: {
                parentId: parentCommentId,
                textOriginal: text,
            },
        },
    });
}
