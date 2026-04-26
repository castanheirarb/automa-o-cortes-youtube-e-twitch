// poster/index.js
// Ponto de entrada do auto-poster com Round-Robin de Personas.
//
// Uso normal (produção):     node poster/index.js
// Postar agora imediatamente: node poster/index.js --now
// Login manual:              node poster/login.js
//
// Lógica de Postagem (Round-Robin):
//   persona_ativa = PERSONAS[índice_global % total_personas]
//   Com 3 personas e 4 posts/dia → ciclo fecha em 12 posts (LCM(3,4) = 3 dias)
//   O índice nunca reseta — persiste em scheduler/queue-state.json
//
// Fallback de 3 níveis:
//   1. Tenta a persona do turno atual (round-robin normal)
//   2. Tenta as demais personas em sequência (skipping vazias)
//   3. Dispara re-captação automática da persona original (emergência)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import cron from 'node-cron';

import { PERSONAS } from '../src/capturer/personas.js';
import {
    getNextPersonaWithFallback, advanceQueue,
    getPersonaOutputDir, getQueueState
} from '../src/scheduler/round-robin.js';
import { capturePersona } from '../src/capturer/capturer.js';
import { initBinaries } from '../src/processor/ffmpeg.js';

import {
    getNextVideoFromPersona, markAsPosted,
    registerAsPosted, ensureDirs,
    isTikTokPosted, registerTikTokPosted,
} from './queue.js';
import { uploadToYouTube } from './uploaders/youtube.js';
import { uploadToTikTok } from './uploaders/tiktok.js';
import {
    generateMetadata, generateFallbackMetadata,
    formatTitle, formatYouTubeDescription, formatTikTokCaption
} from './metadata.js';
import { recordMetadataHistory, validateTikTokCaption, validateAndLog, sanitizeMetadata } from './metadata-validator.js';
import { checkContentSafety } from './content-filter.js';
import { getPersonaBranding } from './branding.js';
import { logger } from './logger.js';
import { createProfessionalThumbnail } from '../src/processor/thumbnail.js';
import { optimizeContent } from '../src/content-optimizer/index.js';

// ─── Configurações (via .env) ——————————————————————————————————
const HEADLESS = process.env.HEADLESS !== 'false';

const TIKTOK_ONLY = process.argv.includes('--tiktok-only');
const YOUTUBE_ONLY = process.argv.includes('--youtube-only');

const UPLOAD_YOUTUBE = !TIKTOK_ONLY && process.env.UPLOAD_TO_YOUTUBE !== 'false';
const UPLOAD_TIKTOK = !YOUTUBE_ONLY && process.env.UPLOAD_TO_TIKTOK !== 'false';

if (TIKTOK_ONLY) console.log('\x1b[36m  🎵 Modo TikTok-only ativado\x1b[0m');
if (YOUTUBE_ONLY) console.log('\x1b[31m  📺 Modo YouTube-only ativado\x1b[0m');

// 4 slots cron padrão: 11h, 15h, 19h, 23h (horário de Brasília)
// Cada slot pode ser sobreposto via .env individualmente.
const DEFAULT_SLOTS = [
    '0 11 * * *',  // 11h
    '0 15 * * *',  // 15h
    '0 19 * * *',  // 19h
    '0 23 * * *',  // 23h
];

const CRON_SLOTS = [
    process.env.CRON_HORARIO_1,
    process.env.CRON_HORARIO_2,
    process.env.CRON_HORARIO_3,
    process.env.CRON_HORARIO_4,
    process.env.CRON_HORARIO,  // compatibilidade legado
].filter(Boolean);

// Usa os slots do .env se configurados, senão aplica os 4 padrões
const ACTIVE_SLOTS = CRON_SLOTS.length > 0 ? CRON_SLOTS : DEFAULT_SLOTS;

// ─── Pipeline de Upload ───────────────────────────────────────────────────────

let isUploading = false; // Trava para evitar uploads simultâneos

/**
 * Executa um ciclo completo de upload com Round-Robin de Personas:
 *
 * Nível 1 — Persona do turno (round-robin normal)
 * Nível 2 — Fallback para próximas personas não-vazias
 * Nível 3 — Re-captação automática se TODAS as pastas estiverem vazias
 */
