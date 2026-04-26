// regen-captions.js
// Script auxiliar para adicionar/regenerar legendas nos vídeos já existentes em ./output
// Uso: node regen-captions.js
// Útil para aplicar legendas em clipes que foram gerados antes de ADD_CAPTIONS=true

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { addCaptionsToClip } from './src/processor/captions.js';

const OUTPUT_DIR = path.resolve('./output');

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

async function main() {
    process.env.ADD_CAPTIONS = 'true'; // Força legendas independente do .env

    console.log('\n\x1b[35m' + '═'.repeat(52) + '\x1b[0m');
    console.log('\x1b[35m  📝  CANAL CORTE — Regerar Legendas\x1b[0m');
    console.log('\x1b[35m' + '═'.repeat(52) + '\x1b[0m\n');

    const files = findMp4sRecursive(OUTPUT_DIR);
    if (files.length === 0) {
        console.log('\x1b[33m  Nenhum .mp4 encontrado em ./output\x1b[0m\n');
        return;
    }

    console.log(`\x1b[36m  ${files.length} vídeo(s) encontrado(s). Adicionando legendas...\x1b[0m\n`);

    let ok = 0;
    let fail = 0;
    for (let i = 0; i < files.length; i++) {
        const f = files[i];
        console.log(`\x1b[33m  [${i + 1}/${files.length}] ${path.relative(OUTPUT_DIR, f)}\x1b[0m`);
        try {
            await addCaptionsToClip(f);
            ok++;
        } catch (err) {
            console.error(`\x1b[31m  ❌ Erro: ${err.message}\x1b[0m`);
            fail++;
        }
    }

    console.log('\n\x1b[32m' + '═'.repeat(52) + '\x1b[0m');
    console.log(`\x1b[32m  ✅  ${ok} vídeo(s) com legendas | ❌ ${fail} falha(s)\x1b[0m`);
    console.log('\x1b[32m' + '═'.repeat(52) + '\x1b[0m\n');
}

main().catch((err) => {
    console.error('\x1b[31m  Erro fatal:', err.message, '\x1b[0m');
    process.exit(1);
});
