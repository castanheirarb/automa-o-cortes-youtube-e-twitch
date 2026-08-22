// poster/index.js
// Ponto de entrada do auto-poster com Round-Robin de Personas.
//
// Uso normal (produção):     node poster/index.js
// Postar agora imediatamente: node poster/index.js --now
//   → percorre TODO o fluxo: conta principal, canais dedicados (religioso e
//     infantil) e o vídeo longo do dia, se ainda estiver pendente.
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
    getNextPersonaWithFallback, advanceQueue as advanceQueueState,
    getPersonaOutputDir, getQueueState,
    getCurrentPersona, hasVideosAvailable, buildRotation, canPersonaPostAgain,
    FOOTBALL_TURN_NAME, isFootballTurnPending
} from '../src/scheduler/round-robin.js';
import { addNotificationPopup, resolveChannelBranding } from '../src/processor/notification-overlay.js';

// --persona <name>: força o turno de uma persona específica (ex.: teste de um
// canal dedicado), sem avançar o índice do round-robin.
const PERSONA_FLAG_IDX = process.argv.indexOf('--persona');
const FORCED_PERSONA_NAME = PERSONA_FLAG_IDX !== -1 ? process.argv[PERSONA_FLAG_IDX + 1] : null;
const advanceQueue = (name) => { if (!FORCED_PERSONA_NAME) advanceQueueState(name); };
import { capturePersona } from '../src/capturer/capturer.js';
import { pickHotPersona } from '../src/scheduler/hotness.js';
import { TREND_PERSONA, captureTrendClip } from '../src/trend-hunter/trend-capture.js';
import { CANALDAFE_PERSONA, generateCanalDaFeVideo } from '../src/canal-da-fe/generate.js';
import { CANALINFANTIL_PERSONA, generateCanalInfantilVideo } from '../src/canal-infantil/generate.js';
import { initBinaries, probeVideoDuration } from '../src/processor/ffmpeg.js';

import {
    getNextVideoFromPersona, markAsPosted,
    registerAsPosted, ensureDirs,
    isTikTokPosted, registerTikTokPosted,
    isYouTubePosted, registerYouTubePosted,
    isContentPosted, registerContentPosted,
} from './queue.js';
import { uploadToYouTube } from './uploaders/youtube.js';
import { uploadToTikTok } from './uploaders/tiktok.js';
import {
    generateMetadata, generateFallbackMetadata,
    formatTitle, formatYouTubeDescription, formatTikTokCaption
} from './metadata.js';
import { recordMetadataHistory, validateTikTokCaption, validateAndLog, sanitizeMetadata } from './metadata-validator.js';
import { postExpressClip } from './express-poster.js';
import { checkContentSafety } from './content-filter.js';
import { getPersonaBranding } from './branding.js';
import { logger } from './logger.js';
import { acquireUploadLock } from './upload-lock.js';
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

// Rotação do poster: suas personas + Trend Hunter (cortes em alta dos concorrentes).
// Desative com TREND_IN_ROTATION=false. O peso de cada um controla a intercalação:
// com 7 turnos das suas personas e TREND_WEIGHT=1, 1 a cada 8 posts é corte em alta.
const TREND_ENABLED = process.env.TREND_IN_ROTATION !== 'false';

// ── Canal religioso: rodízio paralelo ─────────────────────────────────────────
// O canal dedicado (chrome-youtube-02) posta em TODOS os slots do cron — mesma
// frequência da conta principal — alternando vídeo gerado (Canal da Fé) ↔ corte
// do Bispo Bruno Leonardo. As personas religiosas ficam FORA do rodízio da
// conta principal; o estado de alternância vive em scheduler/religioso-state.json.
// Desative os vídeos gerados com CANALDAFE_IN_ROTATION=false.
const CANALDAFE_ENABLED = process.env.CANALDAFE_IN_ROTATION !== 'false';
const CANALINFANTIL_ENABLED = process.env.CANALINFANTIL_IN_ROTATION !== 'false';
const LUCASNETO_ENABLED = process.env.LUCASNETO_IN_ROTATION !== 'false';
const DEDICATED_NAMES = new Set(['bispobrunoleonardo', 'lucasneto', CANALDAFE_PERSONA.name, CANALINFANTIL_PERSONA.name]);
const MAIN_PERSONAS = PERSONAS.filter((p) => !DEDICATED_NAMES.has(p.name));
const BISPO_PERSONA = PERSONAS.find((p) => p.name === 'bispobrunoleonardo');
const LUCASNETO_PERSONA = PERSONAS.find((p) => p.name === 'lucasneto');
// Rodízio ponderado do canal religioso: os CORTES DO BISPO são a fonte
// principal (peso 2) e os vídeos gerados entram intercalados (peso 1), no
// padrão bispo → gerado → bispo. buildRotation espaça os turnos, então nunca
// saem dois vídeos gerados seguidos.
const BISPO_WEIGHT = parseInt(process.env.BISPO_WEIGHT || '2', 10);
const CANALDAFE_TURNOS = parseInt(process.env.CANALDAFE_WEIGHT || '1', 10);
const RELIGIOUS_SOURCES = [
    ...(BISPO_PERSONA ? [{ ...BISPO_PERSONA, weight: BISPO_WEIGHT }] : []),
    ...(CANALDAFE_ENABLED ? [{ ...CANALDAFE_PERSONA, weight: CANALDAFE_TURNOS }] : []),
];
// Com uma única fonte ativa (ex.: Canal da Fé desligado), o peso não faz
// sentido — colapsa para um turno só, senão o rodízio vira "Bispo ⇄ Bispo".
const RELIGIOUS_ROTATION = RELIGIOUS_SOURCES.length === 1
    ? [RELIGIOUS_SOURCES[0]]
    : buildRotation(RELIGIOUS_SOURCES);
