// src/processor/ffmpeg.js
// Responsável por baixar o trecho do vídeo, cortar e converter para 9:16.
//
// Pipeline:
//   1. yt-dlp obtém URLs de stream (vídeo + áudio separados)
//   2. FFmpeg faz download rápido do segmento sem re-encoding (cópia)
//   3. active_speaker.py analisa o arquivo local com MediaPipe e gera sendcmd
//   4. FFmpeg re-encoda com crop 9:16 dinâmico (sendcmd) ou estático (fallback Gemini)
//   5. addCaptionsToClip adiciona legendas automáticas

import ffmpeg from 'fluent-ffmpeg';
import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { logger } from '../utils/logger.js';
import { sanitizeFilename, formatDuration } from '../utils/helpers.js';
import { addCaptionsToClip } from './captions.js';
import { detectCropXPosition } from './face-detect.js';

const execFileAsync = promisify(execFile);
const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ─── Configuração dos binários ──────────────────────────────────────────────

function configureBinaries() {
    const ffmpegPath = process.env.FFMPEG_PATH?.trim();
    const ffprobePath = process.env.FFPROBE_PATH?.trim();

    if (ffmpegPath) {
        ffmpeg.setFfmpegPath(ffmpegPath);
        logger.info(`FFmpeg path configurado: ${ffmpegPath}`);
    }
    if (ffprobePath) {
        ffmpeg.setFfprobePath(ffprobePath);
        logger.info(`FFprobe path configurado: ${ffprobePath}`);
    }
}

// ─── Obtenção de URLs de stream via yt-dlp ──────────────────────────────────

/**
 * Usa yt-dlp para obter as URLs diretas de stream de vídeo E áudio.
 * Quando o formato é bestvideo+bestaudio, yt-dlp retorna DUAS linhas:
 *   linha 1 → URL do vídeo (sem áudio)
 *   linha 2 → URL do áudio (sem vídeo)
 * Ambas são necessárias para que o FFmpeg produza um arquivo com som.
 *
 * @param {string} videoUrl
 * @returns {Promise<{ videoStreamUrl: string, audioStreamUrl: string|null }>}
 */
async function getStreamUrls(videoUrl) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    logger.info('Obtendo URLs de stream via yt-dlp...');

    const { stdout } = await execFileAsync(ytDlp, [
        '--get-url',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--no-playlist',
        videoUrl,
    ]);

    const lines = stdout.trim().split('\n').map((l) => l.trim()).filter(Boolean);

    return {
        videoStreamUrl: lines[0],
        audioStreamUrl: lines[1] || null,
    };
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ensureOutputDir(outputDir) {
    if (!fs.existsSync(outputDir)) {
        fs.mkdirSync(outputDir, { recursive: true });
        logger.info(`Diretório de saída criado: ${outputDir}`);
    }
}

function buildOutputFilename(peakTime, clipIndex, totalClips) {
    const padded = String(clipIndex).padStart(String(totalClips).length, '0');
    return `${padded}__pico-${Math.floor(peakTime)}s.mp4`;
}

function cleanupFiles(...paths) {
    for (const p of paths) {
        try { if (p && fs.existsSync(p)) fs.unlinkSync(p); } catch (_) { /* ignora */ }
    }
}

/**
 * Escapa um caminho de arquivo para uso em strings de filtro FFmpeg.
 * No Windows, o dois-pontos após a letra de drive precisa ser escapado com \:.
 * Barras invertidas são convertidas para barras normais.
 */
function ffmpegEscapePath(p) {
    return p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, '$1\\:');
}

// ─── Etapa 1: Download do segmento bruto (sem re-encoding) ──────────────────

/**
 * Baixa o segmento do vídeo (startTime → endTime) para um arquivo local
 * usando cópia de stream (-c copy), sem re-encoding. Muito mais rápido que
 * re-encodar e produz um arquivo que o script Python pode analisar.
 *
 * @param {string}      videoStreamUrl
 * @param {string|null} audioStreamUrl
 * @param {number}      startTime   - segundos
 * @param {number}      endTime     - segundos
 * @param {string}      tempPath    - caminho do arquivo de saída temporário
 * @returns {Promise<void>}
 */