async function runUploadCycle() {
    if (isUploading) {
        logger.warn('[Poster] Upload já em andamento — ciclo ignorado.');
        return;
    }

    isUploading = true;
    const state = getQueueState();
    let currentFile = null; // rastreado para deduplicação de segurança em caso de crash
    const results = { youtube: null, tiktok: null }; // hoisted para o catch poder verificar sucesso parcial
    logger.cron(`🚀 Ciclo de upload — índice global: ${state.index} | último: ${state.lastPersona ?? 'nenhum'}`);

    try {
        // ── Nível 1 + 2: Round-Robin com fallback automático ─────────────────
        let result = getNextPersonaWithFallback(PERSONAS);

        // ── Nível 3: Re-captação de emergência ────────────────────────────────
        if (!result) {
            logger.warn('[Poster] ⚠️  Todas as pastas vazias — disparando re-captação de emergência...');
            try {
                // Captura apenas a persona do turno atual (índice atual sem avançar)
                const { index } = getQueueState();
                const personaToCapture = PERSONAS[index % PERSONAS.length];
                await capturePersona(personaToCapture, { force: false, minClips: 3 });

                // Tenta novamente após a re-captação
                result = getNextPersonaWithFallback(PERSONAS);
            } catch (captureErr) {
                logger.error(`[Poster] Re-captação falhou: ${captureErr.message}`);
            }

            if (!result) {
                logger.error('[Poster] ❌ Impossível postar: sem vídeos mesmo após re-captação.');
                return;
            }
        }

        const { persona, skipped } = result;
        const personaDir = getPersonaOutputDir(persona);

        if (skipped.length > 0) {
            logger.warn(`[Poster] Puladas por pasta vazia: [${skipped.join(', ')}] → postando de "${persona.displayName}"`);
        } else {
            logger.info(`[Poster] 🎯 Turno de: ${persona.displayName}`);
        }

        // ── Busca o próximo vídeo da pasta da persona ──────────────────────────
        let activePersona = persona;
        let video = getNextVideoFromPersona(personaDir);

        if (!video) {
            // Pasta ficou vazia entre o check e agora — avança e tenta a próxima
            logger.warn(`[Poster] Pasta de "${persona.displayName}" esvaziou — buscando próxima persona...`);
            advanceQueue(persona.name);

            const retry = getNextPersonaWithFallback(PERSONAS);
            if (!retry?.persona) {
                logger.error('[Poster] ❌ Todas as pastas estão vazias. Rode: npm run capture');
                return;
            }

            video = getNextVideoFromPersona(getPersonaOutputDir(retry.persona));
            if (!video) {
                logger.error('[Poster] ❌ Sem vídeos disponíveis em nenhuma persona.');
                return;
            }

            activePersona = retry.persona;
            logger.info(`[Poster] ↪ Postando de: ${activePersona.displayName}`);
        }

        const { filePath, title: rawTitle } = video;
        currentFile = filePath; // salva referência para deduplicação de segurança

        // ── Gera metadados virais via IA ──────────────────────────────────────
        let metadata;
        try {
            metadata = await generateMetadata(filePath);
            if (process.env.OPTIMIZE_CONTENT === 'true') {
                metadata = await optimizeContent(metadata);
            }
        } catch (err) {
            logger.warn(`[Metadata] IA falhou (${err.message}) — pulando vídeo para evitar título genérico.`);
            logger.info('[Poster] Vídeo deixado em ./output/ para nova tentativa no próximo ciclo.');
            advanceQueue(activePersona.name);
            return;
        }

        // ── Validação obrigatória antes de qualquer upload ────────────────────
        // Roda após generateMetadata + optimizeContent para garantir que o
        // conteúdo final (já reescrito) seja seguro e de qualidade.
        const validated = validateAndLog(metadata);
        metadata = { titulo: validated.titulo, descricao: validated.descricao, hashtags: validated.hashtags, transcript: metadata.transcript };

        const MIN_SCORE = parseInt(process.env.MIN_VALIDATION_SCORE || '40', 10);
        if (validated._validation.score < MIN_SCORE) {
            logger.warn(`[Poster] Score de validação baixo (${validated._validation.score}/${MIN_SCORE}) — pulando vídeo para evitar título de baixa qualidade.`);
            advanceQueue(activePersona.name);
            return;
        }

        // Verificação extra de segurança de conteúdo (pós-otimização)
        const titleSafety = checkContentSafety(metadata.titulo);
        const descSafety = checkContentSafety(metadata.descricao);
        if (!titleSafety.safe || !descSafety.safe) {
            logger.error(`[Poster] Conteúdo inseguro detectado pós-validação — sanitizando forçadamente.`);
            const forceSanitized = sanitizeMetadata(metadata);
            metadata = { ...forceSanitized, transcript: metadata.transcript };
        }

        // Gera thumbnail profissional com IA
        let thumbnailPath = null;
        if (process.env.CREATE_THUMBNAIL === 'true') {
            try {
                thumbnailPath = await createProfessionalThumbnail(filePath, metadata);
            } catch (thumbErr) {
                logger.warn(`[Poster] Geração de thumbnail falhou: ${thumbErr.message}`);
            }
        }

        // YouTube: título limpo (sem hashtags) + descrição com hashtags no final
        const finalTitle = formatTitle(metadata);
        const ytDescription = formatYouTubeDescription(metadata);

        // TikTok: caption único com título + descrição + hashtags (máx 2200 chars)
        const tikTokCaption = formatTikTokCaption(metadata);

        logger.info(`[Poster] Título YT   : "${finalTitle}"`);
        logger.info(`[Poster] Caption TT  : "${tikTokCaption.slice(0, 100)}${tikTokCaption.length > 100 ? '...' : ''}"`);

        // Valida o caption do TikTok antes de postar
        const ttValidation = validateTikTokCaption(tikTokCaption);
        if (!ttValidation.valid) {
            for (const err of ttValidation.errors) logger.error(`[Validator/TikTok] ❌ ${err}`);
        }
        for (const warn of ttValidation.warnings) logger.warn(`[Validator/TikTok] ⚠️  ${warn}`);

        // ── YouTube ────────────────────────────────────────────────────────────
        if (UPLOAD_YOUTUBE) {
            logger.step('📺 Upload → YouTube...');
            results.youtube = await uploadToYouTube(filePath, finalTitle, ytDescription, HEADLESS, thumbnailPath);
        } else {
            logger.warn('Upload para YouTube desabilitado (UPLOAD_TO_YOUTUBE=false).');
        }

        // Intervalo entre plataformas para estabilidade
        if (UPLOAD_YOUTUBE && UPLOAD_TIKTOK) {
            await new Promise((r) => setTimeout(r, 10_000));
        }

        // ── TikTok ─────────────────────────────────────────────────────────────
        if (UPLOAD_TIKTOK) {
            if (isTikTokPosted(filePath)) {
                logger.warn('[Poster] ⚠️  Arquivo já enviado ao TikTok (tiktok-registry) — pulando para evitar duplicata.');
                results.tiktok = null;
            } else {
                logger.step('🎵 Upload → TikTok...');
                // Registra ANTES de tentar: se o processo crashar durante o upload,
                // o arquivo não será reenviado ao TikTok no próximo ciclo.
                registerTikTokPosted(filePath);
                results.tiktok = await uploadToTikTok(filePath, tikTokCaption, HEADLESS);
            }
        } else {
            logger.warn('Upload para TikTok desabilitado (UPLOAD_TO_TIKTOK=false).');
        }

        // ── Registra e move o arquivo ─────────────────────────────────────────
        // IMPORTANTE: o arquivo sempre é registrado no registry, independente do resultado.
        // Isso garante que mesmo um erro inesperado (timeout, crash) não cause re-postagem.
        const anySuccess = results.youtube === true || results.tiktok === true;

        if (anySuccess) {
            markAsPosted(filePath);
            // Registra no histórico de unicidade — usa só o titulo (sem hashtags embutidas)
            // para que a detecção de duplicata compare títulos iguais corretamente
            recordMetadataHistory(metadata.titulo, metadata.hashtags || '');
            logger.success(`[Poster] Arquivo movido para ./postados após upload bem-sucedido.`);
        } else {
            // Falha em ambas as plataformas: registra no registry para evitar loop infinite.
            // O arquivo FICA em ./output para inspeção manual.
            // Remova da registry em ./postados/registry.json para retentar.
            registerAsPosted(filePath);
            logger.error(
                '[Poster] Todos os uploads falharam. Arquivo mantido em ./output/\n' +
                '⚠️  Registrado no registry para evitar re-postagem automática.\n' +
                '   Para retentar: remova o nome do arquivo de ./postados/registry.json'
            );
        }

        // Avança o índice do round-robin SEMPRE (success ou falha)
        // para não travar o ciclo no mesmo vídeo problemático indefinidamente.
        advanceQueue(activePersona.name);

        logger.cron(
            `✅ Ciclo concluído — ${activePersona.displayName} | ` +
            `YouTube: ${fmtResult(results.youtube)} | TikTok: ${fmtResult(results.tiktok)}`
        );

    } catch (err) {
        logger.error(`[Poster] Erro inesperado no ciclo de upload: ${err.message}`);
        if (process.env.DEBUG) console.error(err);
        // Se YouTube já tinha sido bem-sucedido quando o crash ocorreu (ex: TikTok finally),
        // move o arquivo para ./postados normalmente em vez de só registrar no registry.
        if (currentFile) {
            if (results.youtube === true) {
                markAsPosted(currentFile);
                logger.warn(`[Poster] YouTube ok antes do crash — arquivo movido para ./postados: ${path.basename(currentFile)}`);
            } else {
                registerAsPosted(currentFile);
                logger.warn(`[Poster] Arquivo registrado preventivamente no registry após erro: ${path.basename(currentFile)}`);
            }
        }
    } finally {
        isUploading = false;
    }
}

