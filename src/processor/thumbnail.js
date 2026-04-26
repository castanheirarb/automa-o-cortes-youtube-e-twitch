// src/processor/thumbnail.js
// Módulo Thumbnail Creator Pro: Gera thumbnails profissionais com direção de IA (Gemini 2.5 Pro).

import { GoogleGenerativeAI } from '@google/generative-ai';
import sharp from 'sharp';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { logger } from '../utils/logger.js';
import { extractBestFrame } from './face-detect.js';
import { PERSONAS_MAP } from '../capturer/personas.js';

function getNicheFromPath(videoPath) {
    const parts = videoPath.split(path.sep);
    const personaName = parts.find((dir) => PERSONAS_MAP[dir]);
    return personaName ? (PERSONAS_MAP[personaName].niche || 'default') : 'default';
}

const execFileAsync = promisify(execFile);

const FONT_PATH = path.resolve('./assets/fonts/Inter-Black.ttf');

// 1. Direção de Arte com Gemini (Modo Pro)
async function getAIArtDirection(transcript, title, thumbText = '', niche = 'default') {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: { temperature: 0.5, responseMimeType: 'application/json' },
    });

    const prompt = `Você é um diretor de arte de thumbnails para canais de cortes virais do YouTube. Gere um JSON com instruções visuais para a biblioteca sharp.

Nicho do Canal: ${niche}
Título do Vídeo: "${title}"
Texto sugerido para thumb: "${thumbText || ''}"
Transcrição (trecho): "${(transcript || '').substring(0, 400)}"

Referências de estilo por nicho:
- gaming/react: Rosto em close com expressão forte, texto grande 3-4 palavras com contorno preto, cores vibrantes (vermelho, amarelo). Ex: Flow, Casimiro.
- podcast: Rosto do convidado com expressão séria/intrigada, texto em formato de pergunta, cores sóbrias com ponto de destaque. Ex: Inteligência Ltda.
- fitness: Corpo/rosto do atleta, texto motivacional em amarelo/laranja, fundo escuro.

REGRAS:
1. "text": 3-5 palavras em CAIXA ALTA que COMPLEMENTEM o título (NÃO repita). Ex: título "ELE REVELOU O SEGREDO" → text "NINGUÉM ESPERAVA ISSO". ZERO palavrões.
2. "textColor": cor de alto contraste (#FFFFFF ou #FFD700 ou #FF0000)
3. "strokeColor": sempre "#000000" para legibilidade
4. "backgroundColor": cor de fundo (hex) — use tons escuros ou vibrantes
5. "layout": "text-left", "text-right" ou "text-center"
6. "font": "Impact" (gaming/react) ou "Arial Black" (podcast/fitness)

{"text":"...","textColor":"#FFFFFF","strokeColor":"#000000","backgroundColor":"#8B0000","layout":"text-center","font":"Impact"}`;

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '');
        const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`Gemini não retornou JSON válido: ${raw.substring(0, 100)}`);
        parsed = JSON.parse(jsonMatch[0]);
    }

    return parsed;
}

// 2. Composição da Thumbnail com Sharp
async function composeThumbnail(framePath, artDirection, outputPath) {
    // Suporta formato novo {text, textColor, strokeColor, layout, font}
    // e formato legado {copy, color_palette}
    const text = (artDirection.text || artDirection.copy || 'ASSISTA AGORA').toUpperCase();
    const textColor = artDirection.textColor || artDirection.color_palette?.text_color || '#FFFFFF';
    const strokeColor = artDirection.strokeColor || '#000000';
    const font = artDirection.font || 'Impact';
    const layout = artDirection.layout || 'text-center';

    const width = 1280;
    const height = 720;

    const xPos = layout === 'text-left' ? '25%' : layout === 'text-right' ? '75%' : '50%';

    const svgText = `
    <svg width="${width}" height="${height}">
        <style>
            .title {
                fill: ${textColor};
                font-size: 96px;
                font-family: '${font}', Impact, Arial Black, sans-serif;
                font-weight: 900;
                text-anchor: middle;
                paint-order: stroke;
                stroke: ${strokeColor};
                stroke-width: 12px;
                stroke-linecap: round;
                stroke-linejoin: round;
            }
        </style>
        <text x="${xPos}" y="88%" class="title">${text}</text>
    </svg>`;

    const textOverlay = Buffer.from(svgText);

    await sharp(framePath)
        .resize(width, height)
        .modulate({ saturation: 1.4, brightness: 1.05 })
        .composite([{ input: textOverlay, gravity: 'south' }])
        .toFile(outputPath);
}

