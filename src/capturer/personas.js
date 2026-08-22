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
    {
        name: 'bispobrunoleonardo',
        displayName: 'Bispo Bruno Leonardo',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@BispoBrunoLeonardo/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'religioso',
        weight: 1,
        // Roteamento: cortes desta persona vão SOMENTE para o canal religioso
        // (YouTube) e a conta de TikTok dedicada do Canal da Fé — nunca para a
        // conta principal. Perfis criados via:
        //   node poster/login.js --platform youtube --profile ./profiles/chrome-youtube-02
        //   node poster/login.js --platform tiktok   --profile ./profiles/chrome-tiktok-02
        youtubeProfileDir: './profiles/chrome-youtube-02',
        tiktokProfileDir: './profiles/chrome-tiktok-02',
        // Lives de oração não geram "Most Replayed" — usa picos uniformes
        uniformPeaksFallback: true,
    },

    // ── Canal infantil (posta no perfil dedicado chrome-youtube-03) ─────────
    {
        name: 'lucasneto',
        displayName: 'Luccas Neto',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@luccasneto/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'infantil',
        weight: 1,
        // Roteamento: cortes desta persona vão SOMENTE para o canal infantil
        // (mesmo perfil do Canal Infantil gerado por IA) — nunca para a conta
        // principal. Perfil criado via:
        //   node poster/login.js --platform youtube --profile ./profiles/chrome-youtube-03
        youtubeProfileDir: process.env.CANALINFANTIL_PROFILE || './profiles/chrome-youtube-03',
        skipTikTok: true, // Canal Infantil não posta no TikTok (mesma regra do vídeo gerado)
        // Conteúdo infantil — declaração obrigatória (COPPA) na etapa de upload.
        madeForKids: true,
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
    // { name: 'fontinele', displayName: 'Fontinele', platform: 'youtube', channelUrl: 'https://www.youtube.com/@OFontinele/videos', clipsPerRun: 5, videoOffset: 2, niche: 'podcast' },
    // { name: 'lubatv', displayName: 'LubaTV', platform: 'youtube', channelUrl: 'https://www.youtube.com/@LubaTV/videos', clipsPerRun: 5, videoOffset: 2, niche: 'react' },
    // { name: 'brino', displayName: 'Brino (BruninZor)', platform: 'twitch', channelUrl: 'bruninzor', youtubeUrl: null, clipsPerRun: 5, niche: 'gaming' },
    // { name: 'mount', displayName: 'Mount', platform: 'twitch', channelUrl: 'mount', youtubeUrl: null, clipsPerRun: 5, niche: 'gaming' },
    // { name: 'felps', displayName: 'Felps', platform: 'twitch', channelUrl: 'felps', youtubeUrl: 'https://www.youtube.com/@felps/videos', clipsPerRun: 5, niche: 'gaming' },
];

export const PERSONAS_MAP = Object.fromEntries(PERSONAS.map((p) => [p.name, p]));