function fmtResult(r) {
    if (r === null) return '⏭ pulado';
    return r ? '✅ ok' : '❌ falhou';
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner() {
    const state = getQueueState();
    const current = PERSONAS[state.index % PERSONAS.length];
    const slots = ACTIVE_SLOTS.join(' | ');

    console.log('\n\x1b[35m' + '═'.repeat(58) + '\x1b[0m');
    console.log('\x1b[35m  📅  CANAL CORTE — Auto-Poster (Round-Robin)\x1b[0m');
    console.log(`\x1b[35m      Headless: ${HEADLESS ? 'ON' : 'OFF'}  |  YouTube: ${UPLOAD_YOUTUBE ? 'ON' : 'OFF'}  |  TikTok: ${UPLOAD_TIKTOK ? 'ON' : 'OFF'}\x1b[0m`);
    console.log(`\x1b[35m      Personas: ${PERSONAS.map((p) => p.displayName).join(' → ')}\x1b[0m`);
    console.log(`\x1b[35m      Turno atual: ${current.displayName} (índice ${state.index})\x1b[0m`);
    console.log(`\x1b[35m      Horários: ${slots}\x1b[0m`);
    console.log('\x1b[35m' + '═'.repeat(58) + '\x1b[0m\n');
}

// ─── Inicialização ────────────────────────────────────────────────────────────

async function main() {
    // Inicializa binários (FFmpeg/yt-dlp) — necessário para re-captação de emergência
    initBinaries();
    ensureDirs();
    printBanner();

    // ── Modo --dry-run: simula sem postar ──────────────────────────────────────
    if (process.argv.includes('--dry-run')) {
        logger.cron('🧪 Modo DRY-RUN: simulando post sem publicar...\n');

        const found = getNextPersonaWithFallback(PERSONAS);
        if (!found?.persona) {
            logger.error('[Dry-Run] Nenhum clipe .mp4 encontrado em nenhuma pasta de output/. Rode: npm run capture');
            process.exit(0);
        }

        const { persona: dryPersona, skipped } = found;
        if (skipped.length > 0) {
            logger.warn(`[Dry-Run] Personas puladas (pastas vazias): [${skipped.join(', ')}]`);
        }

        const dryVideo = getNextVideoFromPersona(getPersonaOutputDir(dryPersona), { dryRun: true });
        if (!dryVideo) {
            logger.error('[Dry-Run] Pasta da persona existe mas nenhum vídeo disponível.');
            process.exit(0);
        }

        const state = getQueueState();

        const { filePath, title: rawTitle } = dryVideo;
        const fileSizeMB = (() => {
            try { return (fs.statSync(filePath).size / 1024 / 1024).toFixed(1); }
            catch { return '??'; }
        })();

        logger.step('[Dry-Run] Gerando metadados via IA...');
        let metadata;
        try {
            metadata = await generateMetadata(filePath);
        } catch (err) {
            logger.warn(`[Dry-Run] IA falhou (${err.message}) — usando fallback.`);
            metadata = generateFallbackMetadata(rawTitle);
        }

        const finalTitle = formatTitle(metadata);
        const ytDescription = formatYouTubeDescription(metadata);
        const caption = formatTikTokCaption(metadata);
        const nextPersona = PERSONAS[(state.index + 1) % PERSONAS.length]?.displayName ?? '—';

        const line = '═'.repeat(60);
        console.log(`\n\x1b[35m${line}\x1b[0m`);
        console.log('\x1b[35m\x1b[1m  🧪  DRY-RUN — Simulação de Post\x1b[0m');
        console.log(`\x1b[35m${line}\x1b[0m\n`);

        console.log(`  \x1b[33mPersona\x1b[0m      : ${dryPersona.displayName}`);
        console.log(`  \x1b[33mArquivo\x1b[0m      : ${path.basename(filePath)} (${fileSizeMB} MB)`);
        console.log(`  \x1b[33mPath\x1b[0m         : ${filePath}`);
        console.log(`\n  \x1b[33mTítulo YT\x1b[0m      : ${finalTitle}`);
        console.log(`\n  \x1b[33mDescrição YT\x1b[0m   :\n  ${ytDescription.replace(/\n/g, '\n  ')}`);
        console.log(`\n  \x1b[33mCaption TikTok\x1b[0m :\n  ${caption.slice(0, 300).replace(/\n/g, '\n  ')}${caption.length > 300 ? '\n  ...' : ''}`);
        console.log(`\n  \x1b[33mPróxima persona\x1b[0m: ${nextPersona}`);
        console.log(`  \x1b[33mUpload YouTube\x1b[0m : ${UPLOAD_YOUTUBE ? '✅ habilitado' : '❌ desabilitado'}`);
        console.log(`  \x1b[33mUpload TikTok\x1b[0m  : ${UPLOAD_TIKTOK ? '✅ habilitado' : '❌ desabilitado'}`);

        console.log(`\n\x1b[2m  ⚠️  Nada foi postado. Arquivo permanece em ./output/.\x1b[0m`);
        console.log(`\x1b[2m  Para postar de verdade: npm run poster:now\x1b[0m`);
        console.log(`\n\x1b[35m${line}\x1b[0m\n`);

        // Avança a fila igual ao modo real para que a rotação de persona seja consistente.
        // O vídeo NÃO é marcado como postado — permanece disponível para o próximo upload real.
        advanceQueue(dryPersona.name);
        logger.info(`[Dry-Run] Fila avançada — próxima persona: ${nextPersona}`);

        process.exit(0);
    }

    // Modo --now: dispara um upload imediatamente e encerra
    if (process.argv.includes('--now')) {
        logger.cron('⚡ Modo --now: disparando upload imediato...');
        await runUploadCycle();
        process.exit(0);
    }


    // Registra todos os slots de cron
    let registered = 0;
    for (const expr of ACTIVE_SLOTS) {
        if (!cron.validate(expr)) {
            logger.error(`Expressão cron inválida: "${expr}" — pulando.`);
            continue;
        }
        cron.schedule(expr, () => {
            logger.cron(`⏰ Horário atingido (${expr}) — disparando upload...`);
            runUploadCycle();
        }, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });
        logger.success(`Agendamento registrado: ${expr}`);
        registered++;
    }

    if (registered === 0) {
        logger.error('Nenhum agendamento válido configurado. Encerrando.');
        process.exit(1);
    }

    logger.info(`Auto-poster aguardando os ${registered} horários agendados. Ctrl+C para encerrar.\n`);
}

main().catch((err) => {
    logger.error(`Erro fatal: ${err.message}`);
    process.exit(1);
});
