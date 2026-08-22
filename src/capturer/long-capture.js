// src/capturer/long-capture.js
// Captação de emergência de VÍDEO LONGO.
// Usado pelo poster quando output/longos está vazio no horário do post diário:
// varre as personas de YouTube, acha um vídeo com heatmap ("Most Replayed"),
// baixa janelas LARGAS em volta dos maiores picos via yt-dlp --download-sections
// e concatena tudo num único vídeo longo em output/longos (mantém 16:9 original —
// vídeo longo do YouTube não passa pelo processamento 9:16 dos Shorts).
//
// Variáveis de ambiente relevantes (.env):
//   LONG_CAPTURE_PEAKS       Quantos picos entram na compilação (padrão: 3)
//   LONG_CAPTURE_BEFORE_SEC  Segundos antes de cada pico (padrão: 90)
//   LONG_CAPTURE_AFTER_SEC   Segundos depois de cada pico (padrão: 60)
//   LONG_VIDEOS_DIR          Pasta de saída (padrão: ./output/longos)
//   YTDLP_PATH               Caminho do yt-dlp (padrão: "yt-dlp" no PATH)

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';

import { PERSONAS } from './personas.js';
import { buildRotation } from '../scheduler/round-robin.js';
import { fetchYouTubeVideoList } from './fetcher.js';
import { getYoutubePeaks } from '../platforms/youtube.js';
import { concatLocalClips } from '../processor/ffmpeg.js';
import { logger } from '../utils/logger.js';

const execFileAsync = promisify(execFile);

const YTDLP      = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
const OUTPUT_DIR = path.resolve(process.env.LONG_VIDEOS_DIR || './output/longos');
const PEAKS_N    = parseInt(process.env.LONG_CAPTURE_PEAKS      || '3',  10);
const BEFORE_SEC = parseInt(process.env.LONG_CAPTURE_BEFORE_SEC || '90', 10);
const AFTER_SEC  = parseInt(process.env.LONG_CAPTURE_AFTER_SEC  || '60', 10);

// ─── Registry de fontes já compiladas ────────────────────────────────────────
// Evita gerar duas vezes a mesma compilação a partir do mesmo vídeo-fonte
// (causa da postagem repetida do vídeo longo em 05 e 06/08/2026).

const SOURCE_REGISTRY = path.resolve('./scheduler/long-source-registry.json');

function loadSourceRegistry() {
    try { return JSON.parse(fs.readFileSync(SOURCE_REGISTRY, 'utf-8')); }
    catch { return {}; }
}

function isSourceUsed(videoUrl) {
    return Boolean(loadSourceRegistry()[videoUrl]);
}

