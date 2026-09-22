// bilibili/capture.js
// Baixa (yt-dlp) e processa (crop 9:16 + legenda) um vídeo-fonte para a
// Bilibili. Quando a fonte é VOD de uma live, corta em torno do pico de
// reação do chat original (ver chat-peaks.js) — mesma ideia do heatmap das
// personas do canal principal, adaptada pro replay de chat do YouTube em vez
// de Twitch ao vivo. Sem pico (vídeo editado/pré-gravado), processa o vídeo
// inteiro dentro de um teto de duração. Reaproveita src/processor/ffmpeg.js
// (processLocalClip/trimLocalFile) como BIBLIOTECA genérica de encoding —
// não importa nada de personas.js, round-robin ou filas dos outros canais.

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';
import { findChatPeak } from './chat-peaks.js';
import { detectBurnedCaptions } from './caption-detect.js';

const execFileAsync = promisify(execFile);
const OUTPUT_DIR = path.resolve('./bilibili/output');
const CAPTION_FONT = process.env.BILIBILI_CAPTION_FONT || 'Microsoft YaHei';

// Janela cortada em torno do pico de chat detectado (ver chat-peaks.js).
const PEAK_BEFORE_SEC = parseInt(process.env.BILIBILI_PEAK_BEFORE_SEC || '15', 10);
const PEAK_AFTER_SEC = parseInt(process.env.BILIBILI_PEAK_AFTER_SEC || '45', 10);
// Sem pico detectado (fonte não é VOD de live, ou replay indisponível), o
// vídeo inteiro é processado — mas só até esse teto, pra não gerar um
// "clipe" de 45min à toa nesse fallback.
const FALLBACK_MAX_DURATION_SEC = parseInt(process.env.BILIBILI_FALLBACK_MAX_DURATION_SEC || '400', 10);

/**
 * Extrai metadados da fonte (título/descrição originais) sem baixar nada —
 * usado como contexto real pro gerador de metadados em chinês (bilibili/metadata.js),
 * em vez de só a URL crua.
 * @param {string} sourceUrl
 * @returns {Promise<{ title: string, description: string }>}
 */
export async function fetchSourceInfo(sourceUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    try {
        const { stdout } = await execFileAsync(ytDlp, [
            '--dump-json', '--no-playlist', '--skip-download', sourceUrl,
        ], { maxBuffer: 20 * 1024 * 1024 });
        const info = JSON.parse(stdout.trim().split('\n')[0]);
        return { title: info.title || '', description: info.description || '' };
    } catch (err) {
        logger.warn(`[Bilibili/Capture] Não foi possível extrair metadados da fonte: ${err.message}`);
        return { title: '', description: '' };
    }
}

// Resolução mínima aceitável (menor lado) — abaixo disso, a fonte caiu no
// fallback ultra-degradado do YouTube (format legado "18", visto na prática
// com Shorts do canal Roblox/@flamingo: 202×360 em vez de 1080×1920) em vez
// de um formato de verdade. Descoberto 05/09/2026: o "SABR-only streaming
// experiment" do YouTube às vezes derruba TODOS os formatos do client
// android exceto esse legado, e o crop de fundo desfocado (buildBlurredBackgroundFilter
// em src/processor/ffmpeg.js) assume largura >= 1080 após escalar pela altura
// — largura menor gera crop negativo e o ffmpeg falha com "Invalid argument"
// sem processar nenhum frame.
const MIN_ACCEPTABLE_DIMENSION = 480;

async function probeMinDimension(filePath) {
    const ffprobe = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
    try {
        const { stdout } = await execFileAsync(ffprobe, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=width,height',
            '-of', 'csv=p=0:s=x', filePath,
        ]);
        const [w, h] = stdout.trim().split('x').map(Number);
        if (!w || !h) return null;
        return Math.min(w, h);
    } catch {
        return null;
    }
}

