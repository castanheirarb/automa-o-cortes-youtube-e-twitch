// src/capturer/personas.js
// Configuração das personas-alvo para captação automática.
// O campo 'niche' define qual banco de fórmulas virais a IA usará.

export const PERSONAS = [
    // ── YouTube ──────────────────────────────────────────────────────────────
    {
        name: 'cariani',
        displayName: 'Renato Cariani',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@renatocariani/videos',
        clipsPerRun: 5,
        videoOffset: 3,
        niche: 'fitness',
    },
    {
        name: 'fontinele',
        displayName: 'Fontinele',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@OFontinele/videos',
        clipsPerRun: 5,
        videoOffset: 2,
        niche: 'podcast',
    },
    {
        name: 'lubatv',
        displayName: 'LubaTV',
        platform: 'youtube',
        channelUrl: 'https://www.youtube.com/@LubaTV/videos',
        clipsPerRun: 5,
        videoOffset: 2,
        niche: 'react',
    },

    // ── Twitch ───────────────────────────────────────────────────────────────
    {
        name: 'brino',
        displayName: 'Brino (BruninZor)',
        platform: 'twitch',
        channelUrl: 'bruninzor',
        clipsPerRun: 5,
        niche: 'gaming',
    },
    {
        name: 'bistocone',
        displayName: 'Bistocone',
        platform: 'twitch',
        channelUrl: 'bisteconee',
        clipsPerRun: 5,
        niche: 'gaming',
    },
    {
        name: 'mount',
        displayName: 'Mount',
        platform: 'twitch',
        channelUrl: 'mount',
        clipsPerRun: 5,
        niche: 'gaming',
    },
    {
        name: 'alanzoka',
        displayName: 'Alanzoka',
        platform: 'twitch',
        channelUrl: 'alanzoka',
        clipsPerRun: 5,
        niche: 'gaming',
    },
    {
        name: 'felps',
        displayName: 'Felps',
        platform: 'twitch',
        channelUrl: 'felps',
        clipsPerRun: 5,
        niche: 'gaming',
    },
    {
        name: 'casimiro',
        displayName: 'Casimiro (Casimito)',
        platform: 'twitch',
        channelUrl: 'casimito',
        clipsPerRun: 5,
        niche: 'react',
    },
];

export const PERSONAS_MAP = Object.fromEntries(PERSONAS.map((p) => [p.name, p]));
