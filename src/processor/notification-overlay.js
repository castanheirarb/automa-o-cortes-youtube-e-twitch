// src/processor/notification-overlay.js
// Integrado ao processClip (src/processor/ffmpeg.js) — todo clipe dos 3
// canais passa por aqui. Insere no INÍCIO e no FIM do vídeo um popup estilo
// notificação do iPhone ("Inscreva-se e deixe seu like!") com som de
// notificação, deslizando do topo da tela. Ícone = logo do canal (circular).
//
// Uso isolado para testes:
//   node src/processor/notification-overlay.js <video.mp4> [saida.mp4] [logo.png]

import sharp from 'sharp';
import ffmpeg from 'fluent-ffmpeg';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { initBinaries } from './ffmpeg.js';

const SOUND_PATH = path.resolve(process.env.NOTIFICATION_SOUND_PATH || './assets/sfx/notification-placeholder.mp3');

// ─── Marca por canal (logo + nome exibido no banner) ─────────────────────────
// A pasta de output de cada persona (ex.: output/bispobrunoleonardo/...)
// identifica a qual dos 3 canais o clipe pertence.

const LOGO_DIR = path.resolve('./assets/logos');

const CHANNEL_BRANDING = {
    // Renomeado em 17/09/2026 (a pedido): "Canal Infantil" → "FÃS DO LUCCAS NETO".
    canalinfantil: { appName: 'FÃS DO LUCCAS NETO', logoPath: path.join(LOGO_DIR, 'canal-infantil.jpg') },
    lucasneto: { appName: 'FÃS DO LUCCAS NETO', logoPath: path.join(LOGO_DIR, 'canal-infantil.jpg') },
    // Renomeado em 17/09/2026 (a pedido): canal "Canal da Fé" não existe mais,
    // o canal religioso atual se chama "Fé Move Montanhas"
    // (youtube.com/@FéMoveMontanhasAmém).
    bispobrunoleonardo: { appName: 'Fé Move Montanhas', logoPath: path.join(LOGO_DIR, 'canal-da-fe.jpg') },
    canaldafe: { appName: 'Fé Move Montanhas', logoPath: path.join(LOGO_DIR, 'canal-da-fe.jpg') },
    // Faltava — todo clipe do GTA6 Hunter caía no fallback (Corte Certo 034)
    // e mostrava a notificação errada. Logo baixada do avatar real do canal
    // (@FOCONOGTAVI) via YouTube Data API em 08/09/2026.
    gta6hunter: { appName: 'FOCO NO GTAVI', logoPath: path.join(LOGO_DIR, 'gta6.jpg') },
};
const DEFAULT_BRANDING = { appName: 'Corte Certo 034', logoPath: path.join(LOGO_DIR, 'corte-certo-034.jpg') };

/**
 * Identifica o canal (e a logo correspondente) a partir do diretório de
 * output do clipe — a pasta da persona é sempre um segmento do caminho.
 * @param {string} outputBaseDir
 * @returns {{ appName: string, logoPath: string }}
 */
export function resolveChannelBranding(outputBaseDir) {
    const parts = path.resolve(outputBaseDir).replace(/\\/g, '/').split('/');
    const key = parts.find((p) => CHANNEL_BRANDING[p]);
    const branding = key ? CHANNEL_BRANDING[key] : DEFAULT_BRANDING;
    return fs.existsSync(branding.logoPath) ? branding : { ...branding, logoPath: null };
}

// ─── Banner estilo iOS (SVG + logo → PNG via sharp) ──────────────────────────

const BANNER_WIDTH = 984;
const BANNER_HEIGHT = 208;
const BANNER_RADIUS = 34;
const ICON_SIZE = 128;

/**
 * Recorta uma imagem de logo num círculo de ICON_SIZE px (PNG com alpha),
 * pronta pra ser composta no banner.
 */
async function renderCircularLogo(logoPath) {
    const mask = Buffer.from(
        `<svg width="${ICON_SIZE}" height="${ICON_SIZE}"><circle cx="${ICON_SIZE / 2}" cy="${ICON_SIZE / 2}" r="${ICON_SIZE / 2}" fill="#fff"/></svg>`
    );
    return sharp(logoPath)
        .resize(ICON_SIZE, ICON_SIZE, { fit: 'cover' })
        .composite([{ input: mask, blend: 'dest-in' }])
        .png()
        .toBuffer();
}

/**
 * Gera o PNG do banner de notificação (com transparência), estilo iOS:
 * cartão branco translúcido arredondado, ícone circular (logo do canal, ou
 * sino como fallback) e duas linhas de texto (app + mensagem).
 */
