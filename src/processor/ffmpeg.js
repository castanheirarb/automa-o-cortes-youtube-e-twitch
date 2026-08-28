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
import crypto from 'node:crypto';
import { logger } from '../utils/logger.js';
import { sanitizeFilename, formatDuration } from '../utils/helpers.js';
import { addCaptionsToClip } from './captions.js';
import { isolateVocals, shouldIsolateVocals } from './vocal-isolate.js';
import { detectCropXPosition, detectSceneLayout } from './face-detect.js';
import { findSmartEndTime } from './smart-boundary.js';

// ─── Erros customizados ───────────────────────────────────────────────────────

/**
 * Lançado quando o yt-dlp encontra um VOD subscriber-only na Twitch.
 * Capturado pelo capturer.js para acionar o fallback omnichannel (Twitch → YouTube).
 */
export class SubscriberOnlyError extends Error {
    constructor(message) {
        super(message);
        this.name = 'SubscriberOnlyError';
    }
}

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
    // O Live Monitor (src/capturer/live-monitor.js) passa o caminho do arquivo
    // JÁ GRAVADO localmente como videoUrl (a live foi capturada com antecedência,
    // não precisa resolver URL nenhuma). Sem essa checagem, o código tentava rodar
    // `yt-dlp --get-url` num caminho de arquivo local, o que sempre falhava.
    // Arquivo local já tem vídeo+áudio no mesmo stream — não precisa de audioStreamUrl.
    if (!/^https?:\/\//i.test(videoUrl) && fs.existsSync(videoUrl)) {
        logger.info('[FFmpeg] videoUrl é um arquivo local — pulando resolução via yt-dlp.');
        return { videoStreamUrl: videoUrl, audioStreamUrl: null };
    }

    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    logger.info('Obtendo URLs de stream via yt-dlp...');

    const ytDlpArgs = [
        '--get-url',
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/bestvideo+bestaudio/best',
        '--no-playlist',
    ];

    // Para VODs subscriber-only da Twitch, usa arquivo de cookies exportado.
    // Exporte uma vez: instale "Get cookies.txt LOCALLY" no Chrome, acesse twitch.tv logado
    // e salve como ./twitch-cookies.txt na raiz do projeto.
    if (videoUrl.includes('twitch.tv')) {
        const cookiesFile = path.resolve('./twitch-cookies.txt');
        if (fs.existsSync(cookiesFile)) {
            ytDlpArgs.push('--cookies', cookiesFile);
        }
    }

    ytDlpArgs.push(videoUrl);

    let stdout;
    try {
        ({ stdout } = await execFileAsync(ytDlp, ytDlpArgs));
    } catch (err) {
        // Detecta VOD subscriber-only para acionar fallback omnichannel
        const output = (err.stderr || '') + (err.stdout || '') + err.message;
        if (output.includes('subscriber-only') || output.includes('must be logged into an account')) {
            throw new SubscriberOnlyError(`VOD subscriber-only: ${videoUrl}`);
        }
        throw err;
    }

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
async function downloadRawClip(videoStreamUrl, audioStreamUrl, startTime, endTime, tempPath) {
    const duration = endTime - startTime;
    logger.info(`Baixando segmento bruto (${formatDuration(duration)}) para análise ASD...`);

    // Vídeo e áudio em URLs separadas (YouTube) exigem alinhamento explícito.
    // Com `-c copy`, o seek do VÍDEO cai no keyframe anterior ao ponto pedido
    // (até ~5s antes), enquanto o ÁUDIO é buscado com precisão. O resultado era
    // um clipe começando com vários segundos SEM SOM. Aqui o áudio é buscado a
    // partir do instante real onde o keyframe caiu, deixando os dois em sincronia.
    if (audioStreamUrl) {
        return downloadRawClipAligned(videoStreamUrl, audioStreamUrl, startTime, duration, tempPath);
    }

    // Stream único (Twitch/HLS ou arquivo local): ambos já saem alinhados.
    return new Promise((resolve, reject) => {
        ffmpeg()
            .input(videoStreamUrl)
            .inputOptions([`-ss ${startTime}`, `-t ${duration}`])
            .outputOptions(['-c copy', '-avoid_negative_ts make_zero', '-y'])
            .output(tempPath)
            .on('end', resolve)
            .on('error', (err) => reject(new Error(`FFmpeg (download bruto): ${err.message}`)))
            .run();
    });
}