// Rodízio ponderado do canal infantil: mesma lógica do religioso — cortes
// reais do Luccas Neto como fonte principal (peso 2), intercalados com o
// vídeo gerado por IA (peso 1), no padrão Luccas → gerado → Luccas.
const LUCASNETO_WEIGHT = parseInt(process.env.LUCASNETO_WEIGHT || '2', 10);
const CANALINFANTIL_TURNOS = parseInt(process.env.CANALINFANTIL_WEIGHT_ROTACAO || '1', 10);
const INFANTIL_SOURCES = [
    ...(LUCASNETO_ENABLED && LUCASNETO_PERSONA ? [{ ...LUCASNETO_PERSONA, weight: LUCASNETO_WEIGHT }] : []),
    ...(CANALINFANTIL_ENABLED ? [{ ...CANALINFANTIL_PERSONA, weight: CANALINFANTIL_TURNOS }] : []),
];
const INFANTIL_ROTATION = INFANTIL_SOURCES.length === 1
    ? [INFANTIL_SOURCES[0]]
    : buildRotation(INFANTIL_SOURCES);

// Canais dedicados: cada um posta em TODOS os slots do cron, logo após a conta
// principal, com fila própria. Adicionar um canal novo = mais uma entrada aqui.
const DEDICATED_CHANNELS = [
    { id: 'religioso', label: 'Canal religioso', stateFile: './scheduler/religioso-state.json', rotation: RELIGIOUS_ROTATION },
    { id: 'infantil',  label: 'Canal infantil',  stateFile: './scheduler/infantil-state.json',  rotation: INFANTIL_ROTATION },
].filter((c) => c.rotation.length > 0);

// Trend Hunter deve ser o mais postado: metade dos turnos (4 posts/dia → 2 dele).
// Peso = soma dos pesos das demais personas, salvo TREND_WEIGHT explícito no .env.
const PERSONAS_WEIGHT_SUM = MAIN_PERSONAS.reduce((sum, p) => sum + (p.weight ?? 1), 0);
const TREND_ROTATION_PERSONA = {
    ...TREND_PERSONA,
    weight: parseInt(process.env.TREND_WEIGHT || '0', 10) || PERSONAS_WEIGHT_SUM,
};
const ROTATION_PERSONAS = TREND_ENABLED ? [...MAIN_PERSONAS, TREND_ROTATION_PERSONA] : MAIN_PERSONAS;

// Hotness: persona com vídeo estourando no canal-fonte fura a fila do rodízio.
const HOTNESS_ENABLED = process.env.HOTNESS_MODE !== 'false';

// ─── Turno de futebol intercalado ─────────────────────────────────────────────
// A cada lote de 3 vídeos fechado por QUALQUER persona (Casimiro incluso), o
// round-robin marca um turno de futebol pendente (ver isFootballTurnPending em
// round-robin.js). Duas fontes, nessa ordem de preferência:
//   1. Casimiro/CazéTV (persona já configurada com fallback pro CazéTV)
//   2. Trend Hunter de futebol: cortes minerados de CazéTV/Desimpedidos/
//      Quebrada FC por src/capturer/sports-vod-miner.js, em output/sports-vod
const CASIMIRO_PERSONA = PERSONAS.find((p) => p.name === 'casimiro');
const SPORTS_VOD_PERSONA = { name: 'sports-vod', displayName: 'Futebol (Trend Hunter)', niche: 'react' };

function pickFootballSource() {
    if (CASIMIRO_PERSONA && hasVideosAvailable(CASIMIRO_PERSONA)) return CASIMIRO_PERSONA;
    if (hasVideosAvailable(SPORTS_VOD_PERSONA)) return SPORTS_VOD_PERSONA;
    return null;
}

// ─── Vídeo Longo Diário ───────────────────────────────────────────────────────
// 1 vídeo longo por dia, publicado via express-poster (que já gera metadados
// sem #shorts para vídeos longos). Coloque os .mp4 em ./output/longos.
// Horário configurável via CRON_VIDEO_LONGO (padrão: 20h). Desative com
// LONG_VIDEO_ENABLED=false.
const LONG_VIDEO_ENABLED = process.env.LONG_VIDEO_ENABLED !== 'false';
const LONG_VIDEOS_DIR = path.resolve(process.env.LONG_VIDEOS_DIR || './output/longos');
const LONG_VIDEO_CRON = process.env.CRON_VIDEO_LONGO || '0 20 * * *';
const LONG_STATE_PATH = path.resolve('./postados/long-video-state.json');
const TIMEZONE = process.env.TIMEZONE || 'America/Sao_Paulo';

// Vídeo longo diário do CANAL DA FÉ: mesma mecânica, mas a fonte é sempre uma
// prédica/live INTEIRA do canal oficial do Bispo Bruno Leonardo (nunca
// concorrentes) e a publicação vai para o perfil dedicado do canal religioso
// (ver src/canal-da-fe/long-video.js). Desative com LONG_VIDEO_FE_ENABLED=false.
const LONG_VIDEO_FE_ENABLED = process.env.LONG_VIDEO_FE_ENABLED !== 'false' && !!BISPO_PERSONA;
const LONG_VIDEOS_FE_DIR = path.resolve(process.env.LONG_VIDEOS_FE_DIR || './output/longos-fe');
// 30min depois do vídeo longo principal — evita 2 navegadores disputando
// upload ao mesmo tempo (o upload-lock já serializa, isso só espalha a carga).
const LONG_VIDEO_FE_CRON = process.env.CRON_VIDEO_LONGO_FE || '30 20 * * *';
const LONG_STATE_FE_PATH = path.resolve('./postados/long-video-fe-state.json');

function todayKey() {
    // Data local no fuso configurado, formato YYYY-MM-DD
    return new Date().toLocaleDateString('en-CA', { timeZone: TIMEZONE });
}

function loadLongState(statePath) {
    try {
        if (fs.existsSync(statePath)) return JSON.parse(fs.readFileSync(statePath, 'utf-8'));
    } catch (err) {
        logger.warn(`[Longo] Falha ao ler ${path.basename(statePath)}: ${err.message}`);
    }
    return {};
}

