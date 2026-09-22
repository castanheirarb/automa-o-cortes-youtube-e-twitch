// bilibili/replicate-local.js
// Publica na Bilibili um clipe LOCAL já processado por OUTRO canal deste
// projeto (ex.: output/gta6hunter, postados/*) — uso pontual, a pedido
// explícito do usuário (03/09/2026), não um mecanismo automático.
//
// Isolamento: só LÊ o arquivo de origem (nunca move/apaga/edita), copia pra
// dentro de bilibili/output antes de processar — não interfere na fila do
// canal principal (registries, postados/, metadata-history.json continuam
// intocados). Ver CLAUDE.md sobre por que isso importa.
//
// Uso: node bilibili/replicate-local.js <caminho-do-mp4> <sourceUrl-original> [--dry-run]

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { detectBurnedCaptions } from './caption-detect.js';
import { fetchSourceInfo } from './capture.js';
import { generateChineseMetadata } from './metadata.js';
import { uploadToBilibili } from './uploader.js';
import { isAlreadyAttempted, registerAttempt, registerPublished } from './registry.js';
import { logger } from './logger.js';

const OUTPUT_DIR = path.resolve('./bilibili/output');

export async function replicateLocal(localPath, sourceUrl, { dryRun = false } = {}) {
    if (!fs.existsSync(localPath)) throw new Error(`Arquivo não encontrado: ${localPath}`);
    if (!sourceUrl) throw new Error('sourceUrl obrigatório — precisa citar a fonte original (compliance 转载).');

    // Chave do registry é o arquivo local, não o sourceUrl — várias réplicas
    // podem vir do MESMO vídeo-fonte (clipes diferentes dele), cada uma
    // precisa da própria checagem de "já tentei isso".
    const registryKey = `local:${localPath}`;
    if (isAlreadyAttempted(registryKey)) {
        logger.warn(`[Bilibili/ReplicateLocal] Já tentado antes: ${localPath} — pulando.`);
        return { published: false, skipped: true };
    }
    registerAttempt(registryKey);

    fs.mkdirSync(OUTPUT_DIR, { recursive: true });
    const destPath = path.join(OUTPUT_DIR, `replica-${Date.now()}${path.extname(localPath)}`);
    fs.copyFileSync(localPath, destPath);
    logger.info(`[Bilibili/ReplicateLocal] Copiado (fonte original intocada): ${destPath}`);

    try {
        // O clipe já vem processado (9:16, legenda em PT queimada pelo
        // pipeline do canal principal) — só confirma visualmente antes de
        // seguir, não reprocessa nada.
        const alreadyCaptioned = await detectBurnedCaptions(destPath).catch(() => true); // assume que tem, é o mais provável aqui
        logger.info(`[Bilibili/ReplicateLocal] Legenda própria detectada: ${alreadyCaptioned ? 'sim' : 'não'} (não reprocessamos o vídeo de qualquer forma).`);

        // BUG REAL descoberto em 03/09/2026: essa linha estava com um texto
        // FIXO descrevendo GTA6, reaproveitado do primeiro teste — publicou
        // um vídeo de podcast (Dilera/Igorfina no Flow) com título/descrição
        // de GTA6 (BV1X5tv6oE2y). Corrigido pra buscar o título/descrição
        // REAIS da fonte via yt-dlp, igual capture.js já faz — nunca mais
        // assume que sabe do que o vídeo trata.
        const sourceInfo = await fetchSourceInfo(sourceUrl).catch(() => ({ title: '', description: '' }));
        const context = `原视频标题: ${sourceInfo.title}\n原视频描述: ${sourceInfo.description.slice(0, 300)}\n（这是巴西频道的内容，葡萄牙语原生字幕/音频已经在视频里，不需要翻译——根据上面的真实标题/描述判断内容主题，写出准确对应的中文标题/简介/标签，不要编造与实际内容无关的主题）`;
        const metadata = await generateChineseMetadata(context);

        if (dryRun) {
            logger.success('[Bilibili/ReplicateLocal] DRY-RUN — nada publicado.');
            logger.info(`  ${destPath}`);
            logger.info(`  Título: ${metadata.title}`);
            logger.info(`  Descrição: ${metadata.desc}`);
            logger.info(`  Tags: ${metadata.tags.join(', ')}`);
            return { published: false, dryRun: true, destPath, metadata };
        }

        const { ok, bvid } = await uploadToBilibili(destPath, metadata.title, metadata.desc, {
            tags: metadata.tags,
            sourceUrl,
        });

        if (ok) {
            registerPublished(registryKey, { title: metadata.title, clipPath: destPath, bvid, sourceUrl });
            logger.success(`[Bilibili/ReplicateLocal] ✅ Publicado.${bvid ? ` (${bvid})` : ''}`);
        } else {
            logger.error('[Bilibili/ReplicateLocal] Upload falhou.');
        }

        return { published: ok, bvid, destPath, metadata };
    } finally {
        // A cópia local em bilibili/output não é apagada (mesmo padrão dos
        // outros clipes gerados — fica pra inspeção manual se quiser).
    }
}

// ─── Execução: node bilibili/replicate-local.js <mp4> <sourceUrl> [--dry-run]
if (process.argv[1] && process.argv[1].endsWith('replicate-local.js')) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const [localPath, sourceUrl] = args.filter((a) => !a.startsWith('--'));
    if (!localPath || !sourceUrl) {
        console.error('Uso: node bilibili/replicate-local.js <caminho.mp4> <sourceUrl> [--dry-run]');
        process.exit(1);
    }
    replicateLocal(localPath, sourceUrl, { dryRun })
        .then((r) => { process.exitCode = (r.published || r.dryRun || r.skipped) ? 0 : 1; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
