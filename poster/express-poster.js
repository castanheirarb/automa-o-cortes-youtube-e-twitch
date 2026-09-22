// poster/express-poster.js
// Postagem expressa — envia um clipe diretamente ao YouTube e TikTok,
// ignorando o round-robin e os horários do cron.
//
// Uso típico: Sports Radar chama postExpressClip() logo após capturar um gol.
//
// Garantias:
//   • Adquire o upload-lock antes de abrir o Playwright (serializa com o cron)
//   • Não modifica queue-state.json (round-robin intacto)
//   • Move o arquivo para ./archive/posted/ após sucesso em pelo menos 1 plataforma
//   • Retorna { youtube: bool|null, tiktok: bool|null }

import 'dotenv/config';
import fs   from 'node:fs';
import path from 'node:path';

import { acquireUploadLock }  from './upload-lock.js';
import { uploadToYouTube }    from './uploaders/youtube.js';
import { uploadToTikTok }     from './uploaders/tiktok.js';
import {
    generateMetadata, generateFallbackMetadata,
    formatTitle, formatYouTubeDescription, formatTikTokCaption,
} from './metadata.js';
import {
    isTikTokPosted, registerTikTokPosted, ensureDirs,
    isYouTubePosted, registerYouTubePosted,
    isContentPosted, registerContentPosted,
} from './queue.js';
import { probeVideoDuration } from '../src/processor/ffmpeg.js';
import { EXTRA_YOUTUBE_ACCOUNTS, EXTRA_TIKTOK_ACCOUNTS } from './accounts.js';
import { logger } from './logger.js';

// ─── Configuração ─────────────────────────────────────────────────────────────

const HEADLESS      = process.env.HEADLESS !== 'false';
const ARCHIVE_DIR   = path.resolve('./archive/posted');
const UPLOAD_YT     = process.env.UPLOAD_TO_YOUTUBE !== 'false';
const UPLOAD_TT     = process.env.UPLOAD_TO_TIKTOK  !== 'false';
// Cortes com mais de N segundos são publicados no YouTube como vídeo normal
// (sem #shorts), não como Short — pedido específico para cortes de futebol,
// que costumam ter lances mais longos que o corte curto padrão de podcast/react.
const LONG_VIDEO_THRESHOLD_SEC = parseInt(process.env.EXPRESS_LONG_VIDEO_THRESHOLD_SEC || '30', 10);
// Distribuição p/ contas extras (poster/accounts.js): atraso aleatório entre
// contas — nunca simultâneo, sempre depois da conta principal. Reduz o padrão
// "mesma máquina publicando idêntico em várias contas ao mesmo tempo".
const EXTRA_DELAY_MIN_SEC = parseInt(process.env.EXTRA_ACCOUNT_DELAY_MIN_SEC || '60',  10);
const EXTRA_DELAY_MAX_SEC = parseInt(process.env.EXTRA_ACCOUNT_DELAY_MAX_SEC || '180', 10);

function ensureArchiveDir() {
    if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
}

function archiveClip(clipPath) {
    try {
        const dest = path.join(ARCHIVE_DIR, path.basename(clipPath));
        fs.renameSync(clipPath, dest);
        logger.success(`[Express] Arquivo arquivado: ${path.basename(dest)}`);
    } catch (err) {
        logger.warn(`[Express] Falha ao arquivar arquivo: ${err.message}`);
    }
}

function randomDelayMs() {
    const min = EXTRA_DELAY_MIN_SEC * 1000;
    const max = EXTRA_DELAY_MAX_SEC * 1000;
    return min + Math.random() * (max - min);
}

/**
 * Replica o clipe já publicado na conta principal para as contas extras
 * configuradas em poster/accounts.js. Sequencial (nunca abre 2 navegadores ao
 * mesmo tempo), com atraso aleatório entre contas. Roda DEPOIS da conta
 * principal, ainda dentro do mesmo upload-lock — falha aqui nunca afeta o
 * resultado nem a decisão de arquivar o clipe da conta principal.
 */