async function downloadSource(sourceUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';

    // player_client=android evita 403 Forbidden do YouTube em vários formatos
    // (mesmo workaround já usado em src/trend-hunter/long-replicate.js), mas
    // pode cair num fallback de qualidade legada em Shorts (ver
    // MIN_ACCEPTABLE_DIMENSION acima) — nesse caso, tenta de novo sem o
    // extractor-arg (client web padrão) antes de desistir. Ordem inversa
    // (web primeiro) arriscaria reintroduzir o 403 original, então mantém
    // android como primeira tentativa.
    // Descoberto 08/09/2026 (VODs longos do KreekCraft, ver ROBLOX_CHANNELS):
    // pra vídeo de duração normal (não Shorts), android às vezes só devolve
    // formato degradado, e o client padrão (web) e o ios levam a 403/exigem
    // GVS PO Token (proteção anti-bot do YouTube que vem sendo reforçada,
    // ver aviso "SABR-only streaming experiment"). web_embedded testado
    // manualmente nesse mesmo vídeo: resolve os dois problemas (1080p real,
    // sem PO Token — usa o solver de desafio JS embutido do próprio yt-dlp).
    // Mantém android primeiro (mais rápido/leve quando funciona), web_embedded
    // como fallback real, e client padrão como último recurso.
    const attempts = [
        ['--extractor-args', 'youtube:player_client=android'],
        ['--extractor-args', 'youtube:player_client=web_embedded'],
        [], // último recurso: client padrão do yt-dlp
    ];

    let lastPath = null;
    let lastErr = null;
    for (const extraArgs of attempts) {
        const tempPath = path.join(os.tmpdir(), `bili_src_${crypto.randomBytes(4).toString('hex')}.mp4`);
        logger.step(`[Bilibili/Capture] Baixando fonte: ${sourceUrl}`);
        try {
            await execFileAsync(ytDlp, [
                ...extraArgs,
                '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                '--merge-output-format', 'mp4',
                '--no-playlist',
                '-o', tempPath,
                sourceUrl,
            ], { maxBuffer: 20 * 1024 * 1024 });
        } catch (err) {
            // Download em si falhou (timeout de rede, CDN instável no
            // formato legado, etc.) — não é o mesmo problema de qualidade
            // degradada, mas o remédio é o mesmo: tenta o próximo client em
            // vez de propagar o erro imediatamente.
            logger.warn(`[Bilibili/Capture] Download falhou com este client (${err.message.split('\n')[0]}) — tentando de novo com outro client.`);
            lastErr = err;
            if (fs.existsSync(tempPath)) fs.unlinkSync(tempPath);
            continue;
        }

        if (!fs.existsSync(tempPath)) { lastErr = new Error('yt-dlp terminou mas o arquivo não existe.'); continue; }
        lastPath = tempPath;
        lastErr = null;

        const minDim = await probeMinDimension(tempPath);
        if (minDim === null || minDim >= MIN_ACCEPTABLE_DIMENSION) return tempPath;

        logger.warn(`[Bilibili/Capture] Fonte baixada em resolução degradada (${minDim}px) — tentando de novo com outro client.`);
        fs.unlinkSync(tempPath);
        lastPath = null;
    }

    if (lastPath) {
        // Nenhuma tentativa deu qualidade aceitável, mas pelo menos uma
        // baixou algo — segue com a última mesmo assim (melhor publicar em
        // baixa qualidade do que travar o ciclo à toa); o crop de fundo
        // desfocado ainda pode falhar, mas isso já fica logado.
        return lastPath;
    }
    throw lastErr || new Error('Todas as tentativas de download falharam.');
}

// Palavras que indicam forte chance de a fonte já ter legenda/letra queimada
// pela própria pessoa (covers, karaokê, MVs) — descoberto na prática: o
// primeiro vídeo publicado (陈一发儿 cantando "Part of Your World") já tinha
// letra em inglês + tradução chinesa queimada, e nossa legenda (Whisper
// transcrevendo o canto) virou uma SEGUNDA camada por cima, brigando pela
// mesma área da tela. Heurística por palavra-chave, não visão computacional —
// simples e barato, na linha do resto do projeto (ex.: skipCaptions em
// personas de futebol que já têm placar/replay queimado).
const LIKELY_ALREADY_CAPTIONED = [
    '唱', '翻唱', '演唱', '弹唱', '合唱', '清唱', '主题曲', '歌词', '唱歌', '一起唱',
    '伴奏', '干音', 'cover', 'karaoke', '卡拉ok', 'mv', '歌曲', 'lyrics', 'sing',
];

/**
 * Heurística: o título/descrição da fonte sugerem que já tem legenda/letra
 * queimada (cover, karaokê, MV)? Baseado em palavra-chave, não é infalível —
 * o objetivo é evitar o caso mais óbvio (dupla legenda em vídeo de música),
 * não detectar toda legenda pré-existente possível.
 * @param {string} title
 * @param {string} [description]
 * @returns {boolean}
 */
export function looksAlreadyCaptioned(title, description = '') {
    const text = `${title} ${description}`.toLowerCase();
    return LIKELY_ALREADY_CAPTIONED.some((kw) => text.includes(kw.toLowerCase()));
}