// 2b. Fallback: extrai um frame simples sem IA (1/3 da duração do vídeo)
async function extractFallbackFrame(videoPath) {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    const ffprobePath = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
    const framePath = path.join(os.tmpdir(), `thumb_fallback_${Date.now()}.jpg`);

    try {
        const { stdout } = await execFileAsync(ffprobePath, [
            '-v', 'error',
            '-show_entries', 'format=duration',
            '-of', 'default=noprint_wrappers=1:nokey=1',
            videoPath,
        ]);
        const duration = parseFloat(stdout.trim()) || 30;
        const seekTime = Math.floor(duration / 3);

        await execFileAsync(ffmpegPath, [
            '-ss', String(seekTime),
            '-i', videoPath,
            '-vframes', '1',
            '-q:v', '2',
            '-y',
            framePath,
        ]);

        return fs.existsSync(framePath) ? framePath : null;
    } catch (err) {
        logger.warn(`[Thumbnail] Falha no fallback de frame: ${err.message}`);
        return null;
    }
}

// 3. Orquestrador Principal
export async function createProfessionalThumbnail(videoPath, metadata) {
    logger.step('[Thumbnail] Iniciando criação de thumbnail profissional...');

    if (!fs.existsSync(FONT_PATH)) {
        logger.warn(`[Thumbnail] Fonte não encontrada em ${FONT_PATH}. O texto pode não ser renderizado corretamente.`);
    }

    const outputPath = videoPath.replace(/\.mp4$/, '.jpg');

    try {
        // a. Extrai o melhor frame do vídeo via Gemini Vision; fallback simples se sem chave
        let framePath = await extractBestFrame(videoPath);
        if (!framePath) {
            logger.info('[Thumbnail] Sem GEMINI_API_KEY — extraindo frame simples (sem IA)...');
            framePath = await extractFallbackFrame(videoPath);
        }
        if (!framePath) {
            logger.warn('[Thumbnail] Falha ao extrair qualquer frame do vídeo.');
            return null;
        }

        // b. Obtém direção de arte da IA (fallback sem API key)
        const niche = getNicheFromPath(videoPath);
        let artDirection;
        if (process.env.GEMINI_API_KEY?.trim()) {
            artDirection = await getAIArtDirection(metadata.transcript || '', metadata.titulo, metadata.thumbText || '', niche);
            logger.info(`[Thumbnail] Direção de Arte: "${artDirection.text}" | Layout: ${artDirection.layout} | Font: ${artDirection.font}`);
        } else {
            const words = (metadata.thumbText || metadata.titulo || '').split(' ').slice(0, 4).join(' ');
            artDirection = {
                text: words,
                textColor: '#FFFFFF',
                strokeColor: '#000000',
                backgroundColor: '#1a1a2e',
                layout: 'text-center',
                font: 'Impact',
            };
            logger.info(`[Thumbnail] Direção de Arte (fallback): "${artDirection.text}"`);
        }

        // c. Compõe a thumbnail
        await composeThumbnail(framePath, artDirection, outputPath);

        // d. Limpa o frame temporário
        if (fs.existsSync(framePath)) fs.unlinkSync(framePath);

        logger.success(`[Thumbnail] Thumbnail salva: ${path.basename(outputPath)}`);
        return outputPath;

    } catch (err) {
        logger.error(`[Thumbnail] Falha ao criar thumbnail: ${err.message}`);
        return null;
    }
}