function saveLongState(statePath, state) {
    try {
        fs.mkdirSync(path.dirname(statePath), { recursive: true });
        fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Longo] Falha ao salvar ${path.basename(statePath)}: ${err.message}`);
    }
}

function getNextLongVideo(dir) {
    if (!fs.existsSync(dir)) return null;
    const files = fs.readdirSync(dir)
        .filter((f) => f.toLowerCase().endsWith('.mp4'))
        .map((f) => path.join(dir, f))
        .sort((a, b) => fs.statSync(a).birthtimeMs - fs.statSync(b).birthtimeMs);
    return files[0] ?? null;
}

/**
 * Publica 1 vídeo longo por dia de uma pasta configurável.
 * Proteção anti-duplicata: a data é gravada em disco ANTES do upload começar,
 * então mesmo que o processo seja interrompido no meio, o mesmo dia não
 * dispara um segundo upload (mesmo padrão dos registries por plataforma).
 *
 * @param {object} cfg
 *   @param {string} cfg.label      Prefixo dos logs (ex.: 'Longo', 'Longo Fé')
 *   @param {string} cfg.dir        Pasta com .mp4 prontos para publicar
 *   @param {string} cfg.statePath  Arquivo de estado (data do último post)
 *   @param {() => Promise<string|null>} cfg.getFallbackVideo  Busca/gera um vídeo quando a pasta está vazia
 *   @param {object} [cfg.postOptions]  Repassado ao postExpressClip (perfil dedicado, etc.)
 */
async function runLongVideoCycle(cfg, { force = false } = {}) {
    const { label, dir, statePath, getFallbackVideo, postOptions = {} } = cfg;

    const state = loadLongState(statePath);
    if (!force && state.lastPostDate === todayKey()) {
        logger.warn(`[${label}] Vídeo longo de hoje já foi postado (${state.lastFile ?? '?'}) — pulando.`);
        return;
    }

    let filePath = getNextLongVideo(dir);

    if (!filePath) {
        logger.warn(`[${label}] Nenhum .mp4 em ${dir} — buscando fonte...`);
        try {
            filePath = await getFallbackVideo();
        } catch (err) {
            logger.error(`[${label}] Busca de vídeo longo falhou: ${err.message}`);
        }
        if (!filePath) {
            logger.error(`[${label}] ❌ Sem vídeo longo mesmo após busca — nada a postar hoje.`);
            return;
        }
    }

    logger.cron(`🎬 Vídeo longo do dia (${label}): ${path.basename(filePath)}`);

    // Grava o estado ANTES do upload: interrupção não causa re-postagem hoje.
    saveLongState(statePath, { lastPostDate: todayKey(), lastFile: path.basename(filePath), startedAt: new Date().toISOString() });

    try {
        // postExpressClip: detecta duração → metadados de vídeo longo (sem #shorts),
        // adquire o upload-lock (serializa com o cron dos Shorts) e arquiva o
        // arquivo em ./archive/posted após sucesso.
        const results = await postExpressClip(filePath, null, postOptions);
        logger.cron(`✅ Vídeo longo concluído (${label}) — YouTube: ${fmtResult(results.youtube)} | TikTok: ${fmtResult(results.tiktok)}`);
    } catch (err) {
        logger.error(`[${label}] Falha ao postar vídeo longo: ${err.message}`);
        logger.warn(`[${label}] O dia já foi marcado como usado. Para retentar hoje: apague a entrada em ${path.basename(statePath)}.`);
    }
}

/** Fonte do vídeo longo da conta principal: replica trending de concorrentes, com fallback pra compilação de heatmap. */
async function fetchMainLongVideo() {
    logger.warn(`[Longo] Replicando vídeo em alta dos concorrentes...`);
    let filePath = null;
    try {
        const { replicateTrendingLongVideo } = await import('../src/trend-hunter/long-replicate.js');
        filePath = await replicateTrendingLongVideo();
    } catch (err) {
        logger.error(`[Longo] Replicação de vídeo em alta falhou: ${err.message}`);
    }

    if (!filePath) {
        logger.warn('[Longo] Replicação sem resultado — disparando captação de emergência (compilação)...');
        try {
            const { captureLongVideo } = await import('../src/capturer/long-capture.js');
            filePath = await captureLongVideo();
        } catch (err) {
            logger.error(`[Longo] Captação de emergência falhou: ${err.message}`);
        }
    }
    return filePath;
}

/** Fonte do vídeo longo do Canal da Fé: sempre uma prédica/live inteira do próprio canal do Bispo. */
async function fetchFeLongVideo() {
    const { getBispoLongVideo } = await import('../src/canal-da-fe/long-video.js');
    return getBispoLongVideo();
}

const MAIN_LONG_CFG = {
    label: 'Longo',
    dir: LONG_VIDEOS_DIR,
    statePath: LONG_STATE_PATH,
    getFallbackVideo: fetchMainLongVideo,
};

const FE_LONG_CFG = {
    label: 'Longo Fé',
    dir: LONG_VIDEOS_FE_DIR,
    statePath: LONG_STATE_FE_PATH,
    getFallbackVideo: fetchFeLongVideo,
    postOptions: {
        ytProfileDir: BISPO_PERSONA?.youtubeProfileDir,
        ttProfileDir: BISPO_PERSONA?.tiktokProfileDir,
    },
};

// ─── Pipeline de Upload ───────────────────────────────────────────────────────

let isUploading = false; // Trava intra-processo para evitar uploads simultâneos

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
    const release = await acquireUploadLock('cron-roundrobin');
    const state = getQueueState();
    logger.cron(`🚀 Ciclo de upload — índice global: ${state.index} | último: ${state.lastPersona ?? 'nenhum'}`);

    try {
        // ── Nível -1: turno de futebol intercalado ────────────────────────────
        // Fica na frente de tudo (inclusive Hotness) — é uma regra estrutural
        // do rodízio ("depois de cada lote de 3, um futebol"), não uma escolha
        // ponderada. --persona força e pula essa checagem, como as demais.
        if (!FORCED_PERSONA_NAME && isFootballTurnPending()) {
            const footballSource = pickFootballSource();
            if (footballSource) {
                logger.step(`[Poster] ⚽ Turno de futebol intercalado — fonte: ${footballSource.displayName}`);
                const footballDir = getPersonaOutputDir(footballSource);
                const footballVideo = getNextVideoFromPersona(footballDir);
                if (footballVideo) {
                    await postVideoJob(footballSource, footballVideo, () => advanceQueueState(FOOTBALL_TURN_NAME));
                    return;
                }
                logger.warn('[Poster] ⚽ Vídeo de futebol sumiu entre o check e agora — seguindo sem futebol neste ciclo.');
            } else {
                logger.warn('[Poster] ⚽ Turno de futebol pendente, mas sem vídeos (Casimiro/CazéTV nem Trend Hunter de futebol) — liberando o rodízio normal.');
            }
            // Sem fonte disponível agora: limpa a pendência pra não travar o
            // rodízio esperando futebol pra sempre — tenta de novo no próximo
            // lote fechado.
            advanceQueueState(FOOTBALL_TURN_NAME);
        }

        // ── Nível 0: turno do Trend Hunter com pasta vazia → captura o corte
        //    em alta dos canais concorrentes antes de selecionar a persona ─────
        if (TREND_ENABLED && getCurrentPersona(ROTATION_PERSONAS).name === TREND_PERSONA.name
            && !hasVideosAvailable(TREND_PERSONA)) {
            logger.step('[Poster] 🔥 Turno do Trend Hunter — vasculhando cortes em alta dos concorrentes...');
            try {
                await captureTrendClip();
            } catch (trendErr) {
                logger.warn(`[Poster] Trend Hunter falhou (${trendErr.message}) — seguindo com fallback normal.`);
            }
        }

        // ── Nível 0.5: Hotness — persona com vídeo estourando fura a fila ─────
        // Desative com HOTNESS_MODE=false. Só sobrepõe o round-robin se alguma
        // persona estiver acima do threshold E tiver clipes prontos na pasta.
        let hotOverride = null;
        if (FORCED_PERSONA_NAME) {
            const forced = [...ROTATION_PERSONAS, ...DEDICATED_CHANNELS.flatMap((c) => c.rotation)]
                .find((p) => p.name === FORCED_PERSONA_NAME);
            if (!forced) {
                logger.error(`[Poster] --persona "${FORCED_PERSONA_NAME}" não encontrada nas personas ativas.`);
                return;
            }
            logger.step(`[Poster] 🎯 Persona forçada via --persona: ${forced.displayName}`);
            hotOverride = { persona: forced, entry: null };
        } else if (HOTNESS_ENABLED) {
            try {
                const candidates = ROTATION_PERSONAS.filter(
                    (p) => p.name !== TREND_PERSONA.name && p.name !== CANALDAFE_PERSONA.name
                );
                // canPersonaPostAgain trava o furo de fila depois de POSTS_PER_PERSONA
                // posts seguidos da mesma persona — senão o Hotness repetiria a
                // persona indefinidamente enquanto o score dela seguir alto.
                hotOverride = await pickHotPersona(
                    candidates,
                    (p) => hasVideosAvailable(p) && canPersonaPostAgain(p.name)
                );
                if (hotOverride) {
                    const { entry } = hotOverride;
                    logger.step(`[Poster] 🔥 Hotness: "${entry.displayName}" em alta (score ${entry.score} — "${entry.topTitle}") → furando a fila!`);
                } else {
                    logger.info('[Poster] Hotness: nenhuma persona elegível (lote de 3 seguidos atingido ou sem vídeos) — seguindo round-robin normal.');
                }
            } catch (hotErr) {
                logger.warn(`[Poster] Hotness falhou (${hotErr.message}) — seguindo round-robin normal.`);
            }
        }

        // ── Nível 1 + 2: Round-Robin com fallback automático ─────────────────
        let result = hotOverride
            ? { persona: hotOverride.persona, skipped: [] }
            : getNextPersonaWithFallback(ROTATION_PERSONAS);

        // ── Nível 3: Re-captação de emergência ────────────────────────────────
        if (!result) {
            logger.warn('[Poster] ⚠️  Todas as pastas vazias — disparando re-captação de emergência...');
            try {
                // Captura apenas a persona do turno atual (índice atual sem avançar)
                const { index } = getQueueState();
                const rotation = buildRotation(ROTATION_PERSONAS);
                const personaToCapture = rotation[index % rotation.length];
                if (personaToCapture.name === TREND_PERSONA.name) {
                    await captureTrendClip();
                } else if (personaToCapture.name === CANALDAFE_PERSONA.name) {
                    await generateCanalDaFeVideo();
                } else {
                    await capturePersona(personaToCapture, { force: false, minClips: 3 });
                }

                // Tenta novamente após a re-captação
                result = getNextPersonaWithFallback(ROTATION_PERSONAS);
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

            const retry = getNextPersonaWithFallback(ROTATION_PERSONAS);
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

        await postVideoJob(activePersona, video, advanceQueue);

    } catch (err) {
        logger.error(`[Poster] Erro inesperado no ciclo de upload: ${err.message}`);
        if (process.env.DEBUG) console.error(err);
    } finally {
        release();
        isUploading = false;
    }
}

// ─── Núcleo de postagem (compartilhado: ciclo principal e ciclo religioso) ────
// Recebe a persona ativa, o vídeo escolhido e a função de avanço da fila
// correspondente (round-robin principal ou alternância religiosa).
async function postVideoJob(activePersona, video, advance) {
    const { filePath } = video;
    const currentFile = filePath; // rastreado para deduplicação de segurança em caso de crash
    const results = { youtube: null, tiktok: null };

    // ── Interruptor mestre de teste ────────────────────────────────────────────
    // UPLOAD_TO_YOUTUBE/UPLOAD_TO_TIKTOK não bastam sozinhos: contas dedicadas
    // (ex.: TikTok do canal religioso) ignoram esses toggles de propósito, pra
    // continuar postando mesmo com o TikTok da conta principal desligado. Pra
    // um teste/visualização que NUNCA deve subir nada em lugar nenhum, use
    // POSTER_DRY_RUN=true — interrompe aqui, sem exceção, antes de qualquer
    // chamada de rede.
    if (process.env.POSTER_DRY_RUN === 'true') {
        logger.warn(`[Poster] 🧪 POSTER_DRY_RUN=true — não vou subir "${path.basename(filePath)}" em lugar nenhum.`);
        return;
    }

    // ── Guarda anti-duplicata por CONTEÚDO ────────────────────────────────────
    // Os registries são por CAMINHO, então não pegam clipes byte-a-byte iguais
    // gerados com nomes diferentes — foi o que fez o mesmo vídeo ser publicado
    // 3× (picos próximos num vídeo-fonte curto viram o mesmo recorte após o
    // clamp de duração). Aqui a comparação é do conteúdo real do arquivo.
    // Guarda de duração: rede de segurança final. Clipes truncados por falhas
    // antigas continuam na fila e chegariam ao canal (um Short de 1,5s foi
    // publicado assim). Aqui o arquivo é medido logo antes de subir.
    const MIN_POST_SEC = parseInt(process.env.CLIP_DURATION_MIN || '11', 10);
    const duracaoReal = await probeVideoDuration(filePath).catch(() => null);
    if (duracaoReal !== null && duracaoReal < MIN_POST_SEC) {
        logger.error(`[Poster] ❌ Vídeo curto demais (${duracaoReal.toFixed(1)}s < ${MIN_POST_SEC}s) — descartado sem postar: ${path.basename(filePath)}`);
        try { fs.unlinkSync(filePath); } catch { /* ignora */ }
        advance(activePersona.name);
        return;
    }

    if (isContentPosted(filePath)) {
        logger.error(`[Poster] ❌ Conteúdo idêntico já publicado — pulando: ${path.basename(filePath)}`);
        markAsPosted(filePath); // tira da fila para não reincidir todo ciclo
        advance(activePersona.name);
        return;
    }

    // ── Popup "inscreva-se e curta" (início + fim) ────────────────────────────
    // Aplicado AQUI (não na captura) pra cobrir todo vídeo antes de subir,
    // independente da origem — cortes por persona (processClip) e os vídeos
    // GERADOS (Canal da Fé, Canal Infantil), que têm pipeline próprio e nunca
    // passam pelo processClip. Reescreve filePath no lugar (mesmo caminho,
    // conteúdo novo) via rename atômico — nunca deixa um ".mp4" temporário
    // visível pro scanner do poster achar um arquivo pela metade.
    if (process.env.NOTIFICATION_POPUP !== 'false') {
        const notifTempPath = `${filePath}.notif-tmp`;
        try {
            const branding = resolveChannelBranding(path.dirname(filePath));
            await addNotificationPopup(filePath, notifTempPath, branding);
            fs.renameSync(notifTempPath, filePath);
            logger.success(`[NotificationOverlay] Popups inseridos (${branding.appName}).`);
        } catch (err) {
            logger.warn(`[NotificationOverlay] Falha ao inserir popup (${err.message}) — postando sem popup.`);
            try { if (fs.existsSync(notifTempPath)) fs.unlinkSync(notifTempPath); } catch { /* ignora */ }
        }
    }

    try {
        // ── Gera metadados virais via IA ──────────────────────────────────────
        // Vídeos gerados (Canal da Fé) trazem sidecar .meta.json com metadados
        // prontos do roteirista — sem transcrição/otimização de cortes.
        const sidecarPath = filePath.replace(/\.mp4$/i, '.meta.json');
        const hasSidecar = fs.existsSync(sidecarPath);
        let metadata;
        try {
            if (hasSidecar) {
                metadata = JSON.parse(fs.readFileSync(sidecarPath, 'utf-8'));
                logger.info(`[Poster] Metadados próprios (.meta.json): "${metadata.titulo}"`);
            } else {
                metadata = await generateMetadata(filePath);
                if (process.env.OPTIMIZE_CONTENT === 'true') {
                    metadata = await optimizeContent(metadata);
                }
            }
        } catch (err) {
            logger.warn(`[Metadata] IA falhou (${err.message}) — pulando vídeo para evitar título genérico.`);
            logger.info('[Poster] Vídeo deixado em ./output/ para nova tentativa no próximo ciclo.');
            advance(activePersona.name);
            return;
        }

        // ── Validação obrigatória antes de qualquer upload ────────────────────
        // Roda após generateMetadata + optimizeContent para garantir que o
        // conteúdo final (já reescrito) seja seguro e de qualidade.
        const validated = validateAndLog(metadata, { isGenerated: hasSidecar });
        metadata = { titulo: validated.titulo, descricao: validated.descricao, hashtags: validated.hashtags, transcript: metadata.transcript };

        const MIN_SCORE = parseInt(process.env.MIN_VALIDATION_SCORE || '40', 10);
        if (validated._validation.score < MIN_SCORE) {
            logger.warn(`[Poster] Score de validação baixo (${validated._validation.score}/${MIN_SCORE}) — pulando vídeo para evitar título de baixa qualidade.`);
            advance(activePersona.name);
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
        if (process.env.CREATE_THUMBNAIL === 'true' && !hasSidecar) {
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
            if (isYouTubePosted(filePath)) {
                logger.warn('[Poster] ⚠️  Arquivo já enviado ao YouTube (youtube-registry) — pulando para evitar duplicata.');
                results.youtube = null;
            } else {
                logger.step('📺 Upload → YouTube...');
                // Registra ANTES de tentar: se o processo for interrompido durante o
                // upload, o arquivo não será reenviado ao YouTube no próximo ciclo.
                registerYouTubePosted(filePath);
                // Persona com canal próprio (ex.: religioso) usa o perfil dela;
                // as demais usam o perfil padrão da conta principal.
                const ytProfileDir = activePersona.youtubeProfileDir
                    ? path.resolve(activePersona.youtubeProfileDir)
                    : undefined;
                if (ytProfileDir) logger.info(`[Poster] Canal dedicado: ${activePersona.displayName} → ${activePersona.youtubeProfileDir}`);
                results.youtube = await uploadToYouTube(filePath, finalTitle, ytDescription, HEADLESS, thumbnailPath, ytProfileDir, activePersona.madeForKids === true);
                // Impressão digital só entra no registro quando o envio confirmou:
                // registrar antes impediria a retentativa de um upload que falhou.
                if (results.youtube === true) registerContentPosted(filePath);
            }
        } else {
            logger.warn('Upload para YouTube desabilitado (UPLOAD_TO_YOUTUBE=false).');
        }

        // Personas com tiktokProfileDir têm conta própria de TikTok e ligam o
        // upload independente do interruptor global UPLOAD_TO_TIKTOK — que
        // continua controlando só a rotação principal (conta ainda não configurada).
        const tiktokEnabled = activePersona.tiktokProfileDir ? true : UPLOAD_TIKTOK;

        // Intervalo entre plataformas para estabilidade
        if (UPLOAD_YOUTUBE && tiktokEnabled) {
            await new Promise((r) => setTimeout(r, 10_000));
        }

        // ── TikTok ─────────────────────────────────────────────────────────────
        if (tiktokEnabled && activePersona.skipTikTok) {
            logger.info(`[Poster] TikTok pulado — persona "${activePersona.displayName}" posta só no YouTube.`);
        } else if (tiktokEnabled) {
            if (isTikTokPosted(filePath)) {
                logger.warn('[Poster] ⚠️  Arquivo já enviado ao TikTok (tiktok-registry) — pulando para evitar duplicata.');
                results.tiktok = null;
            } else {
                logger.step('🎵 Upload → TikTok...');
                // Registra ANTES de tentar: se o processo crashar durante o upload,
                // o arquivo não será reenviado ao TikTok no próximo ciclo.
                registerTikTokPosted(filePath);
                // Mesma lógica do YouTube: persona com conta de TikTok própria
                // (ex.: canal religioso) usa o perfil dela; as demais usam a conta
                // principal.
                const ttProfileDir = activePersona.tiktokProfileDir
                    ? path.resolve(activePersona.tiktokProfileDir)
                    : undefined;
                if (ttProfileDir) logger.info(`[Poster] Conta TikTok dedicada: ${activePersona.displayName} → ${activePersona.tiktokProfileDir}`);
                results.tiktok = await uploadToTikTok(filePath, tikTokCaption, HEADLESS, ttProfileDir);
                if (results.tiktok === true) registerContentPosted(filePath);
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
            // Sidecar .meta.json (vídeos gerados) não fica órfão em ./output
            if (hasSidecar) { try { fs.unlinkSync(sidecarPath); } catch { /* ok */ } }
            // Registra no histórico de unicidade — usa só o titulo (sem hashtags embutidas)
            // para que a detecção de duplicata compare títulos iguais corretamente
            recordMetadataHistory(metadata.titulo, metadata.hashtags || '', activePersona.niche || 'default');
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

        // Avança o índice da fila SEMPRE (success ou falha)
        // para não travar o ciclo no mesmo vídeo problemático indefinidamente.
        advance(activePersona.name);

        logger.cron(
            `✅ Ciclo concluído — ${activePersona.displayName} | ` +
            `YouTube: ${fmtResult(results.youtube)} | TikTok: ${fmtResult(results.tiktok)}`
        );

    } catch (err) {
        logger.error(`[Poster] Erro inesperado na postagem: ${err.message}`);
        if (process.env.DEBUG) console.error(err);
        // Se YouTube já tinha sido bem-sucedido quando o crash ocorreu (ex: TikTok finally),
        // move o arquivo para ./postados normalmente em vez de só registrar no registry.
        if (results.youtube === true) {
            markAsPosted(currentFile);
            logger.warn(`[Poster] YouTube ok antes do crash — arquivo movido para ./postados: ${path.basename(currentFile)}`);
        } else {
            registerAsPosted(currentFile);
            logger.warn(`[Poster] Arquivo registrado preventivamente no registry após erro: ${path.basename(currentFile)}`);
        }
    }
}

// ─── Ciclos dos canais dedicados: mesma frequência, fila própria ─────────────
// Cada canal dedicado (religioso, infantil, ...) roda logo após o ciclo
// principal em cada slot do cron, com estado próprio. Quando o canal tem mais
// de uma persona, elas se alternam; se a pasta do turno estiver vazia, usa a
// outra; se todas estiverem vazias, gera/captura na hora.

function loadChannelState(channel) {
    try { return JSON.parse(fs.readFileSync(path.resolve(channel.stateFile), 'utf-8')); }
    catch { return { index: 0, lastPost: null, lastPersona: null }; }
}

function advanceChannelQueue(channel, personaName) {
    const s = loadChannelState(channel);
    s.index += 1;
    s.lastPost = new Date().toISOString();
    s.lastPersona = personaName;
    try {
        fs.writeFileSync(path.resolve(channel.stateFile), JSON.stringify(s, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[${channel.label}] Falha ao salvar estado: ${err.message}`);
    }
    logger.info(`[${channel.label}] Fila avançada para ${s.index} (último post: ${personaName})`);
}