/**
 * Baixa vídeo e áudio de URLs separadas garantindo sincronia:
 *   1. Baixa o vídeo com -copyts (preserva os timestamps originais)
 *   2. Descobre em que instante o keyframe realmente caiu
 *   3. Baixa o áudio a partir DESSE instante
 *   4. Junta os dois (sem re-encode)
 */
async function downloadRawClipAligned(videoStreamUrl, audioStreamUrl, startTime, duration, tempPath) {
    const ffmpegBin  = process.env.FFMPEG_PATH?.trim()  || 'ffmpeg';
    const ffprobeBin = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
    const stamp = Date.now();
    const tmpV = path.join(os.tmpdir(), `raw-v-${stamp}.mp4`);
    const tmpA = path.join(os.tmpdir(), `raw-a-${stamp}.m4a`);

    try {
        await execFileAsync(ffmpegBin, [
            '-ss', String(startTime), '-t', String(duration), '-i', videoStreamUrl,
            '-map', '0:v:0', '-c', 'copy', '-copyts', '-y', tmpV,
        ], { maxBuffer: 100 * 1024 * 1024 });

        const { stdout } = await execFileAsync(ffprobeBin, [
            '-v', 'error', '-select_streams', 'v:0',
            '-show_entries', 'stream=start_time', '-of', 'csv=p=0', tmpV,
        ]);
        const realStart = parseFloat(stdout.trim());

        if (!Number.isFinite(realStart)) {
            throw new Error('não foi possível ler o timestamp inicial do vídeo');
        }
        const drift = startTime - realStart;
        if (Math.abs(drift) > 0.05) {
            logger.info(`[Sync] Keyframe caiu ${drift.toFixed(2)}s antes do ponto pedido — buscando áudio a partir de ${realStart.toFixed(2)}s.`);
        }

        await execFileAsync(ffmpegBin, [
            '-ss', String(realStart), '-t', String(duration), '-i', audioStreamUrl,
            '-map', '0:a:0', '-c', 'copy', '-y', tmpA,
        ], { maxBuffer: 100 * 1024 * 1024 });

        await execFileAsync(ffmpegBin, [
            '-i', tmpV, '-i', tmpA,
            '-map', '0:v:0', '-map', '1:a:0',
            '-c', 'copy', '-avoid_negative_ts', 'make_zero', '-shortest', '-y', tempPath,
        ], { maxBuffer: 100 * 1024 * 1024 });
    } finally {
        cleanupFiles(tmpV, tmpA);
    }
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
function runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, cropXPercent = 0.5, layoutMode = 'split') {
    const duration = endTime - startTime;
    const safeX = Math.min(1, Math.max(0, cropXPercent));
    const useBlurBackground = layoutMode === 'blur';
    const useHybrid = layoutMode === 'hybrid';

    // Fade-out de 1.5s no final do áudio
    const fadeD = 1.5;
    const fadeOutStart = Math.max(0, duration - fadeD).toFixed(2);

    // Quando yt-dlp retorna dois streams separados, o áudio está no input 1.
    // Quando retorna um stream único (best), o áudio está em [0:a].
    const audioRef = audioStreamUrl ? '[1:a]' : '[0:a]';

    const modeLabel = layoutMode;
    logger.step(`Cortando ${modeLabel} 1080×1920 (${formatDuration(duration)})...`);

    // Cadeia de áudio compartilhada entre os dois modos
    const audioChain =
        `${audioRef}aresample=async=1:min_hard_comp=0.100000:first_pts=0,` +
        `loudnorm=I=-16:TP=-1.5:LRA=11,` +
        `atrim=duration=${duration},asetpts=PTS-STARTPTS,` +
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

        if (useHybrid) {
            // ── Modo: Híbrido "cortes de gameplay" ────────────────────────────
            // O frame 16:9 COMPLETO (1080×608, pixels nativos, zero upscale)
            // ancorado no terço superior; o restante do quadro é área de design
            // — fundo desfocado escurecido onde as legendas queimadas ficam
            // grandes e legíveis, sem cobrir o jogo.
            //
            //  y=380 posiciona o painel logo abaixo do topo seguro do Shorts
            //  (onde o app sobrepõe título/avatar) e deixa ~930px livres embaixo.
            const PANEL_Y = parseInt(process.env.HYBRID_PANEL_Y || '380', 10);
            filterStr = [
                `[0:v]split=2[bg_src][fg_src]`,
                // Fundo: cobre 1080×1920, desfoque pesado + escurecido (destaca o painel)
                `[bg_src]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0,boxblur=24:24,` +
                    `eq=brightness=-0.18:saturation=0.7,setsar=1/1[bg]`,
                // Frente: gameplay em largura nativa 1080 (16:9 → 1080×608)
                `[fg_src]scale=1080:-2,setsar=1/1[fg]`,
                // Painel ancorado no topo + linha divisória sutil
                `[bg][fg]overlay=(W-w)/2:${PANEL_Y},` +
                    `drawbox=x=0:y=${PANEL_Y - 3}:w=iw:h=3:color=white@0.35:t=fill,` +
                    `setsar=1/1,trim=duration=${duration},setpts=PTS-STARTPTS[outv]`,
                audioChain,
            ].join(';');
        } else if (useBlurBackground) {
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
                `[bg_src]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0,boxblur=20:20,setsar=1/1[bg]`,
                // Frente: 1080px de largura, proporção original preservada
                `[fg_src]scale=1080:-2,setsar=1/1[fg]`,
                // Centraliza a camada principal sobre o fundo desfocado → 1080×1920
                `[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1/1,trim=duration=${duration},setpts=PTS-STARTPTS[outv]`,
                // Áudio: resync + loudnorm + fade-out suave
                audioChain,
            ].join(';');
        } else {
            // ── Modo: Split-Screen (dois painéis 1080×960 empilhados) ─────────
            // Facecam (topo): crop 9:8 centrado na posição do rosto → 1080×960
            // Gameplay (fundo): crop 9:8 centralizado → 1080×960
            // vstack → 1080×1920
            const normalize =
                `scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,` +
                `crop=1920:1080,setsar=1/1`;

            filterStr = [
                `[0:v]split=2[v1][v2]`,
                `[v1]${normalize},` +
                    `crop=ih*9/8:ih:(iw-ih*9/8)*${safeX}:0,` +
                    `scale=1080:960:flags=lanczos,setsar=1/1,` +
                    `drawbox=x=0:y=956:w=iw:h=4:color=black:t=fill[top]`,
                `[v2]${normalize},` +
                    `crop=ih*9/8:ih:(iw-ih*9/8)*0.5:0,` +
                    `scale=1080:960:flags=lanczos,setsar=1/1[bot]`,
                `[top][bot]vstack=inputs=2,trim=duration=${duration},setpts=PTS-STARTPTS[outv]`,
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
                // Força 8-bit: sem isso, fonte 10-bit (comum em VODs/lives) vira
                // High 10 profile, que a maioria dos players (Windows, navegadores)
                // não decodifica — "não é possível abrir o vídeo".
                '-pix_fmt yuv420p',
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
                // Força 8-bit: sem isso, fonte 10-bit (comum em VODs/lives) vira
                // High 10 profile, que a maioria dos players (Windows, navegadores)
                // não decodifica — "não é possível abrir o vídeo".
                '-pix_fmt yuv420p',
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
                // Força 8-bit: sem isso, fonte 10-bit (comum em VODs/lives) vira
                // High 10 profile, que a maioria dos players (Windows, navegadores)
                // não decodifica — "não é possível abrir o vídeo".
                '-pix_fmt yuv420p',
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
        `scale=1080:1920:flags=lanczos,setsar=1/1`
    );
}

