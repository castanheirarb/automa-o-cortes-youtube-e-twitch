// src/capturer/youtube-monitor.js
// Monitor de background para canais YouTube das personas.
// Faz polling periódico via yt-dlp, detecta vídeos novos e dispara
// processamento automático — espelhando a arquitetura do live-monitor.js.
//
// Uso via orchestrator: node src/orchestrator.js --youtube-monitor
// Uso direto:           node src/capturer/youtube-monitor.js

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import { PERSONAS } from './personas.js';
import { getYoutubePeaks } from '../platforms/youtube.js';
import { processClip, initBinaries } from '../processor/ffmpeg.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

// ─── Configuração ─────────────────────────────────────────────────────────────

const POLL_MS      = parseInt(process.env.YT_MONITOR_INTERVAL    || '600', 10) * 1000;
const MIN_DURATION = parseInt(process.env.YT_MONITOR_MIN_DURATION || '300', 10);
const CACHE_MAX    = 500;
const CACHE_PATH   = path.resolve('./tmp/yt-monitor-history.json');

// Rastreia personas em processamento — impede encavalamento (mesma lógica do Live Monitor)
const activeCaptures = new Set();

// ─── Cache FIFO ───────────────────────────────────────────────────────────────

/**
 * Carrega o cache de IDs já processados do disco.
 * Retorna array vazio se o arquivo não existir ou estiver corrompido.
 */
function loadCache() {
    try {
        if (fs.existsSync(CACHE_PATH)) {
            const data = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
            if (Array.isArray(data)) return data;
        }
    } catch { /* arquivo corrompido ou inexistente — começa do zero */ }
    return [];
}

/** Persiste o cache no disco. Cria o diretório tmp/ se necessário. */
function saveCache(ids) {
    const dir = path.dirname(CACHE_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(CACHE_PATH, JSON.stringify(ids, null, 2), 'utf8');
}

/**
 * Adiciona um ID ao cache mantendo unicidade e o limite FIFO de 500 entradas.
 * Entradas antigas (índice 0) são descartadas primeiro quando o limite é atingido.
 *
 * @param {string[]} ids   - cache atual (imutável)
 * @param {string}   newId - ID a adicionar
 * @returns {string[]}     - novo array (não muta o original)
 */
function pushToCache(ids, newId) {
    if (ids.includes(newId)) return ids;
    const next = [...ids, newId];
    return next.length > CACHE_MAX ? next.slice(next.length - CACHE_MAX) : next;
}

// ─── Descoberta via yt-dlp ────────────────────────────────────────────────────

/**
 * Busca os N vídeos mais recentes de um canal usando yt-dlp --flat-playlist.
 * Não baixa nenhum vídeo — apenas metadados (rápido).
 *
 * @param {string} channelUrl - URL do canal (ex: https://www.youtube.com/@renatocariani/videos)
 * @param {number} count      - Quantos vídeos buscar (padrão: 3)
 * @returns {Promise<Array<{ id, title, duration, viewCount, url }>>}
 */
async function fetchRecentVideos(channelUrl, count = 3) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';

    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json',
        '--flat-playlist',
        '--playlist-end', String(count),
        '--skip-download',
        '--no-warnings',
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    // yt-dlp com --flat-playlist retorna uma linha JSON por vídeo
    return stdout.trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } })
        .filter(Boolean)
        .map((entry) => ({
            id:        entry.id,
            title:     entry.title || entry.id,
            duration:  entry.duration ?? 0,   // null/undefined → 0 (ao vivo ou não resolvido)
            viewCount: entry.view_count ?? 0,
            url:       entry.url?.startsWith('http')
                ? entry.url
                : `https://www.youtube.com/watch?v=${entry.id}`,
        }));
}

// ─── Pipeline de Captação ─────────────────────────────────────────────────────

/**
 * Processa um vídeo elegível: busca picos de audiência e gera clipes.
 * Chamada em background pelo checkPersona — não bloqueia o loop de polling.
 *
 * @param {object} persona - persona do personas.js
 * @param {{ id, title, duration, url }} video
 */
async function captureVideo(persona, video) {
    const personaOutputDir = path.resolve(process.env.OUTPUT_DIR || './output', persona.name);
    fs.mkdirSync(personaOutputDir, { recursive: true });

    logger.info(`\n${'═'.repeat(52)}`);
    logger.info(`  📺 NOVO VIDEO: ${persona.displayName}`);
    logger.info(`  🎬 "${video.title}" (${video.duration}s)`);
    logger.info(`  🔗 ${video.url}`);
    logger.info(`${'═'.repeat(52)}\n`);

    try {
        const peaks = await getYoutubePeaks(video.url, persona.clipsPerRun ?? 5);

        if (peaks.length === 0) {
            logger.warn(`[YT-Monitor] "${video.title}": nenhum pico encontrado (sem heatmap disponivel).`);
            return;
        }

        logger.success(`[YT-Monitor] ${peaks.length} pico(s) identificado(s) em "${video.title}".`);

        let generated = 0;
        for (let i = 0; i < peaks.length; i++) {
            try {
                await processClip(
                    { ...peaks[i], videoUrl: video.url, outputBaseDir: personaOutputDir, layout: persona.layout ?? null, niche: persona.niche ?? 'default' },
                    i + 1,
                    peaks.length,
                );
                generated++;
            } catch (err) {
                logger.error(`[YT-Monitor] Clipe ${i + 1}/${peaks.length} falhou: ${err.message}`);
            }
        }

        logger.success(
            `[YT-Monitor] "${persona.displayName}": ${generated}/${peaks.length} clipe(s) gerado(s) -> ${personaOutputDir}`
        );
    } catch (err) {
        logger.error(`[YT-Monitor] Erro fatal ao capturar "${persona.displayName}": ${err.message}`);
    }
}

