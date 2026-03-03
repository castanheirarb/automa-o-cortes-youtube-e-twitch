// src/platforms/youtube.js
// Extrai os timestamps dos N maiores picos de audiência ("most replayed") de um VOD do YouTube
// usando yt-dlp via child_process.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

function getYtDlpBin() {
    return process.env.YTDLP_PATH?.trim() || 'yt-dlp';
}

/**
 * Baixa os metadados do vídeo usando yt-dlp (sem baixar o vídeo).
 * @param {string} videoUrl
 * @returns {Promise<object>}
 */
async function fetchVideoMetadata(videoUrl) {
    const ytDlp = getYtDlpBin();
    logger.info(`Buscando metadados via yt-dlp para: ${videoUrl}`);

    const args = [
        '--dump-json',
        '--no-playlist',
        '--skip-download',
        videoUrl,
    ];

    const { stdout } = await execFileAsync(ytDlp, args, {
        maxBuffer: 50 * 1024 * 1024,
    });

    return JSON.parse(stdout);
}

/**
 * Analisa o heatmap do yt-dlp e retorna os N maiores picos,
 * garantindo que nenhum par de picos tenha sobreposição de buffer.
 *
 * @param {object} metadata - JSON retornado pelo yt-dlp
 * @param {number} topN - Quantidade de picos desejados (padrão: 15)
 * @param {number} bufferSeconds - Buffer em segundos (para calcular espaçamento mínimo)
 * @returns {Array<{ peakTime: number, peakValue: number, title: string, duration: number }>}
 */
function analyzeTopPeaks(metadata, topN = 15, bufferSeconds = 30) {
    const { heatmap, title, duration } = metadata;

    if (!heatmap || heatmap.length === 0) {
        throw new Error(
            'Nenhum dado de heatmap ("Most Replayed") encontrado para este vídeo. ' +
            'O vídeo pode ser muito recente, ter poucas visualizações ou não ter esta funcionalidade habilitada.'
        );
    }

    // Calcula o ponto médio de cada segmento e ordena do maior para o menor valor
    const segments = heatmap
        .map((seg) => ({
            peakTime: (seg.start_time + seg.end_time) / 2,
            peakValue: seg.value,
        }))
        .sort((a, b) => b.peakValue - a.peakValue);

    // Distância mínima entre picos = dois buffers (antes + depois de cada pico)
    // para garantir que os clipes gerados não se sobreponham
    const minDistance = bufferSeconds * 2;

    const selectedPeaks = [];

    for (const candidate of segments) {
        if (selectedPeaks.length >= topN) break;

        // Verifica se este candidato está longe o suficiente de todos os picos já selecionados
        const tooClose = selectedPeaks.some(
            (selected) => Math.abs(candidate.peakTime - selected.peakTime) < minDistance
        );

        if (!tooClose) {
            selectedPeaks.push(candidate);
        }
    }

    // Reordena pelos instantes do vídeo (cronológico) para facilitar análise
    selectedPeaks.sort((a, b) => a.peakTime - b.peakTime);

    logger.success(
        `${selectedPeaks.length} pico(s) identificado(s) (de ${topN} solicitados) — "${title}"`
    );
    selectedPeaks.forEach((p, i) => {
        const ts = formatSeconds(p.peakTime);
        logger.info(`  Pico #${i + 1}: ${ts} (intensidade: ${(p.peakValue * 100).toFixed(1)}%)`);
    });

    return selectedPeaks.map((p) => ({ ...p, title, duration }));
}

function formatSeconds(s) {
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = Math.floor(s % 60);
    return h > 0
        ? `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
        : `${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`;
}

/**
 * Função principal do módulo YouTube.
 * Retorna os N maiores picos de audiência do VOD.
 *
 * @param {string} videoUrl
 * @param {number} topN - Quantos picos retornar (padrão: 15)
 * @returns {Promise<Array<{ peakTime, peakValue, title, duration, videoUrl }>>}
 */
export async function getYoutubePeaks(videoUrl, topN = 15) {
    try {
        const bufferSeconds = parseInt(process.env.CLIP_BUFFER_SECONDS || '30', 10);
        const metadata = await fetchVideoMetadata(videoUrl);
        const peaks = analyzeTopPeaks(metadata, topN, bufferSeconds);
        return peaks.map((p) => ({ ...p, videoUrl }));
    } catch (err) {
        throw new Error(`[YouTube] Falha ao obter picos: ${err.message}`);
    }
}