/**
 * Filtro de crop 9:16 estático (fallback quando ASD falha ou não há rostos).
 * cropXPercent: posição horizontal [0.0=esq, 0.5=centro, 1.0=dir].
 */
function buildStaticCropFilter(cropXPercent) {
    const safeX = Math.min(1, Math.max(0, cropXPercent));
    return `crop=ih*9/16:ih:(iw-ih*9/16)*${safeX}:0,scale=1080:1920:flags=lanczos,setsar=1/1`;
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
    const normalize =
        `scale=1920:1080:force_original_aspect_ratio=increase:flags=lanczos,` +
        `crop=1920:1080,setsar=1/1`;
    return [
        `[0:v]split=2[a][b]`,
        `[a]${normalize},` +
            `crop=ih*9/8:ih:(iw-ih*9/8)*${safeX}:0,` +
            `scale=1080:960:flags=lanczos,setsar=1/1,` +
            `drawbox=x=0:y=956:w=iw:h=4:color=black:t=fill[top]`,
        `[b]${normalize},` +
            `crop=ih*9/8:ih:(iw-ih*9/8)*0.5:0,` +
            `scale=1080:960:flags=lanczos,setsar=1/1[bot]`,
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
        '[bg_src]scale=-2:1920,crop=1080:1920:(iw-1080)/2:0,boxblur=20:20,setsar=1/1[bg]',
        // Frente: 1080px de largura mantendo proporção original (sem distorção)
        '[fg_src]scale=1080:-2,setsar=1/1[fg]',
        // Sobrepõe a camada principal centralizada sobre o fundo desfocado
        '[bg][fg]overlay=(W-w)/2:(H-h)/2,setsar=1/1[out]',
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
    const { videoUrl, peakTime, title, duration: vodDuration, outputBaseDir: overrideOutputDir, skipCaptions = false, layout: personaLayout = null, niche = 'default' } = peakData;
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
    let endTime = Math.min(rawEndTime, startTime + maxDuration);

    // Filename/outputPath só dependem de peakTime, não do endTime final — checa
    // cache ANTES de resolver stream/transcrever, pra não gastar API à toa
    // num clipe que já existe.
    const filename = buildOutputFilename(peakTime, clipIndex, totalClips);
    const outputPath = path.join(outputDir, filename);

    if (fs.existsSync(outputPath)) {
        logger.warn(`Clipe já existe, pulando: ${filename}`);
        return outputPath;
    }

    // Precisa das URLs de stream já aqui (antes do endTime final) pro
    // smart-boundary poder transcrever a janela de áudio e ajustar onde o
    // clipe termina antes de decidir a duração definitiva.
    const { videoStreamUrl, audioStreamUrl } = await getStreamUrls(videoUrl);

    // Ajusta o fim do clipe pra cair no fechamento natural do assunto (ex.:
    // uma oração que termina com "amém"), em vez de cortar num instante fixo
    // que pode interromper o que está sendo dito. Fallback silencioso: se
    // falhar, endTime permanece o original.
    endTime = await findSmartEndTime({
        audioStreamUrl: audioStreamUrl || videoStreamUrl,
        startTime,
        targetEndTime: endTime,
        hardMaxEndTime: vodDuration ? Math.min(vodDuration, startTime + maxDuration + 60) : startTime + maxDuration + 60,
    });

    const clipDurationSec = endTime - startTime;

    // Guarda de qualidade: pico na borda do vídeo gera clipe truncado.
    // (Os picos de heatmap já são filtrados na seleção — isto cobre os demais
    // caminhos: chat replay da Twitch, radar, live monitor, etc.)
    const minClipSec = parseInt(process.env.CLIP_DURATION_MIN || '11', 10);
    if (clipDurationSec < minClipSec) {
        throw new Error(
            `Clipe muito curto (${clipDurationSec.toFixed(1)}s < ${minClipSec}s) — pico a ${peakTime.toFixed(0)}s, na borda do vídeo.`
        );
    }

    logger.info(
        `Clip ${clipIndex}/${totalClips} — Intervalo: ${formatDuration(startTime)} → ${formatDuration(endTime)} ` +
        `(buffer de ${bufferSeconds}s antes e depois)`
    );

    ensureOutputDir(outputDir);

    // ── Layout do clipe ───────────────────────────────────────────────────────
    // Prioridade: campo `layout` da persona (personas.js) > variáveis do .env.
    // Modos: 'hybrid' (gameplay 16:9 no topo + área de design),
    //        'blur'   (frame 16:9 completo centralizado sobre fundo desfocado),
    //        'split'  (facecam em cima + gameplay embaixo),
    //        'asd'    (crop 9:16 dinâmico seguindo quem fala — padrão).
    const envLayout = process.env.BLUR_BACKGROUND === 'true' ? 'blur'
        : process.env.SPLIT_SCREEN === 'true' ? 'split'
        : 'asd';
    let layout = personaLayout || envLayout;

    // 'auto': decide pelo conteúdo do quadro (webcam grande → asd; jogo em
    // tela cheia → hybrid). O mesmo canal alterna os dois tipos de cena, então
    // fixar o formato por persona erra metade dos clipes.
    if (layout === 'auto') {
        logger.step('[Layout] Modo automático — classificando a cena...');
        try {
            layout = await detectSceneLayout(videoStreamUrl, startTime, endTime);
        } catch (err) {
            logger.warn(`[Layout] Detecção falhou (${err.message}) — usando "asd".`);
            layout = 'asd';
        }
    } else if (personaLayout) {
        logger.info(`[Layout] Modo "${layout}" definido pela persona.`);
    }

    const useSplitScreen = layout === 'split';
    const useBlurBackground = layout === 'blur';
    const useHybrid = layout === 'hybrid';

    // ── Caminho ASD: download local → MediaPipe → crop dinâmico single-panel ──
    // Só é necessário quando ASD está ativo, split-screen desabilitado E blur
    // desabilitado, pois ASD gera sendcmd para crop frame-a-frame.
    if (useAsd && !useSplitScreen && !useBlurBackground && !useHybrid) {
        const tempRaw  = path.join(os.tmpdir(), `asd-raw-${Date.now()}.mp4`);
        const tempCmds = path.join(os.tmpdir(), `asd-cmds-${Date.now()}.txt`);
        try {
            await downloadRawClip(videoStreamUrl, audioStreamUrl, startTime, endTime, tempRaw);
            const { success, meta } = await runAsdPython(tempRaw, tempCmds);

            if (success && meta) {
                logger.info('[ASD] Crop dinâmico MediaPipe aplicado (single-panel).');
                const cropFilter = buildDynamicCropFilter(tempCmds, meta);
                await runFfmpegEncode(tempRaw, outputPath, cropFilter, false, clipDurationSec);
                await discardIfTooShort(outputPath, minClipSec);
                if (discardIfDuplicate(outputPath)) {
                    throw new Error('Clipe idêntico a outro já gerado desta fonte — descartado.');
                }
                if (!skipCaptions) await addCaptionsToClip(outputPath, { niche, layout });
                if (shouldIsolateVocals(niche)) await isolateVocals(outputPath);
                await warnIfMostlyDark(outputPath, clipDurationSec);
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
    // Split-screen: detecta posição horizontal do rosto para o crop do painel superior.
    const cropX = useSplitScreen
        ? await detectCropXPosition(videoStreamUrl, startTime, endTime)
        : 0.5;

    if (useHybrid) {
        // ── Modo: Híbrido (gameplay 16:9 no topo + área de design) ────────────
        logger.info('[Hybrid] Painel 16:9 nativo no topo + área de legendas — sem upscale.');
        await runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, 0.5, 'hybrid');
    } else if (useBlurBackground) {
        // ── Modo: Fundo Desfocado ─────────────────────────────────────────────
        // Frame 16:9 original preservado na íntegra. Barras laterais/superiores
        // preenchidas com a própria imagem desfocada — sem crop agressivo.
        logger.info('[Blur-BG] Fundo desfocado 1080×1920 — frame original sem cortes...');
        await runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, 0.5, 'blur');
    } else if (useSplitScreen) {
        // ── Modo: Split-Screen ────────────────────────────────────────────────
        logger.info(`[Split-Screen] Rosto em X=${(cropX * 100).toFixed(0)}% — cortando direto do CDN...`);
        await runFfmpegCut(videoStreamUrl, audioStreamUrl, startTime, endTime, outputPath, cropX, 'split');
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

    // Confere a duração REAL do arquivo. O guard lá em cima valida o intervalo
    // PEDIDO; se o FFmpeg truncar a saída (stream instável, erro de rede), o
    // arquivo sai com 1–2s e passaria batido para a fila.
    await discardIfTooShort(outputPath, minClipSec);

    // Última barreira contra clipes gêmeos: se este arquivo ficou idêntico a
    // outro já gerado na mesma pasta, descarta agora — antes das legendas e
    // antes de entrar na fila do poster.
    if (discardIfDuplicate(outputPath)) {
        throw new Error('Clipe idêntico a outro já gerado desta fonte — descartado.');
    }

    // Adiciona legendas automáticas (se ADD_CAPTIONS=true no .env).
    // skipCaptions: fontes que já têm legenda queimada (ex.: cortes de
    // concorrentes via Trend Hunter) não recebem uma segunda camada.
    if (!skipCaptions) await addCaptionsToClip(outputPath, { niche, layout });
    if (shouldIsolateVocals(niche)) await isolateVocals(outputPath);
    await warnIfMostlyDark(outputPath, clipDurationSec);

    logger.success(`Clipe ${clipIndex}/${totalClips} salvo: ${filename}`);
    return outputPath;
}

/**
 * Apaga e rejeita o clipe se a duração REAL do arquivo ficar abaixo do mínimo.
 */
/**
 * Diagnóstico não-bloqueante: roda o blackdetect do FFmpeg e loga um aviso se
 * uma fração grande do clipe ficou praticamente preta (cena sem nada visível
 * — ex.: pico caiu num trecho de jogo escuro sem luz, ou numa transição/
 * cutaway sem ninguém em quadro). NÃO descarta o clipe — decidir se um trecho
 * escuro é "de propósito" (jogo de terror) ou "morto" (nada acontecendo) é
 * uma decisão de conteúdo, não técnica; isso só torna o problema visível nos
 * logs pra revisão manual, em vez de passar batido.
 */
async function warnIfMostlyDark(outputPath, clipDurationSec) {
    try {
        const ffmpegBin = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
        let stderr = '';
        try {
            const res = await execFileAsync(ffmpegBin, [
                '-i', outputPath,
                '-vf', 'blackdetect=d=0.5:pic_th=0.98',
                '-an', '-f', 'null', '-',
            ], { maxBuffer: 10 * 1024 * 1024 });
            stderr = res.stderr || '';
        } catch (err) {
            stderr = err.stderr || ''; // ffmpeg -f null costuma sair 0, mas usa o stderr mesmo se não
        }

        const durations = [...stderr.matchAll(/black_duration:([\d.]+)/g)].map((m) => parseFloat(m[1]));
        const totalBlack = durations.reduce((s, d) => s + d, 0);

        if (clipDurationSec > 0 && totalBlack / clipDurationSec > 0.4) {
            const pct = Math.round((totalBlack / clipDurationSec) * 100);
            logger.warn(`[FFmpeg] ⚠️ Clipe com ~${pct}% do tempo em tela praticamente preta (${path.basename(outputPath)}) — pico pode ter caído numa cena sem conteúdo visível. Revisão manual recomendada.`);
        }
    } catch (err) {
        logger.warn(`[FFmpeg] Checagem de brilho falhou (${err.message}) — ignorando.`);
    }
}

async function discardIfTooShort(outputPath, minClipSec) {
    const real = await probeVideoDuration(outputPath).catch(() => null);
    if (real !== null && real < minClipSec) {
        try { fs.unlinkSync(outputPath); } catch { /* ignora */ }
        throw new Error(`Arquivo gerado ficou com ${real.toFixed(1)}s (mínimo ${minClipSec}s) — descartado.`);
    }
}

/**
 * Compara o clipe recém-gerado com os demais .mp4 da mesma pasta (tamanho
 * exato + hash de amostras). Se for duplicata, apaga e retorna true.
 */
function discardIfDuplicate(outputPath) {
    try {
        const dir = path.dirname(outputPath);
        const size = fs.statSync(outputPath).size;
        const twins = fs.readdirSync(dir)
            .filter((f) => f.toLowerCase().endsWith('.mp4') && path.join(dir, f) !== outputPath)
            .map((f) => path.join(dir, f))
            .filter((f) => { try { return fs.statSync(f).size === size; } catch { return false; } });

        if (twins.length === 0) return false;

        const h = sampleHash(outputPath);
        for (const twin of twins) {
            if (sampleHash(twin) === h) {
                logger.warn(`[FFmpeg] Clipe idêntico a "${path.basename(twin)}" — descartando ${path.basename(outputPath)}.`);
                try { fs.unlinkSync(outputPath); } catch { /* ignora */ }
                return true;
            }
        }
        return false;
    } catch (err) {
        logger.warn(`[FFmpeg] Checagem de duplicata falhou: ${err.message} — mantendo o clipe.`);
        return false;
    }
}

function sampleHash(filePath) {
    const size = fs.statSync(filePath).size;
    const hash = crypto.createHash('sha1').update(String(size));
    const SAMPLE = 1024 * 1024;
    const fd = fs.openSync(filePath, 'r');
    try {
        const buf = Buffer.alloc(SAMPLE);
        for (const off of [0, Math.max(0, Math.floor(size / 2)), Math.max(0, size - SAMPLE)]) {
            const read = fs.readSync(fd, buf, 0, Math.min(SAMPLE, size - off), off);
            if (read > 0) hash.update(buf.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

// ─── Probe de duração via ffprobe ─────────────────────────────────────────────

export async function probeVideoDuration(filePath, retries = 3) {
    const ffprobePath = process.env.FFPROBE_PATH?.trim() || 'ffprobe';
    for (let attempt = 1; attempt <= retries; attempt++) {
        try {
            const { stdout } = await execFileAsync(ffprobePath, [
                '-v', 'error',
                '-show_entries', 'format=duration',
                '-of', 'json',
                filePath,
            ]);
            const duration = parseFloat(JSON.parse(stdout).format?.duration) || null;
            if (duration !== null) return duration;
        } catch { /* tenta de novo abaixo */ }

        // Arquivos grandes (ex: compilações de vários lances) às vezes ainda não
        // terminaram de ser sincronizados no disco no instante em que o processo
        // do FFmpeg sinaliza "end" — um ffprobe imediato pode ler um arquivo
        // incompleto. Retry com pequeno atraso resolve sem mascarar falha real.
        if (attempt < retries) await new Promise((r) => setTimeout(r, 500 * attempt));
    }
    return null;
}

// ─── Utilitários locais para o Sports VOD Miner (trim + concat sem re-encode) ──
//
// Usados para derivar o clipe curto (Short) a partir do clipe largo já baixado
// (sem nova chamada ao yt-dlp) e para montar a compilação "vídeo longo" com
// vários lances do mesmo VOD. Ambos usam stream-copy (-c copy) — rápido e sem
// perda de qualidade, já que o re-encode "de verdade" acontece depois em
// processLocalClip (blur pad + legendas).

/**
 * Corta um trecho de um arquivo já local via stream-copy.
 * @param {string} inputPath
 * @param {number} startSec  - offset dentro do PRÓPRIO arquivo (não do vídeo original)
 * @param {number} durationSec
 * @param {string} outputPath
 */
export function trimLocalFile(inputPath, startSec, durationSec, outputPath) {
    return new Promise((resolve, reject) => {
        ffmpeg(inputPath)
            .inputOptions([`-ss ${Math.max(0, startSec)}`])
            .outputOptions([`-t ${durationSec}`, '-c copy', '-avoid_negative_ts make_zero', '-y'])
            .output(outputPath)
            .on('end', () => resolve(outputPath))
            .on('error', (err) => reject(new Error(`FFmpeg (trim local): ${err.message}`)))
            .run();
    });
}

/**
 * Concatena múltiplos arquivos locais (mesma fonte/codec) em um único vídeo.
 * @param {string[]} filePaths - ordem cronológica
 * @param {string} outputPath
 */
export function concatLocalClips(filePaths, outputPath) {
    const listFile = path.join(os.tmpdir(), `concat-${Date.now()}.txt`);
    const listContent = filePaths
        .map((f) => `file '${path.resolve(f).replace(/'/g, "'\\''")}'`)
        .join('\n');
    fs.writeFileSync(listFile, listContent, 'utf8');

    return new Promise((resolve, reject) => {
        const cleanup = () => { try { fs.unlinkSync(listFile); } catch { /* ignora */ } };
        ffmpeg()
            .input(listFile)
            .inputOptions(['-f concat', '-safe 0'])
            .outputOptions(['-c copy', '-y'])
            .output(outputPath)
            .on('end', () => { cleanup(); resolve(outputPath); })
            .on('error', (err) => { cleanup(); reject(new Error(`FFmpeg (concat local): ${err.message}`)); })
            .run();
    });
}

// ─── Pipeline para arquivo local (Sports Radar) ───────────────────────────────

/**
 * Processa um arquivo de vídeo LOCAL para 9:16 com fundo desfocado.
 * Usado pelo Sports Radar após captura DVR — nunca chama yt-dlp nem ASD.
 * Sempre aplica blur background e pula detecção de rosto.
 *
 * @param {string} inputPath     - Caminho absoluto do arquivo bruto capturado via DVR
 * @param {string} outputBaseDir - Diretório base onde a subpasta será criada
 * @param {string} [title]       - Nome usado na subpasta e no arquivo de saída
 * @returns {Promise<string>}    - Caminho absoluto do arquivo 9:16 processado
 */
export async function processLocalClip(inputPath, outputBaseDir, title = 'clip') {
    const outputDir = path.join(path.resolve(outputBaseDir), sanitizeFilename(title));
    ensureOutputDir(outputDir);

    const outputPath = path.join(outputDir, `${sanitizeFilename(title)}-${Date.now()}.mp4`);
    const duration = await probeVideoDuration(inputPath);

    logger.info(`[FFmpeg/Local] Convertendo para 9:16 blur: ${path.basename(inputPath)}`);

    const blurFilter = buildBlurredBackgroundFilter();
    await runFfmpegEncode(inputPath, outputPath, blurFilter, true, duration);
    await addCaptionsToClip(outputPath, { niche: 'default', layout: 'blur' });

    logger.success(`[FFmpeg/Local] Pronto: ${path.basename(outputPath)}`);
    return outputPath;
}

/**
 * Inicializa os binários — deve ser chamado uma vez antes de processar os clipes.
 */
export function initBinaries() {
    configureBinaries();
}
