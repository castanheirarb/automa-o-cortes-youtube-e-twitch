// src/processor/face-detect.js
// Detecta automaticamente a posição do rosto/webcam no frame do vídeo
// usando Gemini 2.5 Pro Vision para determinar o enquadramento ideal do crop 9:16.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

async function extractFrame(videoUrl, seekSeconds) {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    const tmpFile = path.join(os.tmpdir(), `face-detect-${Date.now()}.jpg`);
    await execFileAsync(ffmpegPath, [
        '-ss', String(Math.floor(seekSeconds)),
        '-i', videoUrl,
        '-vframes', '1',
        '-q:v', '3',
        '-y',
        tmpFile,
    ]);
    return tmpFile;
}

async function askGeminiForFacePosition(framePath) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });

    const image = {
        inlineData: {
            data: Buffer.from(fs.readFileSync(framePath)).toString('base64'),
            mimeType: 'image/jpeg',
        },
    };

    const prompt =
        'This is a game livestream frame. Locate the streamer\'s webcam/face overlay. ' +
        'Reply with ONLY a single decimal number from 0.00 to 1.00 that represents ' +
        'the horizontal center of the face/webcam as a fraction of the total image width ' +
        '(0.00 = far left, 0.50 = center, 1.00 = far right). ' +
        'If there is no visible face or webcam, reply with 0.50.';

    const result = await model.generateContent([prompt, image]);
    const raw = result.response.text().trim();
    const value = parseFloat(raw);

    if (isNaN(value) || value < 0 || value > 1) {
        logger.warn(`face-detect: resposta inesperada do Gemini: "${raw}"`);
        return null;
    }

    return value;
}

/**
 * Detecta a posição horizontal ideal para o crop 9:16 com base no rosto do streamer.
 * Amostra múltiplos frames e usa a média das detecções.
 */
export async function detectCropXPosition(videoStreamUrl, startTime, endTime) {
    if (!process.env.GEMINI_API_KEY) {
        logger.warn('face-detect: GEMINI_API_KEY não configurada — usando centro (0.5).');
        return 0.5;
    }

    const SAMPLE_COUNT = 3;
    const step = (endTime - startTime) / (SAMPLE_COUNT + 1);
    const sampleTimes = Array.from({ length: SAMPLE_COUNT }, (_, i) => startTime + step * (i + 1));

    logger.info(`face-detect: analisando ${SAMPLE_COUNT} frames com Gemini...`);

    const positions = [];

    for (const t of sampleTimes) {
        let framePath = null;
        try {
            framePath = await extractFrame(videoStreamUrl, t);
            const pos = await askGeminiForFacePosition(framePath);
            if (pos !== null) {
                positions.push(pos);
                logger.info(`  frame em ${Math.floor(t)}s → rosto em X=${(pos * 100).toFixed(0)}%`);
            }
        } catch (err) {
            logger.warn(`  frame em ${Math.floor(t)}s → erro: ${err.message}`);
        } finally {
            if (framePath && fs.existsSync(framePath)) fs.unlinkSync(framePath);
        }
    }

    if (positions.length === 0) {
        logger.warn('face-detect: nenhum rosto detectado — usando centro (0.5).');
        return 0.5;
    }

    const avg = positions.reduce((a, b) => a + b, 0) / positions.length;
    logger.info(`face-detect: posição média do rosto → X=${(avg * 100).toFixed(0)}% da largura.`);
    return avg;
}

/**
 * Extrai o frame com a expressão facial mais impactante usando Gemini Vision.
 * Usado pelo thumbnail.js para selecionar o melhor frame para a thumbnail.
 * @param {string} videoPath - Caminho do vídeo local
 * @returns {Promise<string|null>} Caminho do frame salvo ou null
 */
export async function extractBestFrame(videoPath) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) return null;

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({ model: process.env.GEMINI_MODEL || 'gemini-2.5-flash' });
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';

    const duration = 60; // Analisa os primeiros 60s
    const frameCount = 5;
    const frames = [];

    // 1. Extrai 5 frames do vídeo
    for (let i = 0; i < frameCount; i++) {
        const time = (duration / (frameCount + 1)) * (i + 1);
        const framePath = path.join(os.tmpdir(), `frame-best-${i}-${Date.now()}.jpg`);
        try {
            await execFileAsync(ffmpegPath, ['-ss', String(time), '-i', videoPath, '-vframes', '1', '-q:v', '2', '-y', framePath]);
            const base64 = fs.readFileSync(framePath).toString('base64');
            frames.push({ path: framePath, base64 });
        } catch (err) {
            logger.warn(`[FaceDetect] Falha ao extrair frame ${i}: ${err.message}`);
        }
    }

    if (frames.length === 0) return null;

    try {
        // 2. Envia para o Gemini Vision avaliar
        const parts = [
            ...frames.map((f) => ({
                inlineData: { data: f.base64, mimeType: 'image/jpeg' },
            })),
            {
                text: `Analise as ${frames.length} imagens. Qual delas (de 0 a ${frames.length - 1}) tem a expressão facial mais forte e chamativa para uma thumbnail de YouTube Shorts? Responda APENAS com o número do índice (${Array.from({ length: frames.length }, (_, i) => i).join(', ')}).`,
            },
        ];

        const result = await model.generateContent(parts);
        const bestIndex = parseInt(result.response.text().trim(), 10);
        const safeIndex = isNaN(bestIndex) || bestIndex >= frames.length ? 0 : bestIndex;
        const bestFrame = frames[safeIndex];

        // 3. Limpa frames não utilizados
        frames.forEach((f, i) => {
            if (i !== safeIndex && fs.existsSync(f.path)) fs.unlinkSync(f.path);
        });

        logger.info(`[FaceDetect] Melhor frame selecionado pelo Gemini: índice ${safeIndex}`);
        return bestFrame.path;

    } catch (err) {
        logger.warn(`[FaceDetect] Gemini Vision falhou: ${err.message}`);
        frames.forEach((f) => { if (fs.existsSync(f.path)) fs.unlinkSync(f.path); });
        return null;
    }
}