/** Repõe estoque da persona: vídeos gerados chamam seu pipeline, cortes captam. */
async function ensureChannelVideo(persona) {
    if (persona.name === CANALDAFE_PERSONA.name) {
        await generateCanalDaFeVideo();
    } else if (persona.name === CANALINFANTIL_PERSONA.name) {
        await generateCanalInfantilVideo();
    } else {
        await capturePersona(persona, { force: false, minClips: 1 });
    }
}

async function runChannelCycle(channel) {
    if (channel.rotation.length === 0) return;

    const release = await acquireUploadLock(channel.id);
    try {
        const { index } = loadChannelState(channel);
        const doTurno = channel.rotation[index % channel.rotation.length];
        let persona = doTurno;
        logger.cron(`📺 ${channel.label} — turno de: ${persona.displayName} (índice ${index})`);

        let video = getNextVideoFromPersona(getPersonaOutputDir(persona));

        // Fallback entre as personas do MESMO canal (nunca posta no canal errado)
        if (!video && channel.rotation.length > 1) {
            for (let i = 1; i < channel.rotation.length && !video; i++) {
                const other = channel.rotation[(index + i) % channel.rotation.length];
                const otherVideo = getNextVideoFromPersona(getPersonaOutputDir(other));
                if (otherVideo) {
                    logger.warn(`[${channel.label}] Pasta de "${persona.displayName}" vazia — postando de "${other.displayName}".`);
                    persona = other;
                    video = otherVideo;
                }
            }
        }

        if (!video) {
            logger.warn(`[${channel.label}] Sem estoque — gerando/capturando "${persona.displayName}" agora...`);
            try {
                await ensureChannelVideo(persona);
                video = getNextVideoFromPersona(getPersonaOutputDir(persona));
            } catch (err) {
                logger.error(`[${channel.label}] Geração/captação de emergência falhou: ${err.message}`);
            }
        }

        if (!video) {
            logger.error(`[${channel.label}] ❌ Nenhum vídeo disponível neste slot.`);
            return;
        }

        // Só avança a fila quando quem postou foi a persona DO TURNO. Sem isso,
        // um fallback (persona do turno sem estoque) consumia a vez dela e a
        // outra fonte acabava postando duas vezes seguidas — foi o que fez os
        // cortes do Bispo minguarem no canal religioso.
        await postVideoJob(persona, video, (name) => {
            if (persona.name === doTurno.name) {
                advanceChannelQueue(channel, name);
            } else {
                logger.warn(`[${channel.label}] Postou "${persona.displayName}" como reserva — turno de "${doTurno.displayName}" preservado para o próximo ciclo.`);
            }
        });

    } catch (err) {
        logger.error(`[${channel.label}] Erro inesperado no ciclo: ${err.message}`);
        if (process.env.DEBUG) console.error(err);
    } finally {
        release();
    }
}

