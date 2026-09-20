// src/comment-bot/channels.js
// Registro dos canais do YouTube atendidos pelo Comment Bot. Por CANAL, não
// por persona — um comentário no canal principal não é atribuível a qual das
// 6 personas de forma barata, então a voz do canal principal é genérica.

export const COMMENT_BOT_CHANNELS = [
    {
        key: 'main',
        label: 'Corte Certo 034 (canal principal)',
        refreshTokenEnv: 'YOUTUBE_REFRESH_TOKEN_MAIN',
        voice: 'main',
        historyFile: './tmp/comment-bot-history-main.json',
    },
    {
        key: 'fe',
        label: 'Canal da Fé',
        refreshTokenEnv: 'YOUTUBE_REFRESH_TOKEN_FE',
        voice: 'fe',
        historyFile: './tmp/comment-bot-history-fe.json',
    },
    {
        key: 'infantil',
        label: 'Canal Infantil',
        refreshTokenEnv: 'YOUTUBE_REFRESH_TOKEN_INFANTIL',
        voice: 'infantil',
        historyFile: './tmp/comment-bot-history-infantil.json',
    },
];

// GTA VI (FOCONOGTAVI) removido em 19/09/2026: a API de Dados retorna
// "account suspended" pra esse canal de forma persistente (não é o
// invalid_grant genérico que afetou os outros 3 — upload via Playwright
// segue funcionando normal, só o acesso via API que está bloqueado). Sem
// solução conhecida ainda; reavaliar se o Google liberar de novo. Ver
// memória project_gta6_youtube_suspended.

export function getChannelByKey(key) {
    return COMMENT_BOT_CHANNELS.find((c) => c.key === key) ?? null;
}