/**
 * Baixa e processa um vídeo-fonte em um clipe pronto pra Bilibili — 9:16,
 * legenda queimada em fonte com glifos CJK, transcrição em chinês (a menos
 * que a fonte pareça já ter legenda/letra própria — ver skipCaptions).
 *
 * @param {string} sourceUrl
 * @param {string} [titleSlug] - usado só pro nome do arquivo/pasta, não é o título final
 * @param {object} [opts]
 * @param {boolean} [opts.skipCaptions] - não queima legenda nossa (fonte já tem)
 * @returns {Promise<string>} caminho do .mp4 processado
 */
export async function captureFromSource(sourceUrl, titleSlug = 'clipe', { skipCaptions = false } = {}) {
    const { initBinaries, processLocalClip, trimLocalFile, probeVideoDuration } = await import('../src/processor/ffmpeg.js');
    initBinaries();

    let rawPath = null;
    let peakPath = null;
    try {
        rawPath = await downloadSource(sourceUrl);

        // Pico de reação do chat original (replay do YouTube, se a fonte for
        // VOD de live) — proxy do que geraria danmaku forte na Bilibili.
        // Sem pico (não é live, ou replay indisponível): cai pro vídeo
        // inteiro, mas com teto de duração pra não processar 45min à toa.
        const peak = await findChatPeak(sourceUrl).catch((err) => {
            logger.warn(`[Bilibili/Capture] Detecção de pico de chat falhou (seguindo sem corte): ${err.message}`);
            return null;
        });

        let inputForProcessing = rawPath;
        if (peak) {
            const duration = await probeVideoDuration(rawPath);
            const startSec = Math.max(0, peak.peakTime - PEAK_BEFORE_SEC);
            const clipDuration = Math.min(PEAK_BEFORE_SEC + PEAK_AFTER_SEC, duration - startSec);
            peakPath = rawPath.replace(/\.mp4$/i, '_peak.mp4');
            await trimLocalFile(rawPath, startSec, clipDuration, peakPath);
            logger.success(`[Bilibili/Capture] Cortado em torno do pico de chat: ${Math.round(startSec)}s–${Math.round(startSec + clipDuration)}s`);
            inputForProcessing = peakPath;
        } else {
            const duration = await probeVideoDuration(rawPath);
            if (duration > FALLBACK_MAX_DURATION_SEC) {
                throw new Error(
                    `Sem pico de chat detectado e vídeo tem ${Math.round(duration)}s (teto: ${FALLBACK_MAX_DURATION_SEC}s) — ` +
                    'processar inteiro geraria um "clipe" longo demais. Pulando esta fonte.'
                );
            }
            logger.info('[Bilibili/Capture] Sem pico de chat — processando o vídeo inteiro (dentro do teto de duração).');
        }

        // Combina a heurística de título (vem do chamador, ex.: "翻唱" no
        // título) com detecção visual no trecho EXATO que será usado (pega o
        // caso que a de título não pega: criador editado com diálogo/chat
        // queimados, sem palavra reveladora no título — ver caption-detect.js).
        let finalSkipCaptions = skipCaptions;
        if (!finalSkipCaptions) {
            finalSkipCaptions = await detectBurnedCaptions(inputForProcessing).catch((err) => {
                logger.warn(`[Bilibili/Capture] Detecção visual de legenda falhou (seguindo com legenda normal): ${err.message}`);
                return false;
            });
            if (finalSkipCaptions) {
                logger.info('[Bilibili/Capture] Detecção visual encontrou legenda/overlay já queimado no trecho — pulando nossa legenda.');
            }
        }

        if (finalSkipCaptions) {
            logger.info('[Bilibili/Capture] Processando (crop 9:16, SEM legenda — fonte já tem letra/legenda própria)...');
        } else {
            logger.info('[Bilibili/Capture] Processando (crop 9:16 + legenda em chinês)...');
        }
        const processedPath = await processLocalClip(inputForProcessing, OUTPUT_DIR, titleSlug, {
            niche: 'default',
            layout: 'blur',
            fontName: CAPTION_FONT,
            language: 'zh',
            skipCaptions: finalSkipCaptions,
        });
        logger.success(`[Bilibili/Capture] Pronto: ${processedPath}`);
        return processedPath;
    } finally {
        if (rawPath && fs.existsSync(rawPath)) fs.unlinkSync(rawPath);
        if (peakPath && fs.existsSync(peakPath)) fs.unlinkSync(peakPath);
    }
}

// ─── Self-test: node bilibili/capture.js <url> ───────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('capture.js')) {
    const url = process.argv[2];
    if (!url) {
        console.error('Uso: node bilibili/capture.js <url>');
        process.exit(1);
    }
    captureFromSource(url)
        .then((p) => { console.log(`OK: ${p}`); process.exitCode = 0; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
