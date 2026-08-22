// src/capturer/sports-channels.js
// Canais de esporte monitorados automaticamente pelo Sports Monitor.
// Cobre tanto transmissões/reações de jogo completo (onde o chat tem picos de
// "gol") quanto conteúdo esportivo geral — resenha, entrevista, humor — onde o
// VodMiner cai automaticamente no fallback de heatmap (Most Replayed) do
// próprio vídeo, já que não há keyword de gol nesse tipo de conteúdo.
//
// minDurationSec (opcional): sobrescreve SPORTS_MONITOR_MIN_DURATION por canal.
// Útil se um canal específico publica conteúdo mais curto ou mais longo que a média.
//
// titleFilter (opcional): string (case-insensitive) que o título do vídeo precisa
// conter para ser minerado. Essencial para canais "guarda-chuva" como o Podpah,
// que publica muito conteúdo que não é da Quebrada FC — sem esse filtro o monitor
// mineraria todo episódio do Podpah como se fosse esporte (e duplicaria trabalho
// com o Trend Hunter, que já cobre o Podpah como podcast).
// scanDepth (opcional): quantos vídeos recentes verificar por ciclo (padrão: 5).
// Canais com publicação muito frequente precisam de um valor maior para não
// perder o vídeo relevante em meio a outros uploads do dia.

export const SPORTS_CHANNELS = [
    {
        name: 'cazetv',
        displayName: 'CazeTV',
        channelUrl: 'https://www.youtube.com/@CazeTV/videos',
        clipsPerRun: 3,
    },
    {
        name: 'desimpedidos',
        displayName: 'Desimpedidos',
        channelUrl: 'https://www.youtube.com/@desimpedidos/videos',
        clipsPerRun: 3,
    },
    {
        name: 'quebradafc',
        displayName: 'Quebrada FC (Podpah)',
        channelUrl: 'https://www.youtube.com/@Podpah/videos',
        clipsPerRun: 3,
        // O Podpah publica muito conteúdo que não é Quebrada FC — filtra por título.
        // Ajuste essa string se os episódios usarem outro padrão de título.
        titleFilter: 'quebrada',
        scanDepth: 15,
    },
];