async function renderBannerPng({
    appName = 'Corte Certo 034',
    title = 'Gostou do vídeo?',
    subtitle = 'Inscreva-se e deixe seu like! 👍',
    logoPath = null,
} = {}) {
    const pad = 32;
    const iconX = pad;
    const iconY = (BANNER_HEIGHT - ICON_SIZE) / 2;
    const textX = iconX + ICON_SIZE + 28;

    const hasLogo = logoPath && fs.existsSync(logoPath);

    const iconSvg = hasLogo
        ? '' // logo entra depois via composite (raster), não dá pra embutir arquivo externo no <image> sem base64 grande
        : `<circle cx="${iconX + ICON_SIZE / 2}" cy="${iconY + ICON_SIZE / 2}" r="${ICON_SIZE / 2}" fill="url(#iconGrad)"/>
           <g transform="translate(${iconX + ICON_SIZE / 2}, ${iconY + ICON_SIZE / 2})" fill="#FFFFFF">
               <path d="M0,-34 C17,-34 30,-21 30,-4 L30,14 L38,28 L-38,28 L-30,14 L-30,-4 C-30,-21 -17,-34 0,-34 Z"/>
               <circle cx="0" cy="38" r="9"/>
           </g>`;

    const svg = `
    <svg width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}" xmlns="http://www.w3.org/2000/svg">
        <defs>
            <filter id="shadow" x="-20%" y="-20%" width="140%" height="160%">
                <feDropShadow dx="0" dy="8" stdDeviation="18" flood-color="#000000" flood-opacity="0.35"/>
            </filter>
            <linearGradient id="iconGrad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stop-color="#FF3B5C"/>
                <stop offset="100%" stop-color="#FF2D55"/>
            </linearGradient>
        </defs>

        <g filter="url(#shadow)">
            <rect x="0" y="0" width="${BANNER_WIDTH}" height="${BANNER_HEIGHT}"
                  rx="${BANNER_RADIUS}" ry="${BANNER_RADIUS}"
                  fill="#FFFFFF" fill-opacity="0.94"/>
        </g>

        ${iconSvg}

        <text x="${textX}" y="76" font-family="Arial, Helvetica, sans-serif" font-size="30" font-weight="700" fill="#0B0B0C">${escapeXml(appName)}</text>
        <text x="${textX}" y="120" font-family="Arial, Helvetica, sans-serif" font-size="34" font-weight="700" fill="#0B0B0C">${escapeXml(title)}</text>
        <text x="${textX}" y="164" font-family="Arial, Helvetica, sans-serif" font-size="30" fill="#3A3A3C">${escapeXml(subtitle)}</text>
    </svg>`;

    const pngPath = path.join(os.tmpdir(), `notif-banner-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);

    if (hasLogo) {
        const logoBuf = await renderCircularLogo(logoPath);
        await sharp(Buffer.from(svg))
            .composite([{ input: logoBuf, left: iconX, top: Math.round(iconY) }])
            .png()
            .toFile(pngPath);
    } else {
        await sharp(Buffer.from(svg)).png().toFile(pngPath);
    }

    return pngPath;
}

function escapeXml(str) {
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;');
}

async function probeDuration(videoPath) {
    return new Promise((resolve, reject) => {
        ffmpeg.ffprobe(videoPath, (err, data) => {
            if (err) return reject(err);
            resolve(data.format.duration);
        });
    });
}

/**
 * Insere popups de notificação (visual + som) no INÍCIO e no FIM de um vídeo
 * já pronto, num único encode. Cada popup fica 3s totalmente visível (mais o
 * tempo do slide de entrada/saída).
 *
 * @param {string} inputPath - vídeo de entrada (9:16, já cortado/editado)
 * @param {string} outputPath - onde salvar o vídeo com os popups
 * @param {object} [opts]
 * @param {'start'|'end'|'both'} [opts.moments] - onde inserir (default 'both')
 * @param {number} [opts.startAtSeconds] - instante do popup inicial (default 1.0s)
 * @param {number} [opts.endLeadSeconds] - quanto antes do fim o popup final começa (default: cabe os 3s + slides antes do fim)
 * @param {number} [opts.slideMs] - duração da animação de entrada/saída (ms, default 350)
 * @param {number} [opts.holdMs] - quanto tempo o banner fica TOTALMENTE visível (ms, default 3000)
 * @param {string} [opts.appName] - nome exibido (default "Corte Certo 034")
 * @param {string} [opts.title]
 * @param {string} [opts.subtitle]
 * @param {string} [opts.logoPath] - caminho pra logo do canal (PNG/JPG); sem isso usa o sino padrão
 * @returns {Promise<string>} outputPath
 */
export async function addNotificationPopup(inputPath, outputPath, opts = {}) {
    const {
        moments = 'both',
        slideMs = 350,
        holdMs = 3000,
        appName = 'Corte Certo 034',
        title = 'Gostou do vídeo?',
        subtitle = 'Inscreva-se e deixe seu like! 👍',
        logoPath = null,
    } = opts;

    if (!fs.existsSync(SOUND_PATH)) {
        throw new Error(`Som de notificação não encontrado em ${SOUND_PATH}`);
    }

    const duration = await probeDuration(inputPath);
    const slideS = slideMs / 1000;
    const holdS = holdMs / 1000;
    const totalAnimS = slideS * 2 + holdS;

    // Calcula os instantes de início de cada popup, garantindo que caibam
    // sem se sobrepor mesmo em clipes curtos.
    const startAt = opts.startAtSeconds ?? 1.0;
    let endAt = duration - totalAnimS - 1.0; // 1s de folga antes do fim
    const wantsStart = moments === 'start' || moments === 'both';
    const wantsEnd = moments === 'end' || moments === 'both';

    const points = [];
    if (wantsStart) points.push(startAt);
    if (wantsEnd) {
        if (wantsStart && endAt < startAt + totalAnimS + 0.5) {
            logger.warn('[NotificationOverlay] Vídeo curto demais pra caber os dois popups sem sobrepor — pulando o do fim.');
        } else if (endAt <= 0) {
            logger.warn('[NotificationOverlay] Vídeo curto demais pro popup do fim — pulando.');
        } else {
            points.push(endAt);
        }
    }

    if (points.length === 0) {
        throw new Error('Nenhum popup coube na duração do vídeo.');
    }

    const bannerPath = await renderBannerPng({ appName, title, subtitle, logoPath });

    try {
        const topMargin = 60;
        const hiddenY = -BANNER_HEIGHT - 10;

        const filters = [];
        let lastVideoLabel = '0:v';

        points.forEach((t0, i) => {
            const t1 = t0 + slideS;
            const t2 = t1 + holdS;
            const t3 = t2 + slideS;
            const yExpr =
                `if(between(t,${t0},${t1}), ${hiddenY}+(t-${t0})/${slideS}*${topMargin - hiddenY}, ` +
                `if(between(t,${t1},${t2}), ${topMargin}, ` +
                `if(between(t,${t2},${t3}), ${topMargin}-(t-${t2})/${slideS}*${topMargin - hiddenY}, ${hiddenY})))`;

            const outLabel = `v${i}`;
            filters.push({
                filter: 'overlay',
                options: { x: '(main_w-overlay_w)/2', y: yExpr, enable: `between(t,${t0},${t3})` },
                inputs: [lastVideoLabel, '1:v'],
                outputs: outLabel,
            });
            lastVideoLabel = outLabel;
        });

        // Áudio: um "ding" delayado por ponto, todos mixados com a trilha original.
        const sfxLabels = points.map((t0, i) => {
            const label = `sfx${i}`;
            filters.push({
                filter: 'adelay',
                options: `${Math.round(t0 * 1000)}|${Math.round(t0 * 1000)}`,
                inputs: '2:a',
                outputs: label,
            });
            return label;
        });

        filters.push({
            filter: 'amix',
            options: { inputs: 1 + sfxLabels.length, duration: 'first', dropout_transition: 0 },
            inputs: ['0:a', ...sfxLabels],
            outputs: 'a_out',
        });

        await new Promise((resolve, reject) => {
            ffmpeg(inputPath)
                .input(bannerPath)
                .input(SOUND_PATH)
                .complexFilter(filters)
                .outputOptions([
                    '-map', `[${lastVideoLabel}]`, '-map', '[a_out]',
                    '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-preset', 'fast',
                    '-c:a', 'aac', '-movflags', '+faststart',
                    // O caminho de saída pode não terminar em ".mp4" (nome
                    // temporário do processClip, de propósito — ver
                    // applyNotificationOverlay) — força o muxer explicitamente
                    // em vez de deixar o ffmpeg adivinhar pela extensão.
                    '-f', 'mp4',
                ])
                .output(outputPath)
                .on('start', () => logger.info('[NotificationOverlay] Aplicando popups...'))
                .on('end', resolve)
                .on('error', (err) => reject(new Error(`FFmpeg (notification overlay): ${err.message}`)))
                .run();
        });

        logger.success(
            `[NotificationOverlay] ${points.length} popup(s) inserido(s) em [${points.map((p) => p.toFixed(1)).join('s, ')}s] → ${path.basename(outputPath)}`
        );
        return outputPath;
    } finally {
        fs.unlink(bannerPath, () => {});
    }
}

// ─── CLI de teste isolado ─────────────────────────────────────────────────────
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMain) {
    initBinaries();
    const input = process.argv[2];
    const output = process.argv[3] || input.replace(/\.mp4$/i, '-notif-test.mp4');
    const logoPath = process.argv[4] || null;
    if (!input) {
        console.error('Uso: node src/processor/notification-overlay.js <video.mp4> [saida.mp4] [logo.png]');
        process.exit(1);
    }
    addNotificationPopup(input, output, { logoPath })
        .then((out) => console.log('OK →', out))
        .catch((err) => { console.error('ERRO:', err.message); process.exit(1); });
}
