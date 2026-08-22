// src/canal-infantil/generate.js
// Persona virtual "Canal Infantil" — Shorts educativos infantis 100% gerados
// (roteiro Groq + vídeo/imagens Pexels + narração Edge-TTS + composição FFmpeg),
// via o pipeline Python em ./canal_infantil.
//
// Mesmo desenho do Canal da Fé: o vídeo sai com metadados próprios, salvos num
// sidecar <video>.meta.json ao lado do .mp4 em output/canalinfantil/ — o poster
// usa esse sidecar em vez de gerar metadados por transcrição.

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

const PIPELINE_DIR = path.resolve('./canal_infantil');
const RENDERED = path.join(PIPELINE_DIR, 'output', 'video_final.mp4');
const PIPELINE_METADATA = path.join(PIPELINE_DIR, 'assets', 'metadata.json');
const POSTER_OUTPUT = path.resolve('./output/canalinfantil');

const VENV_PYTHON = path.join(PIPELINE_DIR, 'venv', 'Scripts', 'python.exe');
const PYTHON = process.env.CANALINFANTIL_PYTHON
    || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.env.PYTHON_PATH || 'python'));

export const CANALINFANTIL_PERSONA = {
    name: 'canalinfantil',
    displayName: 'Canal Infantil (vídeos gerados)',
    platform: 'generated',
    niche: 'infantil',
    weight: parseInt(process.env.CANALINFANTIL_WEIGHT || '1', 10),
    // Canal dedicado — terceiro perfil do Chrome
    youtubeProfileDir: process.env.CANALINFANTIL_PROFILE || './profiles/chrome-youtube-03',
    skipTikTok: true,
    // Canal para crianças: o YouTube exige declarar "feito para crianças".
    // Declarar errado viola as regras de proteção infantil (COPPA).
    madeForKids: true,
};

function runPipelineOnce(tema) {
    return new Promise((resolve, reject) => {
        logger.step('[CanalInfantil] Gerando vídeo (roteiro → Pexels → narração → FFmpeg)...');
        const args = ['test_video.py'];
        if (tema) args.push('--tema', tema);

        const child = spawn(PYTHON, args, {
            cwd: PIPELINE_DIR,
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        child.stdout.on('data', (d) => {
            const line = d.toString().trim();
            if (line) logger.info(`[CanalInfantil] ${line.split('\n').pop().slice(0, 160)}`);
        });
        child.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (line) logger.warn(`[CanalInfantil] ${line.split('\n').pop().slice(0, 160)}`);
        });
        child.on('error', reject);
        child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(`Pipeline Python saiu com código ${code}`))));
    });
}

function buildHashtags(tags) {
    const clean = (Array.isArray(tags) ? tags : [])
        .map((t) => String(t).replace(/[^\p{L}\p{N}]/gu, ''))
        .filter(Boolean)
        .slice(0, 4)
        .map((t) => `#${t}`);
    return ['#shorts', ...clean].join(' ');
}

/**
 * Gera 1 vídeo do Canal Infantil e o move para output/canalinfantil/ com o
 * sidecar .meta.json pronto para o poster.
 * @param {string} [tema] tema opcional; omitido = o pipeline sorteia
 * @returns {Promise<string>} caminho do .mp4 movido
 */
export async function generateCanalInfantilVideo(tema = null) {
    // O pipeline sempre escreve no mesmo nome — remove sobra de execução anterior
    // para não confundir um vídeo velho com o recém-gerado.
    if (fs.existsSync(RENDERED)) fs.unlinkSync(RENDERED);

    await runPipelineOnce(tema);

    if (!fs.existsSync(RENDERED)) {
        throw new Error('Pipeline concluiu mas output/video_final.mp4 não foi encontrado.');
    }

    let meta = {};
    try {
        meta = JSON.parse(fs.readFileSync(PIPELINE_METADATA, 'utf-8'));
    } catch (err) {
        logger.warn(`[CanalInfantil] metadata.json ilegível (${err.message}) — usando título padrão.`);
    }

    fs.mkdirSync(POSTER_OUTPUT, { recursive: true });
    const destMp4 = path.join(POSTER_OUTPUT, `infantil_${Date.now()}.mp4`);
    fs.renameSync(RENDERED, destMp4);

    // O roteirista Python às vezes devolve só o nome do personagem (ex.: "Pérsio
    // 🔥", 9 chars) — passa no schema dele mas reprova no Validator do poster
    // (MIN_TITLE_LEN_GERADO, padrão 10), estourando um vídeo inteiro já renderizado.
    // Mesmo limiar aqui pra cair no título-padrão antes de chegar no poster.
    const minTitulo = parseInt(process.env.MIN_TITLE_LEN_GERADO || '10', 10);
    const tituloValido = typeof meta.titulo === 'string' && meta.titulo.trim().length >= minTitulo;
    if (meta.titulo && !tituloValido) {
        logger.warn(`[CanalInfantil] Título do pipeline muito curto ("${meta.titulo}", ${meta.titulo.trim().length} chars) — usando título padrão.`);
    }

    const sidecar = {
        titulo: tituloValido ? meta.titulo : 'Você sabia? Curiosidade para crianças 🧒',
        descricao: meta.descricao || 'Aprenda brincando! Inscreva-se para mais! 🎬',
        hashtags: buildHashtags(meta.tags || ['infantil', 'educativo', 'curiosidades', 'criancas']),
        tema: meta.tema || tema || null,
        fonte: 'canal-infantil',
    };
    fs.writeFileSync(destMp4.replace(/\.mp4$/i, '.meta.json'), JSON.stringify(sidecar, null, 2), 'utf-8');

    logger.success(`[CanalInfantil] Vídeo pronto para o poster: ${path.basename(destMp4)} — "${sidecar.titulo}"`);
    return destMp4;
}
