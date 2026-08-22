// src/capturer/sports-vod-miner.js
// Agente Minerador de VODs Esportivos — analisa jogos gravados do YouTube,
// detecta os maiores picos de reação (gols/lances) via Chat Replay ou Heatmap
// e captura automaticamente os trechos via yt-dlp --download-sections.
//
// Uso:
//   npm run mine:sports -- <URL> [QUANTIDADE_CLIPES]
//   npm run mine:sports -- "https://www.youtube.com/watch?v=XXXXX" 3
//
// Cada lance detectado gera DOIS formatos, com a duração decidindo a classificação
// (Short vs vídeo longo) de forma estrutural, não por metadado:
//   1. Short: recorte curto (RADAR_SHORT_*) derivado localmente do clipe largo —
//      bem abaixo do limite de 3min do YouTube, garantidamente um Short de verdade.
//   2. Vídeo longo: quando o VOD tem 2+ lances, todos os clipes largos
//      (RADAR_CLIP_*) são concatenados numa única compilação — a soma das
//      durações fica muito acima de 3min, garantindo que o YouTube NUNCA
//      classifique como Short, independente de hashtag/metadado.
//
// Variáveis de ambiente relevantes (.env):
//   RADAR_KEYWORDS           Keywords para spike (padrão: gol, golaço, pqp, ...)
//   RADAR_SPIKE_WINDOW_MS    Janela de agrupamento em ms (padrão: 15000)
//   RADAR_COOLDOWN_MS        Distância mínima entre lances em ms (padrão: 120000)
//   RADAR_CLIP_BEFORE_SEC    Segundos antes do lance p/ compilação (padrão: 150 = 2.5min)
//   RADAR_CLIP_AFTER_SEC     Segundos depois do lance p/ compilação (padrão: 30)
//   RADAR_SHORT_BEFORE_SEC   Segundos antes do lance p/ Short (padrão: 15)
//   RADAR_SHORT_AFTER_SEC    Segundos depois do lance p/ Short (padrão: 10)
//   RADAR_OUTPUT_DIR         Diretório de saída (padrão: ./output/sports-vod)

import dotenv from 'dotenv';
dotenv.config({ override: false });

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { pathToFileURL } from 'node:url';
import { logger } from '../utils/logger.js';
import { processLocalClip, trimLocalFile, concatLocalClips } from '../processor/ffmpeg.js';

const execFileAsync = promisify(execFile);

// ─── Configuração via .env ─────────────────────────────────────────────────────

const YTDLP        = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
const OUTPUT_DIR   = path.resolve(process.env.RADAR_OUTPUT_DIR   || './output/sports-vod');
const BEFORE_SEC   = parseInt(process.env.RADAR_CLIP_BEFORE_SEC  || '150', 10);
const AFTER_SEC    = parseInt(process.env.RADAR_CLIP_AFTER_SEC   || '30',  10);
const SHORT_BEFORE_SEC = parseInt(process.env.RADAR_SHORT_BEFORE_SEC || '15', 10);
const SHORT_AFTER_SEC  = parseInt(process.env.RADAR_SHORT_AFTER_SEC  || '10', 10);
const COOLDOWN_SEC = parseInt(process.env.RADAR_COOLDOWN_MS      || '120000', 10) / 1000;
const WINDOW_SEC   = parseInt(process.env.RADAR_SPIKE_WINDOW_MS  || '15000',  10) / 1000;

const KEYWORDS = (
    process.env.RADAR_KEYWORDS ||
    'gol,golaço,goool,goooool,gooool,golaço,vaaaaai,pqp,que golaço,que gol,GOOOL,GOL'
)
    .toLowerCase()
    .split(',')
    .map((k) => k.trim())
    .filter(Boolean);

// ─── Utilitários ───────────────────────────────────────────────────────────────

