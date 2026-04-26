#!/usr/bin/env node
// audit-content.js
// Audita TODOS os metadados existentes e gera relatório de conformidade.
// Identifica títulos, descrições e hashtags que violam diretrizes de monetização.
//
// Uso:
//   node audit-content.js                → Audita ./postados/metadata-history.json
//   node audit-content.js --scan-output  → Audita .metadata.json em ./output
//   node audit-content.js --fix          → Corrige automaticamente problemas simples
//
// Gera relatório em ./audit-report.json

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { checkContentSafety, sanitizeMetadataText } from './poster/content-filter.js';
import { validateMetadata } from './poster/metadata-validator.js';

const HISTORY_FILE = path.resolve('./postados/metadata-history.json');
const OUTPUT_DIR = path.resolve(process.env.OUTPUT_DIR || './output');
const REPORT_FILE = path.resolve('./audit-report.json');

const args = process.argv.slice(2);
const scanOutput = args.includes('--scan-output');
const autoFix = args.includes('--fix');

function findMetadataFiles(dir) {
    const results = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const full = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...findMetadataFiles(full));
            else if (entry.isFile() && entry.name.endsWith('.metadata.json')) results.push(full);
        }
    } catch { /* inacessível */ }
    return results;
}

async function main() {
    console.log('\n═══════════════════════════════════════════════════════');
    console.log('  🔍 AUDIT-CONTENT — Auditoria de Conformidade');
    console.log('═══════════════════════════════════════════════════════\n');

    const report = {
        timestamp: new Date().toISOString(),
        totalChecked: 0,
        safe: 0,
        unsafe: 0,
        warnings: 0,
        issues: [],
    };

    // Audita histórico de títulos
    if (fs.existsSync(HISTORY_FILE)) {
        const history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf-8'));
        console.log(`Auditando ${history.titles?.length ?? 0} títulos do histórico...\n`);

        for (const title of (history.titles || [])) {
            report.totalChecked++;
            const safety = checkContentSafety(title);

            if (!safety.safe) {
                report.unsafe++;
                const fixed = sanitizeMetadataText(title);
                report.issues.push({
                    type: 'title_history',
                    original: title,
                    fixed: fixed,
                    matches: safety.matches,
                    severity: 'HIGH',
                });
                console.log(`  ❌ "${title}" → Ofensas: ${safety.matches.join(', ')}`);
                if (autoFix) {
                    console.log(`     ✏️  Corrigido: "${fixed}"`);
                }
            } else {
                report.safe++;
            }
        }
    }

    // Audita arquivos .metadata.json em ./output
    if (scanOutput) {
        const metaFiles = findMetadataFiles(OUTPUT_DIR);
        console.log(`\nAuditando ${metaFiles.length} arquivo(s) .metadata.json...\n`);

        for (const metaFile of metaFiles) {
            try {
                const meta = JSON.parse(fs.readFileSync(metaFile, 'utf-8'));
                report.totalChecked++;

                const validation = validateMetadata(meta);
                const titleSafety = checkContentSafety(meta.titulo || '');
                const descSafety = checkContentSafety(meta.descricao || '');

                if (!titleSafety.safe || !descSafety.safe) {
                    report.unsafe++;
                    report.issues.push({
                        type: 'metadata_file',
                        file: path.relative(OUTPUT_DIR, metaFile),
                        titulo: meta.titulo,
                        titleMatches: titleSafety.matches,
                        descMatches: descSafety.matches,
                        score: validation.score,
                        severity: !titleSafety.safe ? 'CRITICAL' : 'HIGH',
                    });
                    console.log(`  ❌ ${path.basename(metaFile)}: Score ${validation.score}/100`);

                    if (autoFix) {
                        meta.titulo = sanitizeMetadataText(meta.titulo);
                        meta.descricao = sanitizeMetadataText(meta.descricao);
                        meta.fixedAt = new Date().toISOString();
                        fs.writeFileSync(metaFile, JSON.stringify(meta, null, 2));
                        console.log(`     ✏️  Corrigido e salvo.`);
                    }
                } else if (validation.score < 60) {
                    report.warnings++;
                    console.log(`  ⚠️  ${path.basename(metaFile)}: Score baixo (${validation.score}/100)`);
                } else {
                    report.safe++;
                }
            } catch (err) {
                console.log(`  ⚠️  Erro ao ler ${path.basename(metaFile)}: ${err.message}`);
            }
        }
    }

    // Salva relatório
    fs.writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

    console.log('\n═══════════════════════════════════════════════════════');
    console.log(`  Total verificado: ${report.totalChecked}`);
    console.log(`  ✅ Seguros: ${report.safe}`);
    console.log(`  ❌ Inseguros: ${report.unsafe}`);
    console.log(`  ⚠️  Avisos: ${report.warnings}`);
    console.log(`  Relatório salvo em: ${REPORT_FILE}`);
    console.log('═══════════════════════════════════════════════════════\n');
}

main().catch((err) => {
    console.error('Erro fatal:', err);
    process.exit(1);
});
