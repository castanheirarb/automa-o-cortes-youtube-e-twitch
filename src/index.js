// src/index.js
// Ponto de entrada da aplicação Canal Corte.
// Uso: node src/index.js <url-do-video> [quantidade-de-clipes]

import 'dotenv/config';
import { detectPlatform, extractTwitchVodId } from './utils/helpers.js';
import { logger } from './utils/logger.js';
import { getYoutubePeaks } from './platforms/youtube.js';
import { getTwitchPeak } from './platforms/twitch.js';
import { processClip, initBinaries } from './processor/ffmpeg.js';

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner(platform, totalClips) {
    console.log('\n\x1b[35m' + '═'.repeat(52) + '\x1b[0m');
    console.log('\x1b[35m  🎬  CANAL CORTE — Automação de Clipes\x1b[0m');
    console.log(
        `\x1b[35m      ${platform.toUpperCase()} → ${totalClips} clipe(s) em 9:16\x1b[0m`
    );
    console.log('\x1b[35m' + '═'.repeat(52) + '\x1b[0m\n');
}

// ─── Orquestrador ─────────────────────────────────────────────────────────────

/**
 * Pipeline principal:
 * 1. Detecta plataforma
 * 2. Busca os N maiores picos de audiência
 * 3. Gera um clipe 9:16 para cada pico
 */
async function createClips(videoUrl, totalClips) {
    // Inicializa caminhos dos binários uma única vez
    initBinaries();

    logger.step('1/3 — Identificando plataforma...');
    const platform = detectPlatform(videoUrl);
    logger.success(`Plataforma detectada: ${platform.toUpperCase()}`);

    printBanner(platform, totalClips);

    // ── Etapa 2: Buscar os picos ──────────────────────────────────────────────
    logger.step(`2/3 — Mapeando os ${totalClips} maiores picos de audiência...`);

    let peaks = [];

    if (platform === 'youtube') {
        peaks = await getYoutubePeaks(videoUrl, totalClips);
        // Cada peak já inclui { peakTime, title, duration, videoUrl }

    } else if (platform === 'twitch') {
        // Twitch: retorna apenas 1 clipe (o mais assistido)
        // Para múltiplos, seria necessário mapear os N top clips
        const vodId = extractTwitchVodId(videoUrl);
        const twitchData = await getTwitchPeak(vodId);
        peaks = [{
            videoUrl,
            peakTime: twitchData.peakTime,
            title: twitchData.title,
            duration: undefined,
        }];
        if (totalClips > 1) {
            logger.warn(
                `Twitch: atualmente suporta apenas 1 clipe por VOD (o mais assistido). ` +
                `Gerando 1 clipe.`
            );
        }
    }

    if (peaks.length === 0) {
        throw new Error('Nenhum pico encontrado. Encerrando.');
    }

    // ── Etapa 3: Processar cada clipe ────────────────────────────────────────
    logger.step(`3/3 — Processando ${peaks.length} clipe(s) com FFmpeg...`);

    const savedPaths = [];
    const failedClips = [];

    for (let i = 0; i < peaks.length; i++) {
        const clipNumber = i + 1;
        console.log(`\n\x1b[33m  ── Clipe ${clipNumber}/${peaks.length} ──────────────────────────────\x1b[0m`);

        try {
            const outputPath = await processClip(peaks[i], clipNumber, peaks.length);
            savedPaths.push(outputPath);
        } catch (err) {
            logger.error(`Clipe ${clipNumber}/${peaks.length} falhou: ${err.message}`);
            failedClips.push(clipNumber);
            // Continua para o próximo clipe mesmo se um falhar
        }
    }

    // ── Resumo final ──────────────────────────────────────────────────────────
    console.log('\n\x1b[32m' + '═'.repeat(52) + '\x1b[0m');
    console.log(`\x1b[32m  ✅  ${savedPaths.length}/${peaks.length} clipes finalizados!\x1b[0m`);
    savedPaths.forEach((p, i) => {
        console.log(`\x1b[32m  📁  [${i + 1}] ${p}\x1b[0m`);
    });
    if (failedClips.length > 0) {
        console.log(`\x1b[31m  ⚠️   Clipes com falha: ${failedClips.join(', ')}\x1b[0m`);
    }
    console.log('\x1b[32m' + '═'.repeat(52) + '\x1b[0m\n');
}

// ─── Entrada via CLI ──────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const videoUrl = args[0];
const totalClips = parseInt(args[1] || '15', 10);

if (!videoUrl) {
    console.error('\n\x1b[31m  ❌  Uso: node src/index.js <url-do-video> [quantidade]\x1b[0m');
    console.error('  Exemplos:');
    console.error('    node src/index.js "https://www.youtube.com/watch?v=ID"');
    console.error('    node src/index.js "https://www.youtube.com/watch?v=ID" 10');
    console.error('    node src/index.js "https://www.twitch.tv/videos/ID"\n');
    process.exit(1);
}

if (isNaN(totalClips) || totalClips < 1 || totalClips > 50) {
    console.error('\x1b[31m  ❌  Quantidade de clipes inválida. Use um número entre 1 e 50.\x1b[0m');
    process.exit(1);
}

createClips(videoUrl, totalClips).catch((err) => {
    logger.error(err.message);
    if (process.env.DEBUG) console.error(err);
    process.exit(1);
});
