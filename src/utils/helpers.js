// src/utils/helpers.js
// Funções utilitárias de uso geral

/**
 * Detecta a plataforma a partir da URL do vídeo.
 * @param {string} url
 * @returns {'youtube' | 'twitch'}
 */
export function detectPlatform(url) {
    const lowerUrl = url.toLowerCase();
    if (lowerUrl.includes('youtube.com') || lowerUrl.includes('youtu.be')) {
        return 'youtube';
    }
    if (lowerUrl.includes('twitch.tv')) {
        return 'twitch';
    }
    throw new Error(`Plataforma não reconhecida para a URL: ${url}`);
}

/**
 * Extrai o ID de um VOD da Twitch a partir da URL.
 * Suporta formatos:
 *   - https://www.twitch.tv/videos/123456789
 * @param {string} url
 * @returns {string} vodId
 */
export function extractTwitchVodId(url) {
    const match = url.match(/twitch\.tv\/videos\/(\d+)/i);
    if (!match) {
        throw new Error(
            `Não foi possível extrair o ID do VOD Twitch da URL: ${url}. ` +
            `O formato esperado é: https://www.twitch.tv/videos/ID`
        );
    }
    return match[1];
}

/**
 * Formata segundos para exibição legível (ex: 3661 -> "1h 01m 01s")
 * @param {number} totalSeconds
 * @returns {string}
 */
export function formatDuration(totalSeconds) {
    const h = Math.floor(totalSeconds / 3600);
    const m = Math.floor((totalSeconds % 3600) / 60);
    const s = Math.floor(totalSeconds % 60);
    return [
        h > 0 ? `${h}h` : null,
        `${String(m).padStart(2, '0')}m`,
        `${String(s).padStart(2, '0')}s`,
    ]
        .filter(Boolean)
        .join(' ');
}

/**
 * Sanitiza um nome de arquivo removendo caracteres inválidos.
 * @param {string} name
 * @returns {string}
 */
export function sanitizeFilename(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')
        .replace(/\s+/g, '_')
        .substring(0, 100);
}
