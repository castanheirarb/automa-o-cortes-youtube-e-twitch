// src/canal-da-fe/generate.js
// Persona virtual "Canal da Fé" — vídeos religiosos 100% gerados (roteiro IA +
// imagens FLUX + narração Edge-TTS + render Remotion), via o pipeline Python em
// ./canal_da_fe. Entra no round-robin do poster intercalada com os cortes do
// Bispo Bruno Leonardo, postando no mesmo perfil dedicado (chrome-youtube-02).
//
// O vídeo gerado já vem com metadados próprios (título/descrição/tags criados
// pelo roteirista). Eles são salvos num sidecar <video>.meta.json ao lado do
// .mp4 em output/canaldafe/ — o poster usa esse sidecar em vez de gerar
// metadados por transcrição (que é o fluxo dos cortes).

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { logger } from '../utils/logger.js';

const PIPELINE_DIR = path.resolve('./canal_da_fe');
const PIPELINE_OUTPUT = path.join(PIPELINE_DIR, 'output');
const PIPELINE_METADATA = path.join(PIPELINE_DIR, 'assets', 'metadata.json');
const POSTER_OUTPUT = path.resolve('./output/canaldafe');
const VENV_PYTHON = path.join(PIPELINE_DIR, 'venv', 'Scripts', 'python.exe');
const PYTHON = process.env.CANALDAFE_PYTHON
    || (fs.existsSync(VENV_PYTHON) ? VENV_PYTHON : (process.env.PYTHON_PATH || 'python'));

export const CANALDAFE_PERSONA = {
    name: 'canaldafe',
    displayName: 'Canal da Fé (vídeos gerados)',
    platform: 'generated',
    niche: 'religioso',
    weight: parseInt(process.env.CANALDAFE_WEIGHT || '1', 10),
    // Mesmo destino da persona bispobrunoleonardo: canal religioso dedicado
    youtubeProfileDir: './profiles/chrome-youtube-02',
    tiktokProfileDir: './profiles/chrome-tiktok-02',
};

function runPipelineOnce() {
    return new Promise((resolve, reject) => {
        logger.step('[CanalDaFé] Gerando vídeo (roteiro → imagens → narração → Remotion)...');
        const child = spawn(PYTHON, ['main.py', '--once', '--no-upload'], {
            cwd: PIPELINE_DIR,
            shell: false,
            env: { ...process.env, PYTHONIOENCODING: 'utf-8' },
        });
        child.stdout.on('data', (d) => {
            const line = d.toString().trim();
            if (line) logger.info(`[CanalDaFé] ${line.split('\n').pop().slice(0, 160)}`);
        });
        child.stderr.on('data', (d) => {
            const line = d.toString().trim();
            if (line) logger.warn(`[CanalDaFé] ${line.split('\n').pop().slice(0, 160)}`);
        });
        child.on('error', reject);
        child.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`Pipeline Python saiu com código ${code}`));
        });
    });
}

function newestMp4Since(dir, sinceMs) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.mp4'))
        .map((f) => ({ f, mtime: fs.statSync(path.join(dir, f)).mtimeMs }))
        .filter((e) => e.mtime >= sinceMs)
        .sort((a, b) => b.mtime - a.mtime);
    return files.length > 0 ? path.join(dir, files[0].f) : null;
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
 * Gera 1 vídeo do Canal da Fé e o move para output/canaldafe/ com sidecar
 * .meta.json (titulo/descricao/hashtags prontos para o poster).
 * @returns {Promise<string>} caminho do .mp4 movido
 */
export async function generateCanalDaFeVideo() {
    const startedAt = Date.now();
    await runPipelineOnce();

    const rendered = newestMp4Since(PIPELINE_OUTPUT, startedAt - 60_000);
    if (!rendered) throw new Error('Pipeline concluiu mas nenhum .mp4 novo foi encontrado em canal_da_fe/output.');

    let meta = {};
    try {
        meta = JSON.parse(fs.readFileSync(PIPELINE_METADATA, 'utf-8'));
    } catch (err) {
        logger.warn(`[CanalDaFé] metadata.json ilegível (${err.message}) — usando título padrão.`);
    }

    fs.mkdirSync(POSTER_OUTPUT, { recursive: true });
    const destMp4 = path.join(POSTER_OUTPUT, path.basename(rendered));
    fs.renameSync(rendered, destMp4);

    const sidecar = {
        titulo: meta.titulo || 'Mensagem de Fé para o seu dia 🙏',
        descricao: meta.descricao || 'Uma palavra de fé e esperança. Inscreva-se para mais! 🙏',
        hashtags: buildHashtags(meta.tags || ['Fe', 'Deus', 'Jesus', 'Reflexao']),
        tema: meta.tema || null,
        fonte: 'canal-da-fe',
    };
    fs.writeFileSync(destMp4.replace(/\.mp4$/i, '.meta.json'), JSON.stringify(sidecar, null, 2), 'utf-8');

    logger.success(`[CanalDaFé] Vídeo pronto para o poster: ${path.basename(destMp4)} — "${sidecar.titulo}"`);
    return destMp4;
}