async function distributeToExtraAccounts(absPath, title, ytDescription, tikTokCaption) {
    if (EXTRA_YOUTUBE_ACCOUNTS.length === 0 && EXTRA_TIKTOK_ACCOUNTS.length === 0) return;

    logger.step(
        `[Express] Distribuindo para ${EXTRA_YOUTUBE_ACCOUNTS.length} conta(s) extra(s) ` +
        `do YouTube e ${EXTRA_TIKTOK_ACCOUNTS.length} do TikTok...`
    );

    if (UPLOAD_YT) {
        for (const account of EXTRA_YOUTUBE_ACCOUNTS) {
            await new Promise((r) => setTimeout(r, randomDelayMs()));
            try {
                logger.step(`[Express] Upload -> YouTube (${account.label})...`);
                const ok = await uploadToYouTube(
                    absPath, title, ytDescription, HEADLESS, null, path.resolve(account.profileDir)
                );
                logger.info(`[Express] ${account.label}: ${ok ? 'ok' : 'falhou'}`);
            } catch (err) {
                logger.error(`[Express] Conta extra "${account.label}" (YouTube) falhou: ${err.message}`);
            }
        }
    }

    if (UPLOAD_TT) {
        for (const account of EXTRA_TIKTOK_ACCOUNTS) {
            await new Promise((r) => setTimeout(r, randomDelayMs()));
            try {
                logger.step(`[Express] Upload -> TikTok (${account.label})...`);
                const ok = await uploadToTikTok(absPath, tikTokCaption, HEADLESS, path.resolve(account.profileDir));
                logger.info(`[Express] ${account.label}: ${ok ? 'ok' : 'falhou'}`);
            } catch (err) {
                logger.error(`[Express] Conta extra "${account.label}" (TikTok) falhou: ${err.message}`);
            }
        }
    }
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Posta um clipe imediatamente no YouTube e TikTok, sem round-robin.
 *
 * @param {string} clipPath   Caminho absoluto (ou relativo) do .mp4 a ser postado
 * @param {object} [metadata] Metadados pré-gerados. Se omitido, gera via IA.
 *   @param {string} metadata.titulo
 *   @param {string} metadata.descricao
 *   @param {string} metadata.hashtags
 * @param {object} [options]
 *   @param {string} [options.ytProfileDir] Perfil dedicado do YouTube (senão usa a conta principal)
 *   @param {string} [options.ttProfileDir] Perfil dedicado do TikTok (senão usa a conta principal)
 *   @param {boolean} [options.madeForKids] Marca "conteúdo para crianças" no YouTube
 * @returns {Promise<{ youtube: boolean|null, tiktok: boolean|null }>}
 */
export async function postExpressClip(clipPath, metadata = null, options = {}) {
    const { ytProfileDir = null, ttProfileDir = null, madeForKids = false, skipTikTok = false } = options;
    ensureDirs();
    ensureArchiveDir();

    const absPath = path.resolve(clipPath);

    if (!fs.existsSync(absPath)) {
        logger.error(`[Express] Arquivo não encontrado: ${absPath}`);
        return { youtube: false, tiktok: false };
    }

    logger.step(`[Express] Iniciando postagem expressa: ${path.basename(absPath)}`);

    // ── Interruptor mestre de teste ────────────────────────────────────────────
    // Mesmo guard de poster/index.js (postVideoJob) — faltava aqui, e é por isso
    // que POSTER_DRY_RUN=true não impedia o vídeo longo diário (que passa por
    // este módulo, não por postVideoJob) de publicar de verdade. Checa ANTES de
    // qualquer geração de metadados ou escrita de registry.
    if (process.env.POSTER_DRY_RUN === 'true') {
        logger.warn(`[Express] 🧪 POSTER_DRY_RUN=true — não vou subir "${path.basename(absPath)}" em lugar nenhum.`);
        return { youtube: null, tiktok: null };
    }

    // ── Guarda anti-duplicata por CONTEÚDO ────────────────────────────────────
    // O registry por caminho não pega compilações regeradas com outro nome
    // (Date.now() no nome, mesmo conteúdo). Comparar a impressão digital do
    // arquivo evita repostar o mesmo vídeo, como já ocorreu com o vídeo longo.
    if (isContentPosted(absPath)) {
        logger.error(`[Express] ❌ Conteúdo idêntico já publicado — postagem cancelada: ${path.basename(absPath)}`);
        archiveClip(absPath);
        return { youtube: null, tiktok: null };
    }

    // ── Duração: define se o corte vai como Short ou vídeo longo no YouTube ────
    const duration = await probeVideoDuration(absPath);
    const isLongVideo = duration !== null && duration > LONG_VIDEO_THRESHOLD_SEC;
    logger.info(
        `[Express] Duração: ${duration ? duration.toFixed(1) + 's' : 'desconhecida'} — ` +
        `${isLongVideo ? 'vídeo longo (sem #shorts)' : 'Short'}`
    );

    // ── Gera metadados se não fornecidos ──────────────────────────────────────
    if (!metadata) {
        logger.info('[Express] Gerando metadados via IA...');
        try {
            metadata = await generateMetadata(absPath, { isLongVideo });
        } catch (err) {
            logger.warn(`[Express] IA falhou (${err.message}) — usando fallback.`);
            metadata = generateFallbackMetadata(path.basename(absPath, '.mp4'), isLongVideo);
        }
    }

    const finalTitle    = formatTitle(metadata);
    const ytDescription = formatYouTubeDescription(metadata);
    const tikTokCaption = formatTikTokCaption(metadata);

    logger.info(`[Express] Titulo YT  : "${finalTitle}"`);
    logger.info(`[Express] Caption TT : "${tikTokCaption.slice(0, 80)}${tikTokCaption.length > 80 ? '...' : ''}"`);

    // ── Adquire o lock (serializa com o cron normal) ──────────────────────────
    const release = await acquireUploadLock('express-poster');
    const results = { youtube: null, tiktok: null };

    try {
        // ── YouTube ───────────────────────────────────────────────────────────
        if (UPLOAD_YT) {
            if (isYouTubePosted(absPath)) {
                logger.warn('[Express] Arquivo ja enviado ao YouTube (registry) — pulando.');
            } else {
                logger.step('[Express] Upload -> YouTube...');
                // Registra ANTES: interrupção no meio do upload não vira duplicata
                registerYouTubePosted(absPath);
                if (ytProfileDir) logger.info(`[Express] Canal dedicado (YouTube) → ${ytProfileDir}`);
                results.youtube = await uploadToYouTube(
                    absPath, finalTitle, ytDescription, HEADLESS, null,
                    ytProfileDir ? path.resolve(ytProfileDir) : undefined, madeForKids
                );
                // Só registra a impressão digital com o envio confirmado —
                // registrar antes impediria retentar um upload que falhou.
                if (results.youtube === true) registerContentPosted(absPath);
            }
        } else {
            logger.warn('[Express] Upload para YouTube desabilitado.');
        }

        // Pausa entre plataformas
        if (UPLOAD_YT && UPLOAD_TT) {
            await new Promise((r) => setTimeout(r, 10_000));
        }

        // ── TikTok ────────────────────────────────────────────────────────────
        if (UPLOAD_TT && skipTikTok) {
            logger.info('[Express] TikTok pulado (skipTikTok) — postando só no YouTube.');
        } else if (UPLOAD_TT) {
            if (isTikTokPosted(absPath)) {
                logger.warn('[Express] Arquivo ja enviado ao TikTok — pulando.');
            } else {
                logger.step('[Express] Upload -> TikTok...');
                registerTikTokPosted(absPath);
                if (ttProfileDir) logger.info(`[Express] Conta dedicada (TikTok) → ${ttProfileDir}`);
                results.tiktok = await uploadToTikTok(
                    absPath, tikTokCaption, HEADLESS, ttProfileDir ? path.resolve(ttProfileDir) : undefined
                );
            }
        } else {
            logger.warn('[Express] Upload para TikTok desabilitado.');
        }

        // ── Distribui para contas extras (poster/accounts.js), se configuradas ──
        // Isolado em try/catch próprio: nunca deve afetar o resultado ou a
        // decisão de arquivar o clipe da conta principal, que já terminou acima.
        try {
            await distributeToExtraAccounts(absPath, finalTitle, ytDescription, tikTokCaption);
        } catch (err) {
            logger.error(`[Express] Distribuição para contas extras falhou: ${err.message}`);
        }

        // ── Arquivo: arquiva se ao menos 1 plataforma foi bem-sucedida ────────
        const anySuccess = results.youtube === true || results.tiktok === true;
        if (anySuccess) {
            archiveClip(absPath);
        } else {
            logger.warn(
                '[Express] Ambas as plataformas falharam — arquivo mantido para inspeção:\n' +
                `  ${absPath}`
            );
        }

        logger.success(
            `[Express] Concluido — YouTube: ${fmt(results.youtube)} | TikTok: ${fmt(results.tiktok)}`
        );

    } finally {
        release();
    }

    return results;
}

function fmt(r) {
    if (r === null) return 'pulado';
    return r ? 'ok' : 'falhou';
}