// ─── Checagem por Persona ─────────────────────────────────────────────────────

/**
 * Verifica se a persona postou vídeos novos e elegíveis.
 * Retorna o cache atualizado (imutável — sempre retorna novo array).
 *
 * Filtros aplicados (em ordem):
 *   1. Já está no cache → ignora (nunca reprocessa)
 *   2. duration === 0   → vídeo ao vivo ou duração não resolvida → pula sem cachear
 *   3. duration < MIN_DURATION → Short ou vídeo curto → cacheia e ignora
 *   4. Elegível → cacheia, persiste, dispara captação em background
 *
 * Apenas 1 vídeo novo por persona por ciclo para não sobrecarregar o pipeline.
 *
 * @param {object}   persona
 * @param {string[]} cache
 * @returns {Promise<string[]>} cache atualizado
 */
async function checkPersona(persona, cache) {
    if (activeCaptures.has(persona.name)) {
        logger.info(`[YT-Monitor] ${persona.displayName}: captacao em andamento — pulando.`);
        return cache;
    }

    let videos;
    try {
        videos = await fetchRecentVideos(persona.channelUrl, 3);
    } catch (err) {
        logger.warn(`[YT-Monitor] ${persona.displayName}: falha ao buscar videos — ${err.message}`);
        return cache;
    }

    let updatedCache = cache;
    let dispatched = 0;

    for (const video of videos) {
        // Filtro 1: já processado
        if (updatedCache.includes(video.id)) continue;

        // Filtro 2: duração desconhecida (live em andamento, vídeo pendente de processamento pelo YT)
        if (video.duration === 0) {
            logger.info(`[YT-Monitor] "${video.title}": duracao desconhecida — aguardando proximo ciclo.`);
            continue;
        }

        // Filtro 3: curto demais (Shorts, previews, vinhetas)
        if (video.duration < MIN_DURATION) {
            logger.info(
                `[YT-Monitor] "${video.title}" ignorado — ${video.duration}s < ${MIN_DURATION}s minimo.`
            );
            // Adiciona ao cache para não reprocessar mesmo que MIN_DURATION mude depois
            updatedCache = pushToCache(updatedCache, video.id);
            continue;
        }

        // Filtro 4: elegível — cacheia imediatamente antes de disparar (evita duplicata em crash)
        updatedCache = pushToCache(updatedCache, video.id);
        saveCache(updatedCache);

        dispatched++;
        logger.info(
            `[YT-Monitor] Novo video elegivel: "${video.title}" (${video.duration}s) — iniciando captacao...`
        );

        // Dispara em background: monitor continua fazendo polling enquanto clipes são gerados
        activeCaptures.add(persona.name);
        captureVideo(persona, video)
            .catch((err) => logger.error(`[YT-Monitor] captureVideo rejeitou: ${err.message}`))
            .finally(() => activeCaptures.delete(persona.name));

        // 1 vídeo novo por persona por ciclo evita sobrecarga no pipeline de FFmpeg
        break;
    }

    if (dispatched === 0 && videos.length > 0) {
        logger.info(`[YT-Monitor] ${persona.displayName}: sem novidades.`);
    }

    return updatedCache;
}

// ─── Loop Principal ───────────────────────────────────────────────────────────

/**
 * Inicia o monitor YouTube em loop infinito.
 * Mesma assinatura que startLiveMonitor para compatibilidade com o orchestrator.
 *
 * @param {string[]} [filterNames] - Filtra personas por nome (ex: ['cariani'])
 *                                   Array vazio = monitora todas as personas YouTube
 */
export async function startYouTubeMonitor(filterNames = []) {
    initBinaries();

    const ytPersonas = PERSONAS.filter((p) => p.platform === 'youtube');
    const targets = filterNames.length > 0
        ? ytPersonas.filter((p) => filterNames.includes(p.name))
        : ytPersonas;

    if (targets.length === 0) {
        logger.error('[YT-Monitor] Nenhuma persona YouTube encontrada em personas.js. Encerrando.');
        return;
    }

    const names = targets.map((p) => p.displayName).join(', ');
    logger.info(`\n📺 YouTube Monitor iniciado — monitorando: ${names}`);
    logger.info(`   Polling a cada ${POLL_MS / 1000}s | Duracao minima: ${MIN_DURATION}s`);
    logger.info(`   Cache: ${CACHE_PATH}\n`);

    let cache = loadCache();
    logger.info(`[YT-Monitor] ${cache.length} ID(s) no historico. Iniciando primeira checagem...\n`);

    // eslint-disable-next-line no-constant-condition
    while (true) {
        for (const persona of targets) {
            try {
                cache = await checkPersona(persona, cache);
            } catch (err) {
                // Erro isolado por persona — não derruba o loop inteiro
                logger.warn(`[YT-Monitor] Erro inesperado em "${persona.displayName}": ${err.message}`);
            }
        }

        logger.info(`[YT-Monitor] Proxima checagem em ${POLL_MS / 1000}s...`);
        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}
