// src/capturer/live-recorder.js
// Grava um segmento de live stream (Twitch, TikTok, ...) usando yt-dlp.
// Executa por N minutos e depois encerra.

import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const TMP_DIR = path.resolve('./tmp');

function getYtDlpBin() {
    return process.env.YTDLP_PATH?.trim() || 'yt-dlp';
}

/**
 * Grava N minutos de um stream ao vivo via yt-dlp (qualquer extractor suportado:
 * Twitch, TikTok live, etc — o que muda é só a URL).
 *
 * @param {object} params
 * @param {string} params.url              - URL da live (ex: https://www.twitch.tv/x, https://www.tiktok.com/@x/live)
 * @param {string} params.label            - Nome curto pra logs/nome de arquivo (ex: username do canal)
 * @param {number} [params.minutesToRecord=30] - Quantos minutos gravar
 * @param {string} [params.cookiesPath]    - Caminho pra um cookies.txt (formato Netscape) — opcional,
 *                                            só necessário se a live exigir sessão logada.
 * @returns {Promise<{ filePath: string, durationSec: number }>}
 */
export async function recordLiveStream({ url, label, minutesToRecord = 30, cookiesPath }) {
    fs.mkdirSync(TMP_DIR, { recursive: true });

    const timestamp = Date.now();
    const outFile = path.join(TMP_DIR, `live-${label}-${timestamp}.mp4`);
    const durationSec = minutesToRecord * 60;
    const ytDlp = getYtDlpBin();

    logger.step(`[Recorder] Gravando ${minutesToRecord} min de ${url}...`);
    logger.info(`[Recorder] Saída: ${outFile}`);

    return new Promise((resolve, reject) => {
        // yt-dlp grava o stream. Usamos --download-sections para limitar o tempo.
        // Formato: mp4 com áudio, qualidade 720p (equilibrada para cortes de shorts)
        const args = [
            '--no-playlist',
            '--live-from-start',           // baixa do início do live (se disponível)
            '--download-sections', `*0-${durationSec}`, // para após N segundos
            '--extractor-args', 'youtube:player_client=android',
            '-f', 'bestvideo[height<=720][ext=mp4]+bestaudio[ext=m4a]/best[height<=720][ext=mp4]/best',
            '--merge-output-format', 'mp4',
            '-o', outFile,
            '--no-part',
            '--quiet',
            '--progress',
        ];

        if (cookiesPath && fs.existsSync(cookiesPath)) {
            args.push('--cookies', cookiesPath);
        }

        args.push(url);

        const proc = spawn(ytDlp, args, { stdio: ['ignore', 'pipe', 'pipe'] });

        let lastLog = Date.now();

        proc.stdout.on('data', (d) => {
            // Log de progresso a cada 30s (evita flood)
            if (Date.now() - lastLog > 30000) {
                logger.info(`[Recorder] gravando ${label}...`);
                lastLog = Date.now();
            }
        });

        proc.stderr.on('data', (d) => {
            const msg = d.toString().trim();
            if (msg && !msg.includes('cookie') && !msg.includes('WARNING')) {
                logger.warn(`[Recorder] ${msg.slice(0, 120)}`);
            }
        });

        // Também encerra por timeout de segurança (minutesToRecord + 2 min extra)
        const safetyTimeout = setTimeout(() => {
            logger.warn('[Recorder] Timeout de segurança atingido. Encerrando gravação...');
            proc.kill('SIGTERM');
        }, (durationSec + 120) * 1000);

        proc.on('close', (code) => {
            clearTimeout(safetyTimeout);

            if (!fs.existsSync(outFile) || fs.statSync(outFile).size < 1000) {
                reject(new Error(`[Recorder] Arquivo de saída inválido ou vazio: ${outFile}`));
                return;
            }

            const actualSize = (fs.statSync(outFile).size / 1024 / 1024).toFixed(1);
            logger.success(`[Recorder] Gravação concluída: ${outFile} (${actualSize} MB)`);
            resolve({ filePath: outFile, durationSec });
        });

        proc.on('error', reject);
    });
}

/**
 * Remove arquivos temporários de live mais antigos que maxAgeHours.
 * Chamado automaticamente após processamento.
 */
export function cleanupTmpFiles(maxAgeHours = 2) {
    try {
        if (!fs.existsSync(TMP_DIR)) return;
        const now = Date.now();
        const files = fs.readdirSync(TMP_DIR);
        let removed = 0;

        for (const f of files) {
            if (!f.startsWith('live-') || !f.endsWith('.mp4')) continue;
            const fPath = path.join(TMP_DIR, f);
            const age = (now - fs.statSync(fPath).mtimeMs) / 3600000;
            if (age > maxAgeHours) {
                fs.unlinkSync(fPath);
                removed++;
            }
        }

        if (removed > 0) logger.info(`[Recorder] ${removed} arquivo(s) temporário(s) removido(s).`);
    } catch (err) {
        logger.warn(`[Recorder] Limpeza de tmp falhou: ${err.message}`);
    }
}