/** Roda os ciclos de todos os canais dedicados, um após o outro. */
async function runDedicatedChannelCycles() {
    for (const channel of DEDICATED_CHANNELS) {
        await runChannelCycle(channel);
    }
}

function fmtResult(r) {
    if (r === null) return '⏭ pulado';
    return r ? '✅ ok' : '❌ falhou';
}

// ─── Banner ───────────────────────────────────────────────────────────────────

function printBanner() {
    const state = getQueueState();
    const rotation = buildRotation(ROTATION_PERSONAS);
    const current = rotation[state.index % rotation.length];
    const slots = ACTIVE_SLOTS.join(' | ');

    console.log('\n\x1b[35m' + '═'.repeat(58) + '\x1b[0m');
    console.log('\x1b[35m  📅  CANAL CORTE — Auto-Poster (Round-Robin)\x1b[0m');
    console.log(`\x1b[35m      Headless: ${HEADLESS ? 'ON' : 'OFF'}  |  YouTube: ${UPLOAD_YOUTUBE ? 'ON' : 'OFF'}  |  TikTok: ${UPLOAD_TIKTOK ? 'ON' : 'OFF'}\x1b[0m`);
    console.log(`\x1b[35m      Personas: ${ROTATION_PERSONAS.map((p) => p.displayName).join(' → ')}\x1b[0m`);
    console.log(`\x1b[35m      Turno atual: ${current.displayName} (índice ${state.index})\x1b[0m`);
    console.log(`\x1b[35m      Horários: ${slots}\x1b[0m`);
    for (const channel of DEDICATED_CHANNELS) {
        const st = loadChannelState(channel);
        const turno = channel.rotation[st.index % channel.rotation.length];
        console.log(`\x1b[35m      ${channel.label}: ${channel.rotation.map((p) => p.displayName).join(' ⇄ ')} — todos os horários (turno: ${turno.displayName})\x1b[0m`);
    }
    if (LONG_VIDEO_ENABLED) {
        console.log(`\x1b[35m      Vídeo longo: 1/dia (${LONG_VIDEO_CRON}) — pasta: output/longos\x1b[0m`);
    }
    if (LONG_VIDEO_FE_ENABLED) {
        console.log(`\x1b[35m      Vídeo longo (Canal da Fé): 1/dia (${LONG_VIDEO_FE_CRON}) — pasta: output/longos-fe — fonte: Bispo Bruno Leonardo\x1b[0m`);
    }
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

        // getNextPersonaWithFallback só checa se existem .mp4 na pasta (hasVideosAvailable),
        // não se já foram todos postados — então pode apontar pra uma persona cuja pasta
        // tem arquivos, mas todos já estão no registry. Por isso, ao contrário do ciclo
        // real (que tem esse mesmo retry — ver Nível 2 em runUploadCycle), esse loop
        // tenta a próxima persona em vez de desistir na primeira sem vídeo disponível.
        let dryPersona, dryVideo;
        for (let attempt = 0; attempt < ROTATION_PERSONAS.length; attempt++) {
            const found = getNextPersonaWithFallback(ROTATION_PERSONAS);
            if (!found?.persona) {
                logger.error('[Dry-Run] Nenhum clipe .mp4 encontrado em nenhuma pasta de output/. Rode: npm run capture');
                process.exit(0);
            }

            const { persona: candidate, skipped } = found;
            if (skipped.length > 0) {
                logger.warn(`[Dry-Run] Personas puladas (pastas vazias): [${skipped.join(', ')}]`);
            }

            const video = getNextVideoFromPersona(getPersonaOutputDir(candidate), { dryRun: true });
            if (video) {
                dryPersona = candidate;
                dryVideo = video;
                break;
            }

            logger.warn(`[Dry-Run] "${candidate.displayName}": arquivos existem mas todos já postados (registry) — tentando próxima persona...`);
            advanceQueue(candidate.name);
        }

        if (!dryVideo) {
            logger.error('[Dry-Run] Nenhuma persona tem vídeo disponível para simular (todas já postadas ou vazias).');
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
        const dryRotation = buildRotation(ROTATION_PERSONAS);
        const nextPersona = dryRotation[(state.index + 1) % dryRotation.length]?.displayName ?? '—';

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

        // process.exit(0) forçado logo após uma chamada de rede ao Gemini derrubava o
        // processo com "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" (bug do
        // libuv no Windows quando o handle da requisição ainda está fechando). Deixar o
        // processo encerrar sozinho dá tempo do handle fechar de forma limpa.
        process.exitCode = 0;
        return;
    }

    // Modo --long-now: posta o(s) vídeo(s) longo(s) do dia imediatamente e encerra.
    // Com --persona canaldafe (ou bispobrunoleonardo), roda só o vídeo longo do
    // Canal da Fé; sem --persona, roda o principal + o do Canal da Fé (se ativo).
    if (process.argv.includes('--long-now')) {
        logger.cron('⚡ Modo --long-now: postando vídeo longo imediatamente...');
        const force = process.argv.includes('--force');
        const feOnly = FORCED_PERSONA_NAME === CANALDAFE_PERSONA.name || FORCED_PERSONA_NAME === 'bispobrunoleonardo';
        if (!feOnly && LONG_VIDEO_ENABLED) await runLongVideoCycle(MAIN_LONG_CFG, { force });
        if (LONG_VIDEO_FE_ENABLED) await runLongVideoCycle(FE_LONG_CFG, { force });
        process.exit(0);
    }

    // Modo --now: dispara um upload imediatamente e encerra.
    // Com --persona, roda apenas o ciclo principal com a persona forçada;
    // sem, roda o ciclo principal + o ciclo religioso (como num slot do cron).
    if (process.argv.includes('--now')) {
        logger.cron('⚡ Modo --now: disparando upload imediato...');
        await runUploadCycle();
        if (!FORCED_PERSONA_NAME) {
            await runDedicatedChannelCycles();

            // Vídeo(s) longo(s) do dia: só entra se ainda não foi publicado hoje —
            // rodar o comando duas vezes não gera dois longos. Use --long-now
            // (com --force) para publicar outro no mesmo dia de propósito.
            if (LONG_VIDEO_ENABLED) {
                if (loadLongState(LONG_STATE_PATH).lastPostDate === todayKey()) {
                    logger.info('[Longo] Vídeo longo de hoje já publicado — pulando no --now.');
                } else {
                    logger.cron('🎬 Vídeo longo do dia ainda pendente — publicando...');
                    await runLongVideoCycle(MAIN_LONG_CFG);
                }
            }
            if (LONG_VIDEO_FE_ENABLED) {
                if (loadLongState(LONG_STATE_FE_PATH).lastPostDate === todayKey()) {
                    logger.info('[Longo Fé] Vídeo longo de hoje já publicado — pulando no --now.');
                } else {
                    logger.cron('🎬 Vídeo longo do dia (Canal da Fé) ainda pendente — publicando...');
                    await runLongVideoCycle(FE_LONG_CFG);
                }
            }
        }
        process.exit(0);
    }


    // Registra todos os slots de cron
    let registered = 0;
    for (const expr of ACTIVE_SLOTS) {
        if (!cron.validate(expr)) {
            logger.error(`Expressão cron inválida: "${expr}" — pulando.`);
            continue;
        }
        cron.schedule(expr, async () => {
            logger.cron(`⏰ Horário atingido (${expr}) — disparando upload...`);
            // Conta principal primeiro; canal religioso em seguida (mesmo slot,
            // serializado pelo upload-lock — nunca 2 navegadores ao mesmo tempo)
            await runUploadCycle();
            await runDedicatedChannelCycles();
        }, { timezone: process.env.TIMEZONE || 'America/Sao_Paulo' });
        logger.success(`Agendamento registrado: ${expr}`);
        registered++;
    }

    // Slot diário do vídeo longo (conta principal)
    if (LONG_VIDEO_ENABLED) {
        if (cron.validate(LONG_VIDEO_CRON)) {
            cron.schedule(LONG_VIDEO_CRON, () => {
                logger.cron(`⏰ Horário do vídeo longo (${LONG_VIDEO_CRON}) — disparando...`);
                runLongVideoCycle(MAIN_LONG_CFG);
            }, { timezone: TIMEZONE });
            logger.success(`Agendamento do vídeo longo registrado: ${LONG_VIDEO_CRON} (pasta: ${LONG_VIDEOS_DIR})`);
        } else {
            logger.error(`Expressão cron inválida em CRON_VIDEO_LONGO: "${LONG_VIDEO_CRON}" — vídeo longo diário desativado.`);
        }
    }

    // Slot diário do vídeo longo (Canal da Fé — Bispo Bruno Leonardo)
    if (LONG_VIDEO_FE_ENABLED) {
        if (cron.validate(LONG_VIDEO_FE_CRON)) {
            cron.schedule(LONG_VIDEO_FE_CRON, () => {
                logger.cron(`⏰ Horário do vídeo longo do Canal da Fé (${LONG_VIDEO_FE_CRON}) — disparando...`);
                runLongVideoCycle(FE_LONG_CFG);
            }, { timezone: TIMEZONE });
            logger.success(`Agendamento do vídeo longo (Canal da Fé) registrado: ${LONG_VIDEO_FE_CRON} (pasta: ${LONG_VIDEOS_FE_DIR})`);
        } else {
            logger.error(`Expressão cron inválida em CRON_VIDEO_LONGO_FE: "${LONG_VIDEO_FE_CRON}" — vídeo longo diário do Canal da Fé desativado.`);
        }
    }

    if (registered === 0) {
        logger.error('Nenhum agendamento válido configurado. Encerrando.');
        process.exit(1);
    }

    // ── Recuperação do vídeo longo perdido ────────────────────────────────────
    // O cron só dispara se o processo estiver vivo no horário. Cada reinício
    // depois das 20h fazia o vídeo longo do dia ser simplesmente perdido — foi
    // o que aconteceu entre 11 e 13/08. Aqui, ao subir, se o horário já passou
    // e ainda não houve post hoje, o ciclo roda imediatamente.
    function recoverMissedLongVideo(cfg, cronExpr) {
        const estado = loadLongState(cfg.statePath);
        if (estado.lastPostDate === todayKey()) return;
        const [minCron, horaCron] = cronExpr.split(' ');
        const agora = new Date(new Date().toLocaleString('en-US', { timeZone: TIMEZONE }));
        const alvo = parseInt(horaCron, 10) * 60 + parseInt(minCron, 10);
        const atual = agora.getHours() * 60 + agora.getMinutes();
        if (Number.isFinite(alvo) && atual >= alvo) {
            logger.cron(`⏰ Vídeo longo (${cfg.label}) de hoje ainda não foi postado e o horário (${cronExpr}) já passou — recuperando agora...`);
            runLongVideoCycle(cfg).catch((err) => logger.error(`[${cfg.label}] Recuperação falhou: ${err.message}`));
        }
    }

    if (LONG_VIDEO_ENABLED) recoverMissedLongVideo(MAIN_LONG_CFG, LONG_VIDEO_CRON);
    if (LONG_VIDEO_FE_ENABLED) recoverMissedLongVideo(FE_LONG_CFG, LONG_VIDEO_FE_CRON);

    logger.info(`Auto-poster aguardando os ${registered} horários agendados. Ctrl+C para encerrar.\n`);
}

main().catch((err) => {
    logger.error(`Erro fatal: ${err.message}`);
    process.exit(1);
});