function downloadRawClip(videoStreamUrl, audioStreamUrl, startTime, endTime, tempPath) {
    const duration = endTime - startTime;
    logger.info(`Baixando segmento bruto (${formatDuration(duration)}) para análise ASD...`);

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg();

        cmd.input(videoStreamUrl).inputOptions([`-ss ${startTime}`, `-t ${duration}`]);

        if (audioStreamUrl) {
            cmd.input(audioStreamUrl).inputOptions([`-ss ${startTime}`, `-t ${duration}`]);
            cmd.outputOptions(['-map 0:v:0', '-map 1:a:0']);
        }

        cmd
            .outputOptions(['-c copy', '-avoid_negative_ts make_zero', '-y'])
            .output(tempPath)
            .on('end', resolve)
            .on('error', (err) => reject(new Error(`FFmpeg (download bruto): ${err.message}`)))
            .run();
    });
}

// ─── Etapa 2: Active Speaker Detection (Python/MediaPipe) ───────────────────

/**
 * Chama active_speaker.py no arquivo local e retorna os resultados.
 *
 * Códigos de saída do Python:
 *   0 → sucesso, sendcmd gerado
 *   1 → arquivo não encontrado
 *   2 → nenhum rosto detectado (vídeo sem pessoas)
 *   outro → erro inesperado
 *
 * @param {string} videoPath  - arquivo local a analisar
 * @param {string} cmdsPath   - onde salvar o arquivo sendcmd
 * @returns {Promise<{ success: boolean, meta: object|null, noFaces: boolean }>}
 */
function runAsdPython(videoPath, cmdsPath) {
    const pythonPath = process.env.PYTHON_PATH?.trim() || 'python';
    const scriptPath = path.join(__dirname, 'active_speaker.py');

    return new Promise((resolve) => {
        if (!fs.existsSync(scriptPath)) {
            logger.warn(`[ASD] Script não encontrado: ${scriptPath}`);
            return resolve({ success: false, meta: null, noFaces: false });
        }

        logger.info('[ASD] Iniciando detecção de falante ativo com MediaPipe...');

        const proc = spawn(pythonPath, [scriptPath, videoPath, cmdsPath], {
            stdio: ['ignore', 'pipe', 'pipe'],
        });

        proc.stdout.on('data', (d) => {
            for (const line of d.toString().split('\n').filter(Boolean)) {
                logger.info(line);
            }
        });
        proc.stderr.on('data', (d) => {
            for (const line of d.toString().split('\n').filter(Boolean)) {
                logger.warn(line);
            }
        });

        proc.on('error', (err) => {
            logger.warn(`[ASD] Falha ao iniciar Python: ${err.message}`);
            resolve({ success: false, meta: null, noFaces: false });
        });

        proc.on('close', (code) => {
            if (code === 2) {
                logger.warn('[ASD] Nenhum rosto detectado — vídeo sem pessoas visíveis.');
                return resolve({ success: false, meta: null, noFaces: true });
            }
            if (code !== 0) {
                logger.warn(`[ASD] Script encerrou com código ${code}.`);
                return resolve({ success: false, meta: null, noFaces: false });
            }

            const metaPath = cmdsPath + '.json';
            try {
                const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
                logger.success(`[ASD] Análise concluída — crop dinâmico ${meta.crop_w}x${meta.crop_h} pronto.`);
                resolve({ success: true, meta, noFaces: false });
            } catch (err) {
                logger.warn(`[ASD] Falha ao ler metadados JSON: ${err.message}`);
                resolve({ success: false, meta: null, noFaces: false });
            }
        });
    });
}

// ─── Etapa 3a: Corte direto (CDN → output) via complexFilter ─────────────────

/**
 * Corta e converte um segmento diretamente das URLs de stream do CDN para o
 * output final 1080×1920, sem arquivo temporário intermediário.
 *
 * Usa cmd.complexFilter() do fluent-ffmpeg para garantir que a cadeia completa
 * (split → crop → scale → vstack → audio) seja passada como um único argumento
 * -filter_complex, eliminando qualquer conflito com -vf / -map implícitos.
 *
 * CROP RATIO CORRETO para split-screen 1080×960 a partir de vídeo 16:9:
 *   ih*9/8  = 1215px → proporção 9:8 = 1.125:1 → escala uniforme para 1080×960 ✓
 *   ih*9/16 = 608px  → proporção 9:16 = 0.56:1 → distorce 1.78x ao escalar  ✗
 *
 * @param {string}      videoStreamUrl
 * @param {string|null} audioStreamUrl - null quando yt-dlp retorna stream único
 * @param {number}      startTime
 * @param {number}      endTime
 * @param {string}      outputPath
 * @param {number}      cropXPercent   - posição horizontal do rosto [0.0–1.0]
 */
function runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, cropXPercent = 0.5, useBlurBackground = false) {
    const duration = endTime - startTime;
    const safeX = Math.min(1, Math.max(0, cropXPercent));

    // Fade-out de 1.5s no final do áudio
    const fadeD = 1.5;
    const fadeOutStart = Math.max(0, duration - fadeD).toFixed(2);

    // Quando yt-dlp retorna dois streams separados, o áudio está no input 1.
    // Quando retorna um stream único (best), o áudio está em [0:a].
    const audioRef = audioStreamUrl ? '[1:a]' : '[0:a]';

    const modeLabel = useBlurBackground ? 'blur-background' : 'split-screen';
    logger.step(`Cortando ${modeLabel} 1080×1920 (${formatDuration(duration)})...`);

    // Cadeia de áudio compartilhada entre os dois modos
    const audioChain =
        `${audioRef}aresample=async=1:min_hard_comp=0.100000:first_pts=0,` +
        `loudnorm=I=-16:TP=-1.5:LRA=11,` +
        `afade=t=out:st=${fadeOutStart}:d=${fadeD}[outa]`;

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg();

        // Input 0: vídeo (seek antes do -i = input seek, muito mais rápido que output seek)
        cmd.input(videoStreamUrl)
            .inputOptions([`-ss ${startTime}`, `-t ${duration}`]);

        // Input 1: áudio separado (opcional)
        if (audioStreamUrl) {
            cmd.input(audioStreamUrl)
                .inputOptions([`-ss ${startTime}`, `-t ${duration}`]);
        }

        // ── filter_complex ─────────────────────────────────────────────────────
        // Todos os filtros em um único grafo → nenhum conflito com -vf ou -map.
        let filterStr;

        if (useBlurBackground) {
            // ── Modo: Fundo Desfocado (Blurred Background Padding) ────────────
            // Preserva o frame 16:9 COMPLETO. Sem corte de laterais, sem distorção.
            //
            //  [bg]: vídeo escalado para cobrir 1080×1920 + boxblur pesado
            //  [fg]: vídeo escalado para 1080px de largura (altura proporcional)
            //        Ex: 1920×1080 → 1080×608  (16:9 mantido)
            //  overlay centraliza [fg] sobre [bg] → resultado final 1080×1920
            filterStr = [
                // Duplica o stream em dois ramos: fundo e frente
                `[0:v]split=2[bg_src][fg_src]`,
                // Fundo: escala pela altura para cobrir 1080×1920, corta centro, desfocha
                `[bg_src]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0,boxblur=20:20[bg]`,
                // Frente: 1080px de largura, proporção original preservada
                `[fg_src]scale=1080:-2[fg]`,
                // Centraliza a camada principal sobre o fundo desfocado → 1080×1920
                `[bg][fg]overlay=(W-w)/2:(H-h)/2[outv]`,
                // Áudio: resync + loudnorm + fade-out suave
                audioChain,
            ].join(';');
        } else {
            // ── Modo: Split-Screen (dois painéis 1080×960 empilhados) ─────────
            // Útil para conteúdo com facecam separada (câmera + gameplay).
            filterStr = [
                // Vídeo: duplica em dois ramos
                `[0:v]split=2[v1][v2]`,
                // Facecam (painel superior): crop 9:8 centrado no rosto + borda 4px
                `[v1]crop=ih*9/8:ih:(iw-ih*9/8)*${safeX}:0,` +
                    `scale=1080:960:flags=lanczos,` +
                    `drawbox=x=0:y=956:w=iw:h=4:color=black:t=fill[top]`,
                // Gameplay (painel inferior): crop 9:8 centralizado
                `[v2]crop=ih*9/8:ih:(iw-ih*9/8)*0.5:0,scale=1080:960:flags=lanczos[bot]`,
                // Stack vertical → 1080×1920
                `[top][bot]vstack=inputs=2[outv]`,
                // Áudio: resync + loudnorm + fade-out suave
                audioChain,
            ].join(';');
        }

        // complexFilter() garante que o fluent-ffmpeg use -filter_complex sem
        // adicionar -vf ou qualquer mapeamento implícito que criaria streams duplicados.
        cmd.complexFilter(filterStr);

        // Mapeamento explícito das saídas do grafo
        cmd.outputOptions([
            '-map', '[outv]',
            '-map', '[outa]',
        ]);

        cmd.videoCodec('libx264')
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions([
                '-crf 18',
                '-b:v 5M',
                '-maxrate 5M',
                '-bufsize 10M',
                '-preset fast',
                '-movflags +faststart',
                '-avoid_negative_ts make_zero',
                `-t ${duration}`,
            ])
            .output(outputPath)
            .on('start', (cmdLine) => logger.info(`[FFmpeg] ${cmdLine.slice(0, 200)}`))
            .on('progress', (p) => {
                if (p.percent) process.stdout.write(`\r  ⏳ ${Math.min(p.percent, 100).toFixed(1)}%   `);
            })
            .on('end', () => { process.stdout.write('\n'); resolve(); })
            .on('error', (err) => { process.stdout.write('\n'); reject(new Error(`FFmpeg: ${err.message}`)); })
            .run();
    });
}

