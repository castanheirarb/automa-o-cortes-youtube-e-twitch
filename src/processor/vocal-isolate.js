// src/processor/vocal-isolate.js
// Separação de fontes de áudio (voz vs música de fundo) via Demucs — mitigação
// técnica pro copyright strike de 2026-08-24 (Soares Music Digital, nicho
// 'religioso'): as lives de oração do Bispo Bruno Leonardo têm música
// ambiente de fundo (louvor tocando na sala, captado pelo mic), que o
// Content ID reconhece mesmo sob a voz. Isola só a voz e descarta a trilha
// de música antes do clipe/vídeo final — reduz bastante a chance de match,
// mas não é garantia 100% se sobrar resíduo (ver aviso em CLAUDE.md).
//
// Requer Demucs num venv Python dedicado (dependências pesadas — PyTorch —
// não reaproveita o venv do MediaPipe/ASD):
//   python -m venv voice_isolation/venv
//   voice_isolation/venv/Scripts/pip install demucs
// Configure DEMUCS_PATH no .env apontando pro executável demucs desse venv
// (ex.: voice_isolation/venv/Scripts/demucs.exe no Windows).
//
// Sem DEMUCS_PATH configurado, ou se a separação falhar/estourar o timeout
// (processo pesado — CPU sem GPU pode levar minutos por vídeo longo), cai de
// volta pro áudio ORIGINAL sem isolar — nunca quebra o pipeline por causa
// disso (mesmo padrão defensivo do resto do projeto), só fica sem a
// mitigação naquele vídeo específico.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const TIMEOUT_MS = parseInt(process.env.VOCAL_ISOLATION_TIMEOUT_SEC || '600', 10) * 1000;
const DEMUCS_MODEL = process.env.DEMUCS_MODEL || 'htdemucs';

function ffmpegBin() {
    return process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
}

function demucsBin() {
    return process.env.DEMUCS_PATH?.trim() || null;
}

/**
 * Niches que passam por isolamento de voz — configurável via
 * VOCAL_ISOLATION_NICHES (separado por vírgula) pra cobrir outro conteúdo
 * religioso/com música ambiente no futuro sem mexer em código.
 * @param {string} niche
 * @returns {boolean}
 */
export function shouldIsolateVocals(niche) {
    const configured = process.env.VOCAL_ISOLATION_NICHES?.trim();
    const targets = configured ? configured.split(',').map((n) => n.trim()) : ['religioso'];
    return targets.includes(niche);
}

/**
 * Substitui a trilha de áudio de um vídeo pela voz isolada
 * (`demucs --two-stems=vocals`), descartando a música de fundo. Edita
 * `videoPath` IN PLACE via troca atômica (escreve num temporário, renomeia
 * no final) — mesmo padrão do NotificationOverlay em poster/index.js.
 *
 * Nunca lança — qualquer falha (Demucs não configurado, timeout, erro de
 * processo) loga um aviso e deixa o arquivo original intocado.
 *
 * @param {string} videoPath - caminho do .mp4 a processar
 * @returns {Promise<boolean>} true se isolou de verdade, false se manteve o original
 */
export async function isolateVocals(videoPath) {
    const demucs = demucsBin();
    if (!demucs) {
        logger.warn('[VocalIsolate] DEMUCS_PATH não configurado — mantendo áudio original (sem mitigação de música de fundo).');
        return false;
    }

    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'vocal-isolate-'));
    const tempWav = path.join(tmpDir, 'audio.wav');
    const tempOut = `${videoPath}.isolated-tmp.mp4`;

    try {
        logger.step('[VocalIsolate] Isolando voz (removendo música de fundo)...');

        // 1. Extrai o áudio original pra WAV (entrada limpa pro Demucs)
        await execFileAsync(ffmpegBin(), [
            '-y', '-i', videoPath, '-vn', '-acodec', 'pcm_s16le', '-ar', '44100', '-ac', '2', tempWav,
        ], { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });

        // 2. Separação de fontes — só o stem de voz interessa, o de música é descartado
        await execFileAsync(demucs, [
            '--two-stems=vocals', '-n', DEMUCS_MODEL, '-o', tmpDir, tempWav,
        ], { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });

        const vocalsPath = path.join(tmpDir, DEMUCS_MODEL, 'audio', 'vocals.wav');
        if (!fs.existsSync(vocalsPath)) {
            throw new Error(`Demucs terminou mas ${vocalsPath} não existe (nome de modelo/saída mudou?).`);
        }

        // 3. Remuxa: vídeo original intacto (stream copy) + áudio isolado
        await execFileAsync(ffmpegBin(), [
            '-y', '-i', videoPath, '-i', vocalsPath,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-shortest',
            tempOut,
        ], { timeout: TIMEOUT_MS, maxBuffer: 20 * 1024 * 1024 });

        fs.renameSync(tempOut, videoPath);
        logger.success('[VocalIsolate] Música de fundo removida — áudio final só com a voz isolada.');
        return true;
    } catch (err) {
        logger.warn(`[VocalIsolate] Falha ao isolar voz (${err.message}) — mantendo áudio original.`);
        try { if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut); } catch { /* ignora */ }
        return false;
    } finally {
        try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignora */ }
    }
}
