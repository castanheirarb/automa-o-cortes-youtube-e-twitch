// poster/queue.js
// Gerencia a fila de arquivos .mp4 para upload.
// Lê ./output, retorna o próximo arquivo disponível,
// e move o arquivo para ./postados após o upload.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const OUTPUT_DIR = path.resolve('./output');
const POSTED_DIR = path.resolve('./postados');

/**
 * Garante que os diretórios necessários existam.
 */
export function ensureDirs() {
    [OUTPUT_DIR, POSTED_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

/**
 * Retorna o PRÓXIMO arquivo .mp4 disponível na pasta ./output
 * (percorre subpastas também, para compatibilidade com a estrutura do canal corte).
 * Retorna null se não houver nenhum.
 *
 * @returns {{ filePath: string, title: string } | null}
 */
export function getNextVideo() {
    ensureDirs();

    // Busca recursivamente todos os .mp4 dentro de ./output
    const mp4Files = findMp4sRecursive(OUTPUT_DIR);

    if (mp4Files.length === 0) {
        logger.warn('Nenhum vídeo disponível em ./output para postar.');
        return null;
    }

    // Pega o mais antigo (primeiro da lista ordenada por data de criação)
    mp4Files.sort((a, b) => fs.statSync(a).birthtimeMs - fs.statSync(b).birthtimeMs);

    const filePath = mp4Files[0];

    // Título = nome do arquivo sem extensão, limpando o prefixo numérico (ex: "01__pico-312s")
    const basename = path.basename(filePath, '.mp4');
    const title = formatTitle(basename);

    logger.info(`Próximo vídeo na fila: ${path.relative(OUTPUT_DIR, filePath)}`);
    return { filePath, title };
}

/**
 * Move o arquivo de ./output para ./postados após upload bem-sucedido.
 * Preserva a estrutura de subpastas.
 *
 * @param {string} filePath - Caminho absoluto do arquivo em ./output
 */
export function markAsPosted(filePath) {
    ensureDirs();

    // Recria a estrutura de subpastas dentro de ./postados
    const relative = path.relative(OUTPUT_DIR, filePath);
    const destPath = path.join(POSTED_DIR, relative);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    fs.renameSync(filePath, destPath);
    logger.success(`Arquivo movido para ./postados: ${relative}`);
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findMp4sRecursive(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findMp4sRecursive(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * Transforma o nome do arquivo em um título legível.
 * Ex: "01__pico-4439s" → "Corte #1 - Pico em 1h 13m 59s"
 * Também aceita títulos com nomes de vídeo.
 */
function formatTitle(basename) {
    // Extrai número do clip e tempo de pico
    const match = basename.match(/^(\d+)__pico-(\d+)s$/);
    if (match) {
        const num = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        return `Corte #${num} - ${secondsToReadable(sec)} #shorts #cortes`;
    }
    // Fallback: usa o nome bruto, substitui underscores por espaços
    return basename.replace(/_+/g, ' ').trim() + ' #shorts #cortes';
}

function secondsToReadable(total) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}