// ─── Etapa 3b: Re-encoding de arquivo local (ASD) ────────────────────────────

/**
 * Re-encoda o arquivo local com um filtro de vídeo.
 * Sempre aplica aresample + loudnorm no áudio.
 * Se LOOP_FADE !== 'false' e clipDurationSec > 1.5s, adiciona fade-out de 1.5s
 * no final do áudio para incentivar replay (loop perfeito).
 *
 * @param {string}  inputPath      - arquivo local (saída do downloadRawClip)
 * @param {string}  outputPath
 * @param {string}  cropFilter     - filtro FFmpeg (simples -vf ou filter_complex)
 * @param {boolean} useComplex     - true → usa -filter_complex + -map (necessário para split-screen)
 * @param {number|null} clipDurationSec - duração total do clipe em segundos (para o fade)
 * @returns {Promise<void>}
 */
function runFfmpegEncode(inputPath, outputPath, cropFilter, useComplex = false, clipDurationSec = null) {
    logger.step(`Re-encodando com crop 9:16 ${useComplex ? '(split-screen)' : '(single-panel)'}...`);

    // Cadeia de áudio: resample (sync) → loudnorm (nivelamento) → fade-out suave
    const fadeD = 1.5;
    const applyFade = process.env.LOOP_FADE !== 'false'
        && clipDurationSec !== null
        && clipDurationSec > fadeD;
    const fadeOutStart = applyFade ? Math.max(0, clipDurationSec - fadeD).toFixed(2) : null;

    const audioFilters = [
        // Corrige dessincronismo de timestamps do stream
        'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        // Nivelamento de volume: impede estouro nos gritos/reações (target -16 LUFS)
        'loudnorm=I=-16:TP=-1.5:LRA=11',
    ];
    if (applyFade) {
        audioFilters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeD}`);
    }
    const audioFilterChain = audioFilters.join(',');

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg(inputPath);

        if (useComplex) {
            // filter_complex: vídeo via [out] + áudio processado via [aout]
            // O áudio é encadeado no mesmo filter_complex para evitar conflito com -map.
            const fullFilter = cropFilter + `;[0:a]${audioFilterChain}[aout]`;
            cmd.outputOptions([
                '-filter_complex', fullFilter,
                '-map', '[out]',
                '-map', '[aout]',
            ]);
        } else {
            // Filtro simples: sendcmd+crop (ASD) ou crop estático
            cmd.videoFilter(cropFilter);
            cmd.audioFilters(audioFilters);
        }

        cmd
            .videoCodec('libx264')
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions([
                '-crf 18',          // Alta qualidade (era 23 — menos é melhor)
                '-b:v 5M',          // 5 Mbps — bitrate adequado para Shorts/TikTok HD
                '-preset fast',
                '-movflags +faststart',
            ])
            .output(outputPath)
            .on('start', () => logger.info('FFmpeg encode iniciado.'))
            .on('progress', (progress) => {
                if (progress.percent) {
                    process.stdout.write(
                        `\r  ⏳ Progresso: ${Math.min(progress.percent, 100).toFixed(1)}%   `
                    );
                }
            })
            .on('end', () => {
                process.stdout.write('\n');
                resolve();
            })
            .on('error', (err) => {
                process.stdout.write('\n');
                reject(new Error(`FFmpeg encode: ${err.message}`));
            })
            .run();
    });
}

// ─── Etapa 3c: Split-Screen de dois inputs distintos ─────────────────────────

/**
 * Combina dois arquivos de vídeo em split-screen vertical 1080×1920.
 * Podcast/Câmera no painel superior (1080×960) e Gameplay no inferior (1080×960).
 *
 * ╔══════════════════════════════╗
 * ║   Podcast / Câmera (topo)   ║  1080×960  — FIT  (pad preto se necessário)
 * ╠══════════════════════════════╣
 * ║   Gameplay      (fundo)     ║  1080×960  — FILL (crop centralizado)
 * ╚══════════════════════════════╝
 *                                  1080×1920  total
 *
 * ── Por que o vstack quebra sem normalização ──────────────────────────────────
 *
 *   1. SAR ≠ 1:1  → Câmeras DSLR e celulares gravam com pixels anamórficos
 *                   (ex: SAR 16:15). O vstack interpola sem corrigir → achata.
 *   2. FPS díspares → vstack requer o mesmo tempo por frame nos dois inputs.
 *                   Gameplay a 60fps + podcast a 30fps → frames saltam ou travam.
 *   3. Largura ímpar → libx264 recusa ("width not divisible by 2").
 *                   scale=1080:-1 pode gerar 607px (ímpar) → crash.
 *   4. Alturas diferentes → vstack recusa ("Input frame heights do not match").
 *                   Sem forçar h=960 nos dois, o filtro falha silenciosamente.
 *
 * ── Normalização trator (aplicada a cada painel antes do vstack) ──────────────
 *
 *   fps=30                                  → FPS uniforme entre os inputs
 *   setsar=1/1                              → pixels quadrados (elimina anamórfico)
 *   scale=W:H:force_original_aspect_ratio=X → escala sem distorção
 *   pad / crop                              → dimensão exata 1080×960 garantida
 *
 * ── Estratégia por painel ─────────────────────────────────────────────────────
 *
 *   Podcast  — FIT  (force_original_aspect_ratio=decrease + pad):
 *     Escala para que W≤1080 E H≤960 mantendo AR original. Barras pretas
 *     centradas preenchem o espaço restante. Frame completo sempre visível.
 *     Ideal para podcast onde todos os participantes devem aparecer.
 *
 *   Gameplay — FILL (force_original_aspect_ratio=increase + crop):
 *     Escala para que W≥1080 E H≥960 mantendo AR original. O excesso é
 *     descartado com crop centralizado. Sem barras pretas — painel 100% preenchido.
 *     Ideal para gameplay onde o centro da tela é o que importa.
 *
 * @param {string}      podcastPath   - caminho do arquivo de vídeo do podcast (input 0)
 * @param {string}      gameplayPath  - caminho do arquivo de vídeo do gameplay (input 1)
 * @param {string}      outputPath    - caminho do arquivo de saída
 * @param {number|null} durationSec   - duração máxima em segundos (null = sem limite)
 * @returns {Promise<void>}
 */
export function runFfmpegSplitScreen(podcastPath, gameplayPath, outputPath, durationSec = null) {
    logger.step(`Split-screen 1080×1920 (podcast + gameplay${durationSec ? ` · ${formatDuration(durationSec)}` : ''})...`);

    const fadeD = 1.5;
    const applyFade = durationSec !== null && durationSec > fadeD;
    const fadeOutStart = applyFade ? Math.max(0, durationSec - fadeD).toFixed(2) : null;

    const audioFilters = [
        // Corrige dessincronismo de timestamps (essencial para streams de CDN/gravações)
        'aresample=async=1:min_hard_comp=0.100000:first_pts=0',
        // Nivelamento de loudness: target -16 LUFS, true peak -1.5 dBFS
        'loudnorm=I=-16:TP=-1.5:LRA=11',
    ];
    if (applyFade) audioFilters.push(`afade=t=out:st=${fadeOutStart}:d=${fadeD}`);

    // ── filter_complex definitivo ──────────────────────────────────────────────
    //
    // Etapa A — Painel superior: Podcast (estratégia FIT)
    //   fps=30                                        → normaliza FPS
    //   setsar=1/1                                    → elimina pixels anamórficos
    //   scale=1080:960:force_original_aspect_ratio=   → escala proporcional para
    //     decrease                                       caber DENTRO de 1080×960
    //   pad=1080:960:(ow-iw)/2:(oh-ih)/2:black        → centraliza + preenche com preto
    //
    // Etapa B — Painel inferior: Gameplay (estratégia FILL)
    //   fps=30, setsar=1/1                            → mesma normalização
    //   scale=1080:960:force_original_aspect_ratio=   → escala proporcional para
    //     increase                                       COBRIR 1080×960 (pode exceder)
    //   crop=1080:960                                 → crop centralizado do excesso
    //     (sem x/y = FFmpeg usa (iw-ow)/2 e (ih-oh)/2 automaticamente)
    //
    // Etapa C — vstack
    //   [top][bot] → 1080×1920 garantido:
    //   ambos têm exatamente 1080×960, SAR=1/1, fps=30 → vstack nunca rejeita
    //
    // Mapeamento de saída:
    //   [outv] → vídeo combinado  (único stream de vídeo)
    //   [outa] → áudio do podcast (input 0 — gameplay [1:a] é descartado)

    const filterStr = [

        // ── A: Podcast — FIT (preserva frame completo, centraliza com pad preto) ─
        `[0:v]fps=30,setsar=1/1,` +
            `scale=1080:960:force_original_aspect_ratio=decrease:flags=lanczos,` +
            `pad=1080:960:(ow-iw)/2:(oh-ih)/2:black[top]`,

        // ── B: Gameplay — FILL (cobre o painel + crop centralizado) ──────────────
        `[1:v]fps=30,setsar=1/1,` +
            `scale=1080:960:force_original_aspect_ratio=increase:flags=lanczos,` +
            `crop=1080:960[bot]`,

        // ── C: vstack → 1080×1920 ─────────────────────────────────────────────────
        `[top][bot]vstack=inputs=2[outv]`,

        // ── D: Áudio do podcast (input 0) — gameplay descartado intencionalmente ──
        `[0:a]${audioFilters.join(',')}[outa]`,

    ].join(';');

    return new Promise((resolve, reject) => {
        const cmd = ffmpeg();

        // Input 0: Podcast / câmera
        cmd.input(podcastPath);
        if (durationSec !== null) cmd.inputOptions([`-t ${durationSec}`]);

        // Input 1: Gameplay
        cmd.input(gameplayPath);
        if (durationSec !== null) cmd.inputOptions([`-t ${durationSec}`]);

        // -filter_complex como único argumento — impede -vf e mapeamentos implícitos
        cmd.complexFilter(filterStr);

        // Mapeamento explícito: vídeo composto + áudio do podcast
        cmd.outputOptions([
            '-map', '[outv]',
            '-map', '[outa]',
        ]);

        cmd.videoCodec('libx264')
            .audioCodec('aac')
            .audioBitrate('192k')
            .outputOptions([
                '-crf 18',
                '-b:v 5M',
                '-maxrate 5M',
                '-bufsize 10M',
                '-preset fast',
                '-movflags +faststart',
                '-avoid_negative_ts make_zero',
            ])
            .output(outputPath)
            .on('start', (cmdLine) => logger.info(`[FFmpeg/SplitScreen2] ${cmdLine.slice(0, 220)}`))
            .on('progress', (p) => {
                if (p.percent) process.stdout.write(`\r  ⏳ ${Math.min(p.percent, 100).toFixed(1)}%   `);
            })
            .on('end', () => { process.stdout.write('\n'); resolve(); })
            .on('error', (err) => {
                process.stdout.write('\n');
                reject(new Error(`FFmpeg split-screen: ${err.message}`));
            })
            .run();
    });
}

// ─── Builders de filtro de crop ───────────────────────────────────────────────

/**
 * Filtro de crop 9:16 dinâmico usando sendcmd + MediaPipe.
 * O sendcmd atualiza o parâmetro x do crop frame a frame.
 */
function buildDynamicCropFilter(cmdsPath, meta) {
    const escapedPath = ffmpegEscapePath(cmdsPath);
    return (
        `sendcmd=f='${escapedPath}',` +
        `crop=${meta.crop_w}:${meta.crop_h}:0:0,` +
        `scale=1080:1920:flags=lanczos`
    );
}

/**
 * Filtro de crop 9:16 estático (fallback quando ASD falha ou não há rostos).
 * cropXPercent: posição horizontal [0.0=esq, 0.5=centro, 1.0=dir].
 */
function buildStaticCropFilter(cropXPercent) {
    const safeX = Math.min(1, Math.max(0, cropXPercent));
    return `crop=ih*9/16:ih:(iw-ih*9/16)*${safeX}:0,scale=1080:1920:flags=lanczos`;
}

/**
 * Filtro split-screen 9:16 com tela dividida (face cam em cima + gameplay embaixo).
 *
 * Layout final 1080×1920:
 *   ┌─────────────────────────┐
 *   │       Face Cam          │  1080×956 + 4px borda preta inferior → 1080×960
 *   ├─── ─── ─── ─── ─── ─── ┤  ← linha divisória preta 4px
 *   │       Gameplay          │  1080×960 — crop centralizado
 *   └─────────────────────────┘
 *
 * Divisória: drawbox pinta os últimos 4px do painel superior de preto,
 * criando uma linha de separação visual entre facecam e gameplay.
 *
 * Requer useComplex=true no runFfmpegEncode (usa -filter_complex + -map [out]).
 *
 * @param {number} cropXPercent - posição horizontal do rosto [0.0–1.0]
 * @returns {string} string filter_complex (apenas vídeo — áudio é encadeado externamente)
 */
function buildSplitScreenFilter(cropXPercent) {
    const safeX = Math.min(1, Math.max(0, cropXPercent));
    return [
        // Duplica o stream de vídeo em dois ramos
        `[0:v]split=2[a][b]`,
        // Face cam (painel superior): crop no rosto → scale 1080×960 → linha divisória preta 4px
        `[a]crop=ih*9/8:ih:(iw-ih*9/8)*${safeX}:0,scale=1080:960:flags=lanczos,drawbox=x=0:y=956:w=iw:h=4:color=black:t=fill[top]`,
        // Gameplay (painel inferior): crop centralizado → scale 1080×960
        `[b]crop=ih*9/8:ih:(iw-ih*9/8)*0.5:0,scale=1080:960:flags=lanczos[bot]`,
        // Empilha verticalmente → frame final 1080×1920
        `[top][bot]vstack=inputs=2[out]`,
    ].join(';');
}

/**
 * Filtro de fundo desfocado (Blurred Background Padding) para formato 9:16.
 *
 * Técnica profissional que preserva o frame 16:9 COMPLETO sem cortar laterais
 * nem distorcer a proporção. O fundo preenche 1080×1920 com a imagem escalada
 * e desfocada; a camada principal fica centralizada por cima.
 *
 * Pipeline do filter_complex:
 *   [0:v] split → [bg_src] e [fg_src]
 *
 *   [bg_src] scale=-2:1920          → escala pela altura (largura auto, múltiplo de 2)
 *            crop=1080:1920:…       → corta o centro para exatamente 1080×1920
 *            boxblur=20:20          → desfoque pesado (raio 20, 20 passagens)
 *            → [bg]
 *
 *   [fg_src] scale=1080:-2          → largura fixa em 1080px, altura proporcional
 *            → [fg]                   Ex: 1920×1080 → 1080×608  (16:9)
 *
 *   [bg][fg] overlay=(W-w)/2:(H-h)/2  → centraliza fg sobre bg
 *            → [out]
 *
 * Saída rotulada [out] — compatível com runFfmpegEncode(useComplex=true).
 * @returns {string}
 */
function buildBlurredBackgroundFilter() {
    return [
        // Duplica o stream em dois ramos independentes
        '[0:v]split=2[bg_src][fg_src]',
        // Fundo: preenche 1080×1920 e aplica desfoque pesado
        '[bg_src]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0,boxblur=20:20[bg]',
        // Frente: 1080px de largura mantendo proporção original (sem distorção)
        '[fg_src]scale=1080:-2[fg]',
        // Sobrepõe a camada principal centralizada sobre o fundo desfocado
        '[bg][fg]overlay=(W-w)/2:(H-h)/2[out]',
    ].join(';');
}

// ─── Função principal do módulo ──────────────────────────────────────────────

/**
 * Processa um único clipe: obtém URLs do stream, baixa o segmento bruto,
 * detecta o falante ativo com MediaPipe e aplica o crop 9:16 dinâmico.
 * Se o vídeo não tiver rostos ou ASD falhar, usa Gemini como fallback.
 *
 * @param {{
 *   videoUrl: string,
 *   peakTime: number,
 *   title: string,
 *   duration?: number
 * }} peakData
 * @param {number} clipIndex - Número do clip (1-based)
 * @param {number} totalClips
 * @returns {Promise<string>} caminho absoluto do arquivo salvo
 */
export async function processClip(peakData, clipIndex = 1, totalClips = 1) {
    const { videoUrl, peakTime, title, duration: vodDuration, outputBaseDir: overrideOutputDir } = peakData;
    const bufferSeconds = parseInt(process.env.CLIP_BUFFER_SECONDS || '30', 10);
    const maxDuration = parseInt(process.env.CLIP_DURATION_MAX || '35', 10);
    const baseOutputDir = path.resolve(overrideOutputDir || process.env.OUTPUT_DIR || './output');
    const useAsd = process.env.USE_ASD !== 'false'; // ativado por padrão

    const videoFolder = sanitizeFilename(title);
    const outputDir = path.join(baseOutputDir, videoFolder);

    const startTime = Math.max(0, peakTime - bufferSeconds);
    const rawEndTime = vodDuration
        ? Math.min(vodDuration, peakTime + bufferSeconds)
        : peakTime + bufferSeconds;
    // Limita a duração máxima para manter clipes no intervalo ideal (15–35s para Shorts/TikTok)
    const endTime = Math.min(rawEndTime, startTime + maxDuration);
    const clipDurationSec = endTime - startTime;

    logger.info(
        `Clip ${clipIndex}/${totalClips} — Intervalo: ${formatDuration(startTime)} → ${formatDuration(endTime)} ` +
        `(buffer de ${bufferSeconds}s antes e depois)`
    );

    ensureOutputDir(outputDir);

    const filename = buildOutputFilename(peakTime, clipIndex, totalClips);
    const outputPath = path.join(outputDir, filename);

    if (fs.existsSync(outputPath)) {
        logger.warn(`Clipe já existe, pulando: ${filename}`);
        return outputPath;
    }

    const { videoStreamUrl, audioStreamUrl } = await getStreamUrls(videoUrl);

    // Split-screen desativado por padrão — ativar com SPLIT_SCREEN=true no .env
    const useSplitScreen = process.env.SPLIT_SCREEN === 'true';
    // Fundo desfocado: preserva frame 16:9 completo sem cortar laterais.
    // Tem precedência sobre split-screen quando ativo.
    // Ativar com BLUR_BACKGROUND=true no .env
    const useBlurBackground = process.env.BLUR_BACKGROUND === 'true';

    // ── Caminho ASD: download local → MediaPipe → crop dinâmico single-panel ──
    // Só é necessário quando ASD está ativo, split-screen desabilitado E blur
    // desabilitado, pois ASD gera sendcmd para crop frame-a-frame.
    if (useAsd && !useSplitScreen && !useBlurBackground) {
        const tempRaw  = path.join(os.tmpdir(), `asd-raw-${Date.now()}.mp4`);
        const tempCmds = path.join(os.tmpdir(), `asd-cmds-${Date.now()}.txt`);
        try {
            await downloadRawClip(videoStreamUrl, audioStreamUrl, startTime, endTime, tempRaw);
            const { success, meta } = await runAsdPython(tempRaw, tempCmds);

            if (success && meta) {
                logger.info('[ASD] Crop dinâmico MediaPipe aplicado (single-panel).');
                const cropFilter = buildDynamicCropFilter(tempCmds, meta);
                await runFfmpegEncode(tempRaw, outputPath, cropFilter, false, clipDurationSec);
                await addCaptionsToClip(outputPath);
                logger.success(`Clipe ${clipIndex}/${totalClips} salvo: ${filename}`);
                return outputPath;
            }
            // ASD falhou → cai no caminho principal abaixo
            logger.warn('[ASD] Análise falhou — usando fallback.');
        } finally {
            cleanupFiles(tempRaw, tempCmds, tempCmds + '.json');
        }
    }

    // ── Caminho principal: direto do CDN sem arquivo temporário ───────────────
    // Blur background: face detection desnecessária (frame completo preservado).
    // Split-screen: detecta posição do rosto para o crop do painel superior.
    const cropX = (!useBlurBackground && useSplitScreen)
        ? await detectCropXPosition(videoStreamUrl, startTime, endTime)
        : 0.5;

    if (useBlurBackground) {
        // ── Modo: Fundo Desfocado ─────────────────────────────────────────────
        // Frame 16:9 original preservado na íntegra. Barras laterais/superiores
        // preenchidas com a própria imagem desfocada — sem crop agressivo.
        logger.info('[Blur-BG] Fundo desfocado 1080×1920 — frame original sem cortes...');
        await runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, 0.5, true);
    } else if (useSplitScreen) {
        // ── Modo: Split-Screen ────────────────────────────────────────────────
        logger.info(`[Split-Screen] Rosto em X=${(cropX * 100).toFixed(0)}% — cortando direto do CDN...`);
        await runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, cropX, false);
    } else {
        // ── Modo: Crop Estático ───────────────────────────────────────────────
        logger.info('[Static] Crop 9:16 centralizado.');
        const tempRaw = path.join(os.tmpdir(), `raw-${Date.now()}.mp4`);
        try {
            await downloadRawClip(videoStreamUrl, audioStreamUrl, startTime, endTime, tempRaw);
            await runFfmpegEncode(tempRaw, outputPath, buildStaticCropFilter(cropX), false, clipDurationSec);
        } finally {
            cleanupFiles(tempRaw);
        }
    }

    // Adiciona legendas automáticas (se ADD_CAPTIONS=true no .env)
    await addCaptionsToClip(outputPath);

    logger.success(`Clipe ${clipIndex}/${totalClips} salvo: ${filename}`);
    return outputPath;
}

/**
 * Inicializa os binários — deve ser chamado uma vez antes de processar os clipes.
 */
export function initBinaries() {
    configureBinaries();
}
