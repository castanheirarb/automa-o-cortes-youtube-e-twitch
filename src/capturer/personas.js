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
//   youtubeProfileDir / tiktokProfileDir / instagramProfileDir → roteia a persona pra um
//                   perfil de navegador Playwright dedicado (conta própria) em vez da conta
//                   principal — quando presente, SEMPRE tenta aquela plataforma, ignorando o
//                   interruptor global (UPLOAD_TO_YOUTUBE/TIKTOK/INSTAGRAM no .env).
//   skipYoutube / skipTikTok / skipInstagram → desliga a postagem numa plataforma específica
//                   pra essa persona (a captação continua normal).

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
    // YouTube TOTALMENTE RESTAURADO (08/09/2026): canal antigo tinha levado
    // copyright strike da Soares Music Digital em 24/08/2026 e nunca voltou —
    // conta nova criada do zero (gcastanheira64@gmail.com), logada e validada
    // de ponta a ponta (poster/session-check.js) antes de reativar. TikTok
    // (chrome-tiktok-02) nunca saiu do ar. Shorts dos cortes do próprio Bispo
    // voltam normalmente nas duas plataformas.
    // Vídeo longo segue DESLIGADO de propósito (LONG_VIDEO_FE_ENABLED=false) —
    // a fonte antiga (prédica/live inteira do próprio canal) foi exatamente o
    // que causou o strike; antes de religar, decidir uma fonte de conteúdo
    // religioso pra vídeo longo que não repita esse risco (ver pesquisa em
    // memória/histórico de 08/09/2026).
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

    // ── Canal infantil (posta no perfil dedicado chrome-youtube-03) ─────────
    // Reativado (02/09/2026) com o canal substituto (conta nova, ferfertanus@
    // hotmail.com — a antiga sessão do Luccas Neto ficou em
    // profiles/chrome-youtube-03-luccasneto-old, não foi apagada). Só os
    // CORTES do Luccas Neto voltam por enquanto — a geração por IA
    // (CANALINFANTIL_PERSONA) segue desligada de propósito
    // (CANALINFANTIL_IN_ROTATION=false no .env) até decidirmos reativar
    // também. skipTikTok: true porque a conta de TikTok desse canal ainda
    // não existe/logou.
    // skipYoutube removido em 19/09/2026: suspensão de 07/09 confirmada revertida
    // (poster/session-check.js validou acesso real ao studio.youtube.com, não só
    // sessão de navegador salva). Se voltar a falhar, ver histórico em memória
    // (project_canalinfantil_youtube_suspended).
    {
        name: 'lucasneto',
        displayName: 'Luccas Neto',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@luccasneto/videos',
        clipsPerRun: 5,
        videoOffset: 1,
        niche: 'infantil',
        weight: 1,
        youtubeProfileDir: process.env.CANALINFANTIL_PROFILE || './profiles/chrome-youtube-03',
        skipTikTok: true,
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

    // ── TikTok (lives — monitor orientado a evento, ver live-monitor-tiktok.js) ──
    // channelUrl = @handle sem o "@". Handles pesquisados em 03/09/2026 —
    // @fejuquinhanovo (MC Feijuca) ainda não teve confirmação visual do dono
    // do projeto, confira antes de assumir 100% certo. Gabizinha e iShow
    // ficaram de fora por ora: Gabizinha tem 2 contas candidatas ativas
    // (@gabizinhalive_ e @gabizinhaolvr) e iShow só apareceu com nome de
    // exibição nos rankings pesquisados, sem @handle confiável — não dá pra
    // adicionar sem arriscar monitorar a conta errada (falha silenciosa: a
    // live nunca dispara e nada acusa erro).
    {
        name: 'wesleyalemao',
        displayName: 'Weslay Alemão',
        platform: 'tiktok',
        channelUrl: 'wesley.alemao_',
        clipsPerRun: 5,
        niche: 'podcast', // treta/confronto — fórmulas de CONFRONTO/POLÊMICA encaixam melhor que 'react'
        weight: 2,
    },
    {
        name: 'mcfeijuca',
        displayName: 'MC Feijuca',
        platform: 'tiktok',
        channelUrl: 'fejuquinhanovo', // pendente de confirmação visual — ver nota acima
        clipsPerRun: 5,
        niche: 'podcast',
        weight: 2,
    },
    {
        name: 'buzeira',
        displayName: 'Buzeira',
        platform: 'tiktok',
        channelUrl: 'buzeira',
        clipsPerRun: 5,
        niche: 'podcast',
        weight: 2,
    },
    {
        name: 'anamcqueen',
        displayName: 'Ana McQueen',
        platform: 'tiktok',
        channelUrl: '_annamcqueen',
        clipsPerRun: 5,
        niche: 'default',
        weight: 1,
        // O nome colide demais com coisa famosa pra busca por nome funcionar
        // (achado na prática 08/09/2026, 2 tentativas seguidas erradas: 1x
        // Relâmpago McQueen/Pixar, 1x Anna do Frozen/Disney) — desliga só o
        // backfill por busca; o monitor de live normal usa o @handle exato e
        // não sofre desse problema.
        skipBackfillSearch: true,
    },

    // ── Desativadas (re-ative movendo de volta para cima) ────────────────────
    // { name: 'fontinele', displayName: 'Fontinele', platform: 'youtube', channelUrl: 'https://www.youtube.com/@OFontinele/videos', clipsPerRun: 5, videoOffset: 2, niche: 'podcast' },
    // { name: 'lubatv', displayName: 'LubaTV', platform: 'youtube', channelUrl: 'https://www.youtube.com/@LubaTV/videos', clipsPerRun: 5, videoOffset: 2, niche: 'react' },
    // { name: 'brino', displayName: 'Brino (BruninZor)', platform: 'twitch', channelUrl: 'bruninzor', youtubeUrl: null, clipsPerRun: 5, niche: 'gaming' },
    // { name: 'mount', displayName: 'Mount', platform: 'twitch', channelUrl: 'mount', youtubeUrl: null, clipsPerRun: 5, niche: 'gaming' },
    // { name: 'felps', displayName: 'Felps', platform: 'twitch', channelUrl: 'felps', youtubeUrl: 'https://www.youtube.com/@felps/videos', clipsPerRun: 5, niche: 'gaming' },
];

export const PERSONAS_MAP = Object.fromEntries(PERSONAS.map((p) => [p.name, p]));
