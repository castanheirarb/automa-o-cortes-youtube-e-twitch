// poster/index.js
// Ponto de entrada do auto-poster.
// Agenda 3 uploads diários via node-cron e orquestra o pipeline completo.
//
// Uso normal (produção):     node poster/index.js
// Uso para login manual:     node poster/index.js --login

import 'dotenv/config';
import cron from 'node-cron';
import { getNextVideo, markAsPosted, ensureDirs } from './queue.js';
import { uploadToYouTube } from './uploaders/youtube.js';
import { uploadToTikTok } from './uploaders/tiktok.js';
import { logger } from './logger.js';

// ─── Configurações (via .env) ─────────────────────────────────────────────────

const HEADLESS = process.env.HEADLESS !== 'false';          // default: true
const UPLOAD_YOUTUBE = process.env.UPLOAD_TO_YOUTUBE !== 'false'; // default: true
const UPLOAD_TIKTOK = process.env.UPLOAD_TO_TIKTOK !== 'false';  // default: true

// Horários das 3 postagens diárias (formato cron: 'minuto hora * * *')
const SCHEDULES = [
    process.env.CRON_HORARIO_1 || '0 11 * * *',  // 11:00
    process.env.CRON_HORARIO_2 || '0 15 * * *',  // 15:00
    process.env.CRON_HORARIO_3 || '0 19 * * *',  // 19:00
];

// ─── Pipeline de Upload ───────────────────────────────────────────────────────

let isUploading = false; // Trava para evitar uploads simultâneos

/**
 * Executa um ciclo completo de upload:
 * 1. Pega o próximo vídeo da fila
 * 2. Faz upload no YouTube (se habilitado)
 * 3. Faz upload no TikTok (se habilitado)
 * 4. Move o arquivo para ./postados
 */
async function runUploadCycle() {
    if (isUploading) {
        logger.warn('Upload já em andamento, pulando este ciclo.');
        return;
    }

    isUploading = true;
    logger.cron('🚀 Iniciando ciclo de upload agendado...');

    try {
        const video = getNextVideo();
        if (!video) return; // Sem vídeos disponíveis

        const { filePath, title } = video;
        const results = { youtube: null, tiktok: null };

        // ── YouTube ────────────────────────────────────────────────────────────
        if (UPLOAD_YOUTUBE) {
            logger.step('📺 Iniciando upload para o YouTube...');
            results.youtube = await uploadToYouTube(filePath, title, HEADLESS);
        } else {
            logger.warn('Upload para YouTube desabilitado (UPLOAD_TO_YOUTUBE=false).');
        }

        // Aguarda 10s entre plataformas para estabilidade
        if (UPLOAD_YOUTUBE && UPLOAD_TIKTOK) {
            await new Promise((r) => setTimeout(r, 10000));
        }

        // ── TikTok ─────────────────────────────────────────────────────────────
        if (UPLOAD_TIKTOK) {
            logger.step('🎵 Iniciando upload para o TikTok...');
            results.tiktok = await uploadToTikTok(filePath, title, HEADLESS);
        } else {
            logger.warn('Upload para TikTok desabilitado (UPLOAD_TO_TIKTOK=false).');
        }

        // ── Move o arquivo somente se ao menos 1 upload deu certo ─────────────
        const anySuccess = results.youtube === true || results.tiktok === true;
        if (anySuccess) {
            markAsPosted(filePath);
        } else {
            logger.error('Todos os uploads falharam. Arquivo mantido em ./output para nova tentativa.');
        }

        // Resumo
        logger.cron(
            `Ciclo concluído. YouTube: ${fmtResult(results.youtube)} | TikTok: ${fmtResult(results.tiktok)}`
        );

    } catch (err) {
        logger.error(`Erro inesperado no ciclo de upload: ${err.message}`);
    } finally {
        isUploading = false;
    }
}

function fmtResult(r) {
    if (r === null) return '⏭ pulado';
    return r ? '✅ ok' : '❌ falhou';
}

// ─── Modo Login Manual ────────────────────────────────────────────────────────

/**
 * Abre o Chrome com HEADLESS=false para que você faça login manual
 * no YouTube e/ou TikTok. Usado apenas na primeira vez.
 */
async function runLoginMode() {
    logger.step('🔓 MODO LOGIN — Abrindo navegadores para autenticação manual...');
    logger.warn('Faça login nas plataformas e feche os navegadores quando terminar.');

    if (UPLOAD_YOUTUBE) {
        logger.info('Abrindo YouTube Studio...');
        await uploadToYouTube('/dev/null', '', false).catch(() => { });
    }
    if (UPLOAD_TIKTOK) {
        logger.info('Abrindo TikTok...');
        await uploadToTikTok('/dev/null', '', false).catch(() => { });
    }
}

// ─── Inicialização ────────────────────────────────────────────────────────────

function printBanner() {
    console.log('\n\x1b[35m' + '═'.repeat(54) + '\x1b[0m');
    console.log('\x1b[35m  📅  CANAL CORTE — Auto-Poster\x1b[0m');
    console.log(`\x1b[35m      Headless: ${HEADLESS ? 'ON' : 'OFF (visível)'}  |  YouTube: ${UPLOAD_YOUTUBE ? 'ON' : 'OFF'}  |  TikTok: ${UPLOAD_TIKTOK ? 'ON' : 'OFF'}\x1b[0m`);
    console.log('\x1b[35m' + '═'.repeat(54) + '\x1b[0m\n');
}

async function main() {
    printBanner();
    ensureDirs();

    // Modo login: abre browsers visualmente e encerra
    if (process.argv.includes('--login')) {
        await runLoginMode();
        logger.success('Login concluído. Rode sem --login para iniciar o agendador.');
        process.exit(0);
    }

    // Registra cada horário no cron
    SCHEDULES.forEach((expression, i) => {
        const isValid = cron.validate(expression);
        if (!isValid) {
            logger.error(`Expressão cron inválida [CRON_HORARIO_${i + 1}]: "${expression}"`);
            return;
        }
        cron.schedule(expression, () => {
            logger.cron(`⏰ Horário ${i + 1} atingido (${expression}) — disparando upload...`);
            runUploadCycle();
        }, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });
        logger.success(`Agendamento ${i + 1} registrado: ${expression}`);
    });

    logger.info('Auto-poster aguardando os horários agendados. Pressione Ctrl+C para encerrar.\n');
}

main().catch((err) => {
    logger.error(`Erro fatal: ${err.message}`);
    process.exit(1);
});
