#!/usr/bin/env node
// regen-safe.js
// Regenera metadados de TODOS os clipes existentes usando o pipeline seguro.
// Útil para corrigir títulos/descrições que já foram gerados com linguagem ofensiva.
//
// Uso:
//   node regen-safe.js                    → Regenera todos os clipes em ./output
//   node regen-safe.js --persona cariani  → Só regenera clipes da persona "cariani"
//   node regen-safe.js --dry-run          → Mostra o que seria gerado, sem salvar
//
// O script salva os metadados em um arquivo JSON ao lado de cada .mp4:
//   output/cariani/01__pico-123s.mp4
//   output/cariani/01__pico-123s.metadata.json

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { generateMetadata } from './poster/metadata.js';
import { validateAndLog } from './poster/metadata-validator.js';
import { checkContentSafety } from './poster/content-filter.js';

const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || './output');
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const personaFilter = args.includes('--persona') ? args[args.indexOf('--persona') + 1] : null;

// ─── Busca recursiva de .mp4 ─────────────────────────────────────────────────

function findMp4s(dir) {
    const results = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...findMp4s(full));
            else if (entry.isFile() && entry.name.endsWith('.mp4')) results.push(full);
        }
    } catch { /* inacessível */ }
    return results;
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  🔄 REGEN-SAFE — Regeneração Segura de Metadados');
    console.log(`  Modo: ${dryRun ? 'DRY-RUN (sem salvar)' : 'PRODUÇÃO'}`);
    if (personaFilter) console.log(`  Persona: ${personaFilter}`);
    console.log('═══════════════════════════════════════════════════════\n');

    let searchDir = OUTPUT_DIR;
    if (personaFilter) {
        searchDir = path.join(OUTPUT_DIR, personaFilter);
        if (!fs.existsSync(searchDir)) {
            console.error(`Pasta não encontrada: ${searchDir}`);
            process.exit(1);
        }
    }

    const mp4Files = findMp4s(searchDir);
    console.log(`Encontrados ${mp4Files.length} clipe(s) para processar.\n`);

    let processed = 0;
    let errors = 0;
    let unsafe = 0;

    for (const mp4Path of mp4Files) {
        const relative = path.relative(OUTPUT_DIR, mp4Path);
        const metaPath = mp4Path.replace(/\.mp4$/i, '.metadata.json');

        console.log(`\n── [${processed + 1}/${mp4Files.length}] ${relative} ──`);

        try {
            const metadata = await generateMetadata(mp4Path);
            const validated = validateAndLog(metadata);

            // Verificação extra de segurança
            const titleSafe = checkContentSafety(validated.titulo);
            const descSafe = checkContentSafety(validated.descricao);

            if (!titleSafe.safe || !descSafe.safe) {
                console.log(`  ⚠️  CONTEÚDO INSEGURO detectado — marcando para revisão manual`);
                validated._needsReview = true;
                unsafe++;
            }

            if (dryRun) {
                console.log(`  [DRY-RUN] Título: '${validated.titulo}'`);
                console.log(`  [DRY-RUN] Descrição: '${validated.descricao}'`);
                console.log(`  [DRY-RUN] Hashtags: ${validated.hashtags}`);
                console.log(`  [DRY-RUN] Score: ${validated._validation?.score ?? '?'}/100`);
            } else {
                fs.writeFileSync(metaPath, JSON.stringify({
                    titulo: validated.titulo,
                    descricao: validated.descricao,
                    hashtags: validated.hashtags,
                    score: validated._validation?.score ?? 0,
                    needsReview: validated._needsReview ?? false,
                    generatedAt: new Date().toISOString(),
                }, null, 2));
                console.log(`  ✅ Salvo: ${path.basename(metaPath)}`);
            }

            processed++;

        } catch (err) {
            console.error(`  ❌ Erro: ${err.message}`);
            errors++;
        }

        // Delay entre chamadas para não estourar rate limits
        await new Promise((r) => setTimeout(r, 2000));
    }

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  Processados: ${processed}/${mp4Files.length}`);
    console.log(`  Erros: ${errors}`);
    console.log(`  Inseguros (revisão manual): ${unsafe}`);
    console.log('═══════════════════════════════════════════════════════\n');
}

main().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
