// src/capturer/personas.js
// Configuração das personas-alvo para captação automática.
// O campo 'niche' define qual banco de fórmulas virais a IA usará.
//
// Campos opcionais:
//   weight        → nº de turnos no rodízio ponderado dos SHORTS (default 1).
//   longWeight    → nº de turnos no rodízio do VÍDEO LONGO diário (default 0 = fora do rodízio).
//   titleKeywords → prioriza vídeos do canal cujo título contenha alguma dessas palavras
//                   (case-insensitive). Vídeos sem match ainda são usados como fallback.
//   layout        → formato do clipe 1080×1920, sobrepõe o padrão do .env:
//                     'hybrid' painel 16:9 nativo no topo + área de legendas (gameplay)
//                     'blur'   frame 16:9 completo centralizado sobre fundo desfocado
//                     'split'  facecam em cima + gameplay embaixo
//                     'asd'    crop 9:16 dinâmico seguindo quem fala (padrão)

export const PERSONAS = [
    // ── YouTube ──────────────────────────────────────────────────────────────
    {
        name: 'cariani',
        displayName: 'Renato Cariani',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@renatocariani/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'fitness',
        weight: 5,     // foco principal nos Shorts
        longWeight: 5, // foco principal nos vídeos longos
        titleKeywords: ['dilera', 'balestrin', 'brunão', 'brunao'],
        uniformPeaksFallback: true,
    },
    {
        name: 'jonvlogs',
        displayName: 'Jon Vlogs',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@JonVlogs/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'react',
        longWeight: 3, // entra no rodízio do vídeo longo diário
        uniformPeaksFallback: true,
    },
    {
        name: 'cortesdocasimito',
        displayName: 'Cortes do Casimito (canal principal)',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@CortesdoCasimitoOFICIAL/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'react',
        weight: 3,
        longWeight: 3,
        uniformPeaksFallback: true,
    },

    // ── Canal religioso (posta no perfil dedicado chrome-youtube-02) ────────
    // Reativado (2026-08-25): só os CORTES CURTOS voltam — o vídeo longo
    // segue pausado de propósito (LONG_VIDEO_FE_ENABLED=false no .env), já
    // que foi ele que tomou o copyright strike da Soares Music Digital em
    // 2026-08-24 (ver histórico). Mitigação de música de fundo (isolamento
    // de voz via Demucs, src/processor/vocal-isolate.js) já entra sozinha
    // pra esse nicho — testada com GPU nos vídeos reais que tomaram strike
    // antes desta reativação.
    {
        name: 'bispobrunoleonardo',
        displayName: 'Bispo Bruno Leonardo',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@BispoBrunoLeonardo/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'religioso',
        weight: 1,
        youtubeProfileDir: './profiles/chrome-youtube-02',
        tiktokProfileDir: './profiles/chrome-tiktok-02',
        uniformPeaksFallback: true,
    },

    // ── Twitch ───────────────────────────────────────────────────────────────
    // Campo youtubeUrl = fallback automático quando VODs forem subscriber-only
    {
        name: 'bistocone',
        displayName: 'Bistecone',
        platform: 'twitch',
        channelUrl: 'bisteconee',
        youtubeUrl: null, // sem canal YouTube relevante
        clipsPerRun: 5,
        niche: 'gaming',
        layout: 'auto', // decide por cena: webcam grande → asd | jogo em tela cheia → hybrid
        weight: 4,
        longWeight: 4, // ⚠️ vídeo longo exige canal YouTube (heatmap) — sem youtubeUrl a vez dele é pulada
    },
    {
        name: 'alanzoka',
        displayName: 'Alanzoka',
        platform: 'twitch',
        channelUrl: 'alanzoka',
        youtubeUrl: 'https://www.youtube.com/@Alanzoka/videos',
        clipsPerRun: 5,
        niche: 'gaming',
        layout: 'auto', // decide por cena: webcam grande → asd | jogo em tela cheia → hybrid
        uniformPeaksFallback: true, // usado só se o fallback omnichannel para YouTube ativar
    },
    {
        name: 'casimiro',
        displayName: 'Casimiro (Casimito)',
        platform: 'twitch',
        channelUrl: 'casimito',
        youtubeUrl: 'https://www.youtube.com/@CazeTV/videos',
        uniformPeaksFallback: true, // usado só se o fallback omnichannel para YouTube ativar
        clipsPerRun: 5,
        niche: 'react',
    },

    // ── Desativadas (re-ative movendo de volta para cima) ────────────────────
    // Canal infantil pausado (2026-08-22): posts desligados enquanto um novo
    // canal é planejado — capturar cortes do Luccas Neto sem destino gera
    // trabalho/API à toa, por isso a persona sai da lista ativa (não só do
    // rodízio do poster). Ver também CANALINFANTIL_IN_ROTATION=false no .env
    // (geração por IA do Canal Infantil, já pausada antes por outro motivo).
    // { name: 'lucasneto', displayName: 'Luccas Neto', platform: 'youtube', channelUrl: 'https://www.youtube.com/@luccasneto/videos', clipsPerRun: 5, videoOffset: 1, niche: 'infantil', weight: 1, youtubeProfileDir: process.env.CANALINFANTIL_PROFILE || './profiles/chrome-youtube-03', skipTikTok: true, madeForKids: true, uniformPeaksFallback: true },
    // { name: 'fontinele', displayName: 'Fontinele', platform: 'youtube', channelUrl: 'https://www.youtube.com/@OFontinele/videos', clipsPerRun: 5, videoOffset: 2, niche: 'podcast' },
    // { name: 'lubatv', displayName: 'LubaTV', platform: 'youtube', channelUrl: 'https://www.youtube.com/@LubaTV/videos', clipsPerRun: 5, videoOffset: 2, niche: 'react' },
    // { name: 'brino', displayName: 'Brino (BruninZor)', platform: 'twitch', channelUrl: 'bruninzor', youtubeUrl: null, clipsPerRun: 5, niche: 'gaming' },
    // { name: 'mount', displayName: 'Mount', platform: 'twitch', channelUrl: 'mount', youtubeUrl: null, clipsPerRun: 5, niche: 'gaming' },
    // { name: 'felps', displayName: 'Felps', platform: 'twitch', channelUrl: 'felps', youtubeUrl: 'https://www.youtube.com/@felps/videos', clipsPerRun: 5, niche: 'gaming' },
];

export const PERSONAS_MAP = Object.fromEntries(PERSONAS.map((p) => [p.name, p]));
