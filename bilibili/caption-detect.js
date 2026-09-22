// bilibili/caption-detect.js
// Detecção visual leve (sem OCR) de legenda/overlay já queimados no vídeo —
// complementa a heurística por palavra-chave de capture.js
// (looksAlreadyCaptioned), que só pega casos óbvios pelo título (covers).
// Esse aqui pega o caso mais comum na prática: criadores de conteúdo editado
// (VTuber, narrativa) que queimam diálogo/chat como parte do próprio estilo,
// sem nenhuma palavra reveladora no título.
//
// Método: amostra alguns frames do clipe, compara a densidade de borda
// (proxy barato de "tem texto aqui") da faixa INFERIOR do frame contra a
// faixa SUPERIOR do MESMO frame — texto queimado cria muito mais contraste
// local que o vídeo normal ao redor. Comparação relativa (não um limiar
// absoluto fixo) porque cada fonte tem um nível de "ruído visual" de base
// diferente (jogo com HUD carregado vs. talking head limpo).
//
// Calibrado com 2 amostras reais em 02/09/2026 (mesmo canal, um trecho
// confirmado COM diálogo+chat queimados e um trecho confirmado SEM):
//   com legenda:  brilho médio de borda (faixa inferior) = 24.21, razão inf/sup = 5.26
//   sem legenda:  brilho médio de borda (faixa inferior) =  9.36, razão inf/sup = 3.27
// Os limiares abaixo ficam entre os dois com margem — não é ciência exata,
// é uma heurística; ajuste BILIBILI_CAPTION_DETECT_* no .env se gerar muito
// falso positivo/negativo na prática.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import sharp from 'sharp';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const BOTTOM_MEAN_THRESHOLD = parseFloat(process.env.BILIBILI_CAPTION_DETECT_BOTTOM_MEAN || '15');
const RATIO_THRESHOLD = parseFloat(process.env.BILIBILI_CAPTION_DETECT_RATIO || '4');
// Faixa analisada: 20% de altura, começando em 75% (inferior) e 0% (superior)
// do frame — cobre a região onde legenda queimada tipicamente fica.
const BAND_HEIGHT_FRACTION = 0.2;
const BOTTOM_BAND_START_FRACTION = 0.75;

function getFfmpegPath() {
    return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

async function extractFrame(videoPath, atSec, outPng) {
    await execFileAsync(getFfmpegPath(), [
        '-y', '-ss', String(atSec), '-i', videoPath, '-frames:v', '1', outPng,
    ], { maxBuffer: 10 * 1024 * 1024 });
}

async function edgeMean(pngPath, cropFilter, tmpDir) {
    const outPng = path.join(tmpDir, `edge_${crypto.randomBytes(4).toString('hex')}.png`);
    await execFileAsync(getFfmpegPath(), [
        '-y', '-i', pngPath, '-vf', `${cropFilter},edgedetect`, outPng,
    ], { maxBuffer: 10 * 1024 * 1024 });

    try {
        const { data } = await sharp(outPng).grayscale().raw().toBuffer({ resolveWithObject: true });
        let sum = 0;
        for (let i = 0; i < data.length; i++) sum += data[i];
        return data.length > 0 ? sum / data.length : 0;
    } finally {
        if (fs.existsSync(outPng)) fs.unlinkSync(outPng);
    }
}

/**
 * Amostra frames do vídeo e checa se a faixa inferior tem densidade de borda
 * muito maior que a faixa superior — sinal de texto/overlay queimado.
 * @param {string} videoPath
 * @param {object} [opts]
 * @param {number} [opts.sampleCount=3]
 * @returns {Promise<boolean>}
 */
export async function detectBurnedCaptions(videoPath, { sampleCount = 3 } = {}) {
    const tmpDir = os.tmpdir();
    const framePngs = [];

    try {
        const duration = await new Promise((resolve, reject) => {
            execFileAsync(process.env.FFPROBE_PATH?.trim() || 'ffprobe', [
                '-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', videoPath,
            ]).then(({ stdout }) => resolve(parseFloat(stdout.trim()))).catch(reject);
        });

        if (!duration || duration <= 0) return false;

        const votes = [];
        for (let i = 1; i <= sampleCount; i++) {
            const atSec = (duration * i) / (sampleCount + 1);
            const framePng = path.join(tmpDir, `cap_detect_${crypto.randomBytes(4).toString('hex')}.png`);
            framePngs.push(framePng);

            try {
                await extractFrame(videoPath, atSec, framePng);
                const bottomMean = await edgeMean(framePng, `crop=iw:ih*${BAND_HEIGHT_FRACTION}:0:ih*${BOTTOM_BAND_START_FRACTION}`, tmpDir);
                const topMean = await edgeMean(framePng, `crop=iw:ih*${BAND_HEIGHT_FRACTION}:0:0`, tmpDir);
                const ratio = topMean > 0.1 ? bottomMean / topMean : (bottomMean > BOTTOM_MEAN_THRESHOLD ? 999 : 0);
                const looksLikeCaption = bottomMean > BOTTOM_MEAN_THRESHOLD && ratio > RATIO_THRESHOLD;
                votes.push(looksLikeCaption);
                logger.info(`[Bilibili/CaptionDetect] Frame @${Math.round(atSec)}s: borda inf=${bottomMean.toFixed(1)} sup=${topMean.toFixed(1)} razão=${ratio.toFixed(1)} → ${looksLikeCaption ? 'TEM' : 'sem'} legenda`);
            } catch (err) {
                logger.warn(`[Bilibili/CaptionDetect] Falha ao analisar frame @${Math.round(atSec)}s: ${err.message}`);
            }
        }

        if (votes.length === 0) return false;
        // Maioria dos frames amostrados indicando legenda → considera positivo.
        const positives = votes.filter(Boolean).length;
        const result = positives > votes.length / 2;
        logger.info(`[Bilibili/CaptionDetect] ${positives}/${votes.length} frame(s) com sinal de legenda queimada → ${result ? 'PROVÁVEL' : 'improvável'}.`);
        return result;
    } finally {
        for (const p of framePngs) {
            if (fs.existsSync(p)) fs.unlinkSync(p);
        }
    }
}

// ─── Self-test: node bilibili/caption-detect.js <video.mp4> ─────────────────
if (process.argv[1] && process.argv[1].endsWith('caption-detect.js')) {
    const videoPath = process.argv[2];
    if (!videoPath) {
        console.error('Uso: node bilibili/caption-detect.js <video.mp4>');
        process.exit(1);
    }
    detectBurnedCaptions(videoPath)
        .then((result) => { console.log(result ? 'TEM legenda queimada' : 'SEM legenda queimada'); process.exitCode = 0; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