function toHMS(totalSec) {
    const h = Math.floor(totalSec / 3600);
    const m = Math.floor((totalSec % 3600) / 60);
    const s = Math.floor(totalSec % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

// ─── Seleção de Picos (não-sobrepostos) ────────────────────────────────────────
//
// Recebe um array de { sec, score }, ordena por score decrescente e
// seleciona os topN mais altos garantindo minGapSec de distância entre eles.
// Retorna ordenado cronologicamente.

function selectTopPeaks(segments, topN, minGapSec) {
    const sorted = [...segments].sort((a, b) => b.score - a.score);
    const selected = [];

    for (const seg of sorted) {
        if (seg.score <= 0) continue;
        const tooClose = selected.some((p) => Math.abs(p.sec - seg.sec) < minGapSec);
        if (!tooClose) selected.push(seg);
        if (selected.length >= topN) break;
    }

    return selected.sort((a, b) => a.sec - b.sec); // ordem cronológica
}

// ─── Estratégia A: Chat Replay ─────────────────────────────────────────────────
//
// O yt-dlp gera um arquivo .live_chat.json (JSONL) onde cada linha é um evento
// de chat com videoOffsetTimeMsec indicando o segundo exato do vídeo.
// Agrupamos os keyword hits em buckets de WINDOW_SEC e selecionamos os maiores picos.

async function downloadChatReplay(videoUrl, tempDir) {
    logger.info('[VodMiner] Baixando replay do chat via yt-dlp...');
    try {
        await execFileAsync(YTDLP, [
            '--write-subs',
            '--sub-langs', 'live_chat',
            '--skip-download',
            '--no-playlist',
            '-o', path.join(tempDir, 'chat'),
            videoUrl,
        ], { timeout: 5 * 60 * 1000 });
    } catch (err) {
        // yt-dlp retorna exit code 1 quando não há chat — não é erro fatal
        logger.warn(`[VodMiner] yt-dlp chat: ${err.message.split('\n')[0]}`);
    }

    const chatFile = path.join(tempDir, 'chat.live_chat.json');
    return fs.existsSync(chatFile) ? chatFile : null;
}

function parseChatReplay(chatFile) {
    const lines = fs.readFileSync(chatFile, 'utf8').split('\n').filter(Boolean);
    const hits  = []; // [{sec}]

    for (const line of lines) {
        let obj;
        try { obj = JSON.parse(line); } catch { continue; }

        const action = obj?.replayChatItemAction;
        if (!action) continue;

        const sec = parseInt(action.videoOffsetTimeMsec || '0', 10) / 1000;

        for (const act of (action.actions || [])) {
            const renderer =
                act?.addChatItemAction?.item?.liveChatTextMessageRenderer ||
                act?.addChatItemAction?.item?.liveChatPaidMessageRenderer;
            if (!renderer) continue;

            const text = (renderer.message?.runs || [])
                .map((r) => r.text || r?.emoji?.shortcuts?.[0] || '')
                .join('')
                .toLowerCase();

            if (KEYWORDS.some((kw) => text.includes(kw))) {
                hits.push({ sec });
                break; // um hit por mensagem é suficiente
            }
        }
    }

    return hits;
}

function chatReplayPeaks(hits, topN) {
    if (hits.length === 0) return [];

    // Agrupa em buckets de WINDOW_SEC e conta hits por bucket
    const maxSec     = Math.max(...hits.map((h) => h.sec));
    const bucketCount = Math.ceil(maxSec / WINDOW_SEC) + 1;
    const buckets     = new Float32Array(bucketCount);

    for (const { sec } of hits) {
        const b = Math.floor(sec / WINDOW_SEC);
        if (b < bucketCount) buckets[b]++;
    }

    const segments = Array.from(buckets, (count, i) => ({
        sec  : i * WINDOW_SEC + WINDOW_SEC / 2, // centro do bucket
        score: count,
    }));

    return selectTopPeaks(segments, topN, COOLDOWN_SEC);
}

// ─── Estratégia B: Heatmap (Most Replayed) ────────────────────────────────────
//
// O yt-dlp expõe o heatmap via --dump-json como um array de
// { start_time, end_time, value } onde value 0-1 (1 = trecho mais assistido).
// Picos altos no heatmap = gols/lances que o público volta para rever.

async function getVideoInfo(videoUrl) {
    logger.info('[VodMiner] Obtendo metadados e heatmap via yt-dlp --dump-json...');
    const { stdout } = await execFileAsync(YTDLP, [
        '--dump-json',
        '--no-playlist',
        videoUrl,
    ], { timeout: 3 * 60 * 1000 });
    return JSON.parse(stdout.trim());
}

function heatmapPeaks(heatmap, topN) {
    if (!heatmap?.length) return [];

    const segments = heatmap.map((s) => ({
        sec  : (s.start_time + s.end_time) / 2,
        score: s.value,
    }));

    return selectTopPeaks(segments, topN, COOLDOWN_SEC);
}

// ─── Captura DVR via yt-dlp --download-sections ────────────────────────────────

async function captureSection(videoUrl, peakSec, lanceNum) {
    if (!fs.existsSync(OUTPUT_DIR)) fs.mkdirSync(OUTPUT_DIR, { recursive: true });

    const startSec = Math.max(0, peakSec - BEFORE_SEC);
    const endSec   = peakSec + AFTER_SEC;
    const section  = `*${toHMS(startSec)}-${toHMS(endSec)}`;
    const ts       = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const rawFile  = path.join(OUTPUT_DIR, `raw-lance-${lanceNum}-${ts}.mp4`);

    logger.step(
        `[VodMiner] Lance #${lanceNum} — Pico: ${toHMS(peakSec)} | ` +
        `Capturando: ${toHMS(startSec)} → ${toHMS(endSec)} (~${Math.round(endSec - startSec)}s)`
    );

    await execFileAsync(YTDLP, [
        '--download-sections', section,
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

    logger.success(`[VodMiner] Capturado: ${path.basename(rawFile)}`);
    return { rawFile, startSec };
}

// ─── Banner ────────────────────────────────────────────────────────────────────

function printBanner(videoUrl, topN, strategy) {
    const cooldownMin = (COOLDOWN_SEC / 60).toFixed(1);
    const windowSec   = WINDOW_SEC;
    const beforeMin   = (BEFORE_SEC / 60).toFixed(1);

    console.log('\n\x1b[36m' + '═'.repeat(62) + '\x1b[0m');
    console.log('\x1b[36m  VOD MINER ESPORTIVO — CorteCerto\x1b[0m');
    console.log(`\x1b[36m  VOD    : ${videoUrl}\x1b[0m`);
    console.log(`\x1b[36m  Lances : ${topN} maiores picos | Estratégia: ${strategy}\x1b[0m`);
    console.log(`\x1b[36m  Janela : ${windowSec}s | Gap mínimo: ${cooldownMin}min\x1b[0m`);
    console.log(`\x1b[36m  Short  : -${SHORT_BEFORE_SEC}s antes → +${SHORT_AFTER_SEC}s depois\x1b[0m`);
    console.log(`\x1b[36m  Longo  : -${beforeMin}min antes → +${AFTER_SEC}s depois (compilação, se 2+ lances)\x1b[0m`);
    console.log(`\x1b[36m  Keys   : [${KEYWORDS.slice(0, 6).join(', ')}${KEYWORDS.length > 6 ? ', ...' : ''}]\x1b[0m`);
    console.log('\x1b[36m' + '═'.repeat(62) + '\x1b[0m\n');
}

// ─── Main ──────────────────────────────────────────────────────────────────────

export async function mineVodPeaks(videoUrl, topN) {
    const tempDir = path.join(os.tmpdir(), `vod-miner-${Date.now()}`);
    fs.mkdirSync(tempDir, { recursive: true });

    let peaks    = [];
    let strategy = 'pendente';

    // ── Estratégia A: Chat Replay (mais preciso para gols) ────────────────────
    try {
        const chatFile = await downloadChatReplay(videoUrl, tempDir);
        if (chatFile) {
            const hits = parseChatReplay(chatFile);
            logger.info(`[VodMiner] Chat replay: ${hits.length} keyword hits encontrados.`);

            if (hits.length > 0) {
                peaks    = chatReplayPeaks(hits, topN);
                strategy = 'chat-replay';
            } else {
                logger.warn('[VodMiner] Chat replay sem keyword hits — tentando heatmap.');
            }
        } else {
            logger.warn('[VodMiner] Chat replay não disponível para este VOD.');
        }
    } catch (err) {
        logger.warn(`[VodMiner] Chat replay falhou: ${err.message}`);
    } finally {
        try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignora */ }
    }

    // ── Estratégia B: Heatmap (fallback ou complemento) ──────────────────────
    if (peaks.length < topN) {
        const need = topN - peaks.length;
        logger.info(`[VodMiner] Heatmap: buscando ${need} pico(s) adicional(is)...`);
        try {
            const info       = await getVideoInfo(videoUrl);
            const heatPeaks  = heatmapPeaks(info.heatmap, topN);

            if (heatPeaks.length === 0) {
                logger.warn('[VodMiner] Heatmap indisponível ou vazio para este vídeo.');
            } else {
                for (const p of heatPeaks) {
                    if (peaks.length >= topN) break;
                    const dup = peaks.some((ep) => Math.abs(ep.sec - p.sec) < COOLDOWN_SEC);
                    if (!dup) peaks.push(p);
                }
                peaks.sort((a, b) => a.sec - b.sec);
                strategy = strategy === 'chat-replay' ? 'chat-replay + heatmap' : 'heatmap';
            }
        } catch (err) {
            logger.warn(`[VodMiner] Heatmap falhou: ${err.message}`);
        }
    }

    if (peaks.length === 0) {
        throw new Error(
            'Nenhum pico detectado. Verifique se o vídeo tem chat replay ou heatmap ' +
            'disponível, ou ajuste RADAR_KEYWORDS/RADAR_SPIKE_THRESHOLD no .env.'
        );
    }

    printBanner(videoUrl, peaks.length, strategy);

    logger.success(
        `[VodMiner] ${peaks.length} lance(s) detectado(s):\n` +
        peaks.map((p, i) =>
            `  Lance #${i + 1}: ${toHMS(p.sec)} (score: ${p.score.toFixed(2)})`
        ).join('\n')
    );

    // ── Pipeline: Captura larga → deriva Short → posta; guarda p/ compilação ──
    let posted = 0;
    const wideFiles = []; // clipes largos bem-sucedidos, usados na compilação depois

    for (let i = 0; i < peaks.length; i++) {
        const peak     = peaks[i];
        const lanceNum = i + 1;

        console.log(`\n\x1b[33m── Lance ${lanceNum}/${peaks.length} ─────────────────────────────────\x1b[0m`);

        // 1. Captura DVR (janela larga — também serve de base p/ a compilação)
        let wideFile, wideStartSec;
        try {
            ({ rawFile: wideFile, startSec: wideStartSec } = await captureSection(videoUrl, peak.sec, lanceNum));
        } catch (err) {
            logger.error(`[VodMiner] Captura falhou para lance #${lanceNum}: ${err.message}`);
            continue;
        }

        // 2. Deriva o Short via trim local (sem nova chamada ao yt-dlp) e posta
        const shortOffsetInWide = Math.max(wideStartSec, peak.sec - SHORT_BEFORE_SEC) - wideStartSec;
        const shortDuration     = (peak.sec + SHORT_AFTER_SEC) - Math.max(wideStartSec, peak.sec - SHORT_BEFORE_SEC);
        const shortRawFile      = path.join(OUTPUT_DIR, `raw-short-${lanceNum}-${Date.now()}.mp4`);

        try {
            await trimLocalFile(wideFile, shortOffsetInWide, shortDuration, shortRawFile);
            const processedShort = await processLocalClip(shortRawFile, OUTPUT_DIR, `lance-${lanceNum}`);
            const { postExpressClip } = await import('../../poster/express-poster.js');
            const result = await postExpressClip(processedShort);
            if (result.youtube === true || result.tiktok === true) posted++;
        } catch (err) {
            logger.error(`[VodMiner] Short do lance #${lanceNum} falhou: ${err.message}`);
        } finally {
            try { fs.unlinkSync(shortRawFile); } catch { /* ignora */ }
        }

        wideFiles.push(wideFile); // apagado só depois da compilação, abaixo
    }

    // ── Compilação "vídeo longo": só com 2+ lances (garante duração >> 3min) ──
    if (wideFiles.length >= 2) {
        console.log(`\n\x1b[33m── Compilação (vídeo longo) — ${wideFiles.length} lances ─────────────\x1b[0m`);
        const compilationRaw = path.join(OUTPUT_DIR, `raw-compilacao-${Date.now()}.mp4`);
        try {
            await concatLocalClips(wideFiles, compilationRaw);
            const processedCompilation = await processLocalClip(compilationRaw, OUTPUT_DIR, 'compilacao');
            const { postExpressClip } = await import('../../poster/express-poster.js');
            const result = await postExpressClip(processedCompilation);
            if (result.youtube === true || result.tiktok === true) posted++;
        } catch (err) {
            logger.error(`[VodMiner] Compilação (vídeo longo) falhou: ${err.message}`);
        } finally {
            try { fs.unlinkSync(compilationRaw); } catch { /* ignora */ }
        }
    } else if (wideFiles.length === 1) {
        logger.info('[VodMiner] Só 1 lance capturado — sem compilação de vídeo longo (mínimo: 2).');
    }

    for (const f of wideFiles) {
        try { fs.unlinkSync(f); } catch { /* ignora */ }
    }

    console.log('\n\x1b[36m' + '═'.repeat(62) + '\x1b[0m');
    logger.success(`[VodMiner] Concluido. ${posted} publicação(ões) a partir de ${peaks.length} lance(s).`);

    return { peaksFound: peaks.length, posted, strategy };
}

// ─── CLI Entry Point ────────────────────────────────────────────────────────────
// Só roda quando o arquivo é executado diretamente (node sports-vod-miner.js ...),
// não quando importado por outro módulo (ex: sports-monitor.js).

const isDirectRun = import.meta.url === pathToFileURL(process.argv[1] || '').href;

if (isDirectRun) {
    const [,, vodUrl, nArg] = process.argv;
    const topN = Math.max(1, parseInt(nArg || '3', 10));

    if (!vodUrl) {
        console.error(
            '\nUso:\n' +
            '  npm run mine:sports -- "<URL_DO_VOD>" [QUANTIDADE_CLIPES]\n\n' +
            'Exemplos:\n' +
            '  npm run mine:sports -- "https://www.youtube.com/watch?v=XXXXX"\n' +
            '  npm run mine:sports -- "https://www.youtube.com/watch?v=XXXXX" 5\n'
        );
        process.exit(1);
    }

    mineVodPeaks(vodUrl, topN).catch((err) => {
        logger.error(`[VodMiner] Erro fatal: ${err.message}`);
        process.exit(1);
    });
}