function registerSourceUsed(videoUrl, title) {
    try {
        const reg = loadSourceRegistry();
        reg[videoUrl] = { title, usedAt: new Date().toISOString() };
        fs.mkdirSync(path.dirname(SOURCE_REGISTRY), { recursive: true });
        fs.writeFileSync(SOURCE_REGISTRY, JSON.stringify(reg, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[LongCapture] Falha ao registrar fonte usada: ${err.message}`);
    }
}

// ─── Rodízio ponderado do vídeo longo (campo longWeight em personas.js) ──────
// Ex.: cariani(5) → bistocone(4) → cortesdocasimito(3): 5 longos do Cariani,
// 4 do Bistecone e 3 do Casimito a cada ciclo de 12, intercalados.
// Personas sem canal YouTube (heatmap indisponível) são puladas com aviso.
// O índice persiste em scheduler/long-rotation-state.json e só avança quando
// um vídeo longo é gerado com sucesso.

const LONG_STATE_PATH = path.resolve('./scheduler/long-rotation-state.json');

function loadLongIndex() {
    try {
        return JSON.parse(fs.readFileSync(LONG_STATE_PATH, 'utf-8')).index ?? 0;
    } catch { return 0; }
}

function advanceLongIndex(personaName) {
    try {
        const index = loadLongIndex() + 1;
        fs.writeFileSync(LONG_STATE_PATH, JSON.stringify({ index, lastPersona: personaName, lastAt: new Date().toISOString() }, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[LongCapture] Falha ao salvar long-rotation-state.json: ${err.message}`);
    }
}

/** Personas na ordem do turno atual (turno primeiro, demais como fallback). */
function getLongRotationOrder() {
    const eligible = PERSONAS.filter((p) => (p.longWeight ?? 0) > 0);
    if (eligible.length === 0) {
        // Retrocompatível: sem longWeight configurado, usa as personas de YouTube.
        return PERSONAS.filter((p) => p.platform === 'youtube');
    }

    const rotation = buildRotation(eligible.map((p) => ({ ...p, weight: p.longWeight })));
    const index = loadLongIndex();

    // Gira a rotação para começar no turno atual e remove duplicatas mantendo a ordem
    const ordered = [];
    for (let i = 0; i < rotation.length; i++) {
        const p = rotation[(index + i) % rotation.length];
        if (ordered.some((o) => o.name === p.name)) continue;

        const hasYouTube = p.platform === 'youtube' || p.youtubeUrl;
        if (!hasYouTube) {
            logger.warn(`[LongCapture] "${p.displayName}" sem canal YouTube — sem heatmap para vídeo longo, pulando o turno.`);
            continue;
        }
        // Twitch com youtubeUrl usa o canal do YouTube como fonte
        ordered.push(p.platform === 'youtube' ? p : { ...p, channelUrl: p.youtubeUrl });
    }
    return ordered;
}

function toHMS(totalSec) {
    const s = Math.max(0, Math.floor(totalSec));
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(s % 60).padStart(2, '0');
    return `${h}:${m}:${sec}`;
}

async function downloadSection(videoUrl, peakSec, index) {
    const startSec = Math.max(0, peakSec - BEFORE_SEC);
    const endSec   = peakSec + AFTER_SEC;
    const rawFile  = path.join(OUTPUT_DIR, `raw-trecho-${index}-${Date.now()}.mp4`);

    logger.step(
        `[LongCapture] Trecho #${index} — pico em ${toHMS(peakSec)} | ` +
        `baixando ${toHMS(startSec)} → ${toHMS(endSec)} (~${Math.round(endSec - startSec)}s)`
    );

    await execFileAsync(YTDLP, [
        '--download-sections', `*${toHMS(startSec)}-${toHMS(endSec)}`,
        // Corta exatamente no ponto pedido: sem isto o yt-dlp corta no keyframe
        // anterior e o clipe começa com segundos SEM ÁUDIO (áudio dessincronizado).
        '--force-keyframes-at-cuts',
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '-o', rawFile,
        videoUrl,
    ], { timeout: 10 * 60 * 1000 });

    return rawFile;
}

/**
 * Procura, entre as personas de YouTube, um vídeo com heatmap e gera uma
 * compilação longa em output/longos.
 *
 * @returns {Promise<string|null>} caminho do .mp4 gerado, ou null se falhou
 */
export async function captureLongVideo() {
    fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const ytPersonas = getLongRotationOrder();
    if (ytPersonas.length === 0) {
        logger.error('[LongCapture] Nenhuma persona de YouTube configurada.');
        return null;
    }

    const SCAN_DEPTH = parseInt(process.env.YOUTUBE_SCAN_DEPTH || '8', 10);

    for (const persona of ytPersonas) {
        logger.info(`[LongCapture] Procurando vídeo com heatmap em: ${persona.displayName}...`);

        let candidates;
        try {
            const offset = persona.videoOffset ?? 1;
            const list = await fetchYouTubeVideoList(persona.channelUrl, offset + SCAN_DEPTH - 1);
            candidates = list.slice(offset - 1);
        } catch (err) {
            logger.warn(`[LongCapture] Falha ao listar canal de ${persona.displayName}: ${err.message}`);
            continue;
        }

        for (const { videoUrl, title } of candidates) {
            // Nunca reaproveita um vídeo-fonte já compilado: sem isso, o canal
            // sem vídeo novo devolvia o MESMO vídeo no dia seguinte, gerando uma
            // compilação idêntica (mesmos picos) e postagem repetida.
            if (isSourceUsed(videoUrl)) {
                logger.info(`[LongCapture] Fonte já usada antes, pulando: "${title}"`);
                continue;
            }

            let peaks;
            try {
                // Pede mais picos do que o necessário: a filtragem por
                // sobreposição abaixo descarta boa parte deles.
                peaks = await getYoutubePeaks(videoUrl, PEAKS_N * 4);
            } catch {
                continue; // sem heatmap — próximo vídeo
            }
            if (peaks.length < 2) continue; // compilação exige 2+ trechos

            logger.success(`[LongCapture] Fonte escolhida: "${title}" (${peaks.length} picos)`);

            // Cronológico, para a compilação seguir a ordem do vídeo original
            const cronologico = [...peaks].sort((a, b) => a.peakTime - b.peakTime);

            // Descarta picos cuja JANELA se sobrepõe à do pico anterior. A seleção
            // de picos usa a distância dos Shorts (2× CLIP_BUFFER_SECONDS = 60s),
            // mas aqui a janela é BEFORE+AFTER (150s por padrão) — sem este filtro
            // a compilação repetia o mesmo trecho duas vezes.
            const janela = BEFORE_SEC + AFTER_SEC;
            const ordered = [];
            for (const p of cronologico) {
                const anterior = ordered[ordered.length - 1];
                if (!anterior || p.peakTime - anterior.peakTime >= janela) ordered.push(p);
                if (ordered.length >= PEAKS_N) break;
            }
            if (ordered.length < 2) {
                logger.warn(`[LongCapture] "${title}": só ${ordered.length} pico(s) sem sobreposição — tentando próximo vídeo.`);
                continue;
            }
            const sections = [];

            try {
                for (let i = 0; i < ordered.length; i++) {
                    sections.push(await downloadSection(videoUrl, ordered[i].peakTime, i + 1));
                }

                const outFile = path.join(OUTPUT_DIR, `longo-${persona.name}-${Date.now()}.mp4`);
                logger.step(`[LongCapture] Concatenando ${sections.length} trechos...`);
                await concatLocalClips(sections, outFile);

                logger.success(`[LongCapture] Vídeo longo gerado: ${path.basename(outFile)}`);
                registerSourceUsed(videoUrl, title);
                advanceLongIndex(persona.name);
                return outFile;
            } catch (err) {
                logger.error(`[LongCapture] Falha ao montar compilação de "${title}": ${err.message}`);
                // tenta o próximo vídeo/persona
            } finally {
                for (const f of sections) {
                    try { fs.unlinkSync(f); } catch { /* ignora */ }
                }
            }
        }
    }

    logger.error('[LongCapture] Nenhuma persona rendeu um vídeo longo.');
    return null;
}
