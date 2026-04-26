// poster/manual.js
// Upload manual com título personalizado ou gerado por IA.
// Uso: node poster/manual.js <número> ["Título manual"]
// Ex:  node poster/manual.js 03 "CARIANI EXAGEROU NO SABOR !!! #shorts #cortes"
// Ex:  node poster/manual.js 03   ← usa IA para gerar o título

import 'dotenv/config';
import path from 'node:path';
import fs from 'node:fs';
import { uploadToYouTube } from './uploaders/youtube.js';
import { markAsPosted } from './queue.js';
import { generateMetadata, generateFallbackMetadata, formatTitle, formatYouTubeDescription } from './metadata.js';
import { logger } from './logger.js';

const [, , clipNumber, ...titleParts] = process.argv;
const manualTitle = titleParts.join(' ').trim();

if (!clipNumber) {
    console.error('\n  Uso: node poster/manual.js <número> ["Título manual"]');
    console.error('  Ex:  node poster/manual.js 03 "CARIANI EXAGEROU NO SABOR!!!"');
    console.error('  Ex:  node poster/manual.js 03   ← IA gera o título automaticamente\n');
    process.exit(1);
}

// Busca recursivamente o arquivo que começa com o número
function findClip(dir, prefix) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            const found = findClip(full, prefix);
            if (found) return found;
        } else if (entry.name.startsWith(prefix) && entry.name.endsWith('.mp4')) {
            return full;
        }
    }
    return null;
}

const outputDir = path.resolve(process.env.OUTPUT_DIR || './output');
const prefix = clipNumber.padStart(2, '0');
const filePath = findClip(outputDir, prefix);

if (!filePath) {
    logger.error(`Clipe "${prefix}" não encontrado em ${outputDir}`);
    process.exit(1);
}

logger.step(`Upload manual: ${path.basename(filePath)}`);

// Determina o título: manual (CLI) ou gerado pela IA
let finalTitle;
let ytDescription = '';
if (manualTitle) {
    finalTitle = manualTitle;
    logger.info(`Título manual: "${finalTitle}"`);
} else {
    logger.info('Gerando título via IA...');
    const topic = path.basename(filePath, '.mp4').replace(/_+/g, ' ');
    const meta = await generateMetadata(filePath).catch(() => generateFallbackMetadata(topic));
    finalTitle = formatTitle(meta);
    ytDescription = formatYouTubeDescription(meta);
    logger.info(`Título gerado: "${finalTitle}"`);
}

const headless = process.env.HEADLESS !== 'false';
const ok = await uploadToYouTube(filePath, finalTitle, ytDescription, headless);

if (ok) {
    markAsPosted(filePath);
    logger.success('Concluído e movido para ./postados');
} else {
    logger.error('Upload falhou — arquivo mantido em ./output');
}
process.exit(ok ? 0 : 1);
