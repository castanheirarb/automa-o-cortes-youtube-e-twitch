// src/processor/captions.js
// Adiciona legendas automáticas e sincronizadas aos clipes.
// Fluxo: extrai áudio → Groq Whisper (timestamps por PALAVRA) → sanitiza →
// gera .ass com destaque de palavra sincronizado (estilo "karaokê", igual
// CapCut/Opus Clip) → FFmpeg burn. Se a API não devolver timestamps por
// palavra por algum motivo, cai para linhas estáticas por segmento (mesmo
// resultado visual de antes, sem destaque, mas com o mesmo arquivo .ass —
// nunca quebra a legenda inteira por causa disso).
//
// Estilo (cor/tamanho) varia por NICHO da persona, e a posição vertical
// (MarginV) varia por LAYOUT do clipe — ver NICHE_STYLES/LAYOUT_MARGIN.
//
// Sanitização de profanidade é aplicada PALAVRA A PALAVRA antes de montar as
// tags de karaokê, garantindo que o texto queimado no vídeo seja
// advertiser-friendly sem perder o alinhamento de tempo por palavra.
//
// Ativado por ADD_CAPTIONS=true no .env

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import ffmpeg from 'fluent-ffmpeg';
import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';
import { sanitizeCaptions } from '../../poster/content-filter.js';

// ─── Estilo por nicho ─────────────────────────────────────────────────────────
// `highlight` = cor da palavra ATUAL (sendo falada agora), `base` = cor das
// palavras ainda não faladas na mesma linha. Formato ASS: &HAABBGGRR.
// fontSize já em pixels finais (PlayResY=1920 declarado explicitamente no
// [Script Info] — sem PlayRes explícito o libass usa uma resolução de
// referência implícita bem menor, então o "13" antigo (pensado pra esse
// caminho implícito) renderizava bem maior do que o valor sugere; com
// PlayRes explícito o valor passa a ser literal em pixels).
const NICHE_STYLES = {
    religioso: { highlight: '&H003CC8FF', base: '&H00FFFFFF', fontSize: 78 }, // dourado suave
    infantil:  { highlight: '&H009314FF', base: '&H00FFFFFF', fontSize: 86 }, // rosa/magenta vibrante, um pouco maior
    gaming:    { highlight: '&H00FFFF00', base: '&H00FFFFFF', fontSize: 78 }, // ciano elétrico
    react:     { highlight: '&H0000FFFF', base: '&H00FFFFFF', fontSize: 78 }, // amarelo (original)
    podcast:   { highlight: '&H0000FFFF', base: '&H00FFFFFF', fontSize: 78 },
    fitness:   { highlight: '&H0000FFFF', base: '&H00FFFFFF', fontSize: 78 },
    gta6:      { highlight: '&H00FF00FF', base: '&H00FFFFFF', fontSize: 78 }, // rosa/magenta neon (identidade visual GTA VI)
    default:   { highlight: '&H0000FFFF', base: '&H00FFFFFF', fontSize: 78 },
};

function getNicheStyle(niche) {
    return NICHE_STYLES[niche] || NICHE_STYLES.default;
}

// ─── Posição vertical por layout ──────────────────────────────────────────────
// MarginV=180 foi calibrado especificamente pro split-screen (empurra a
// legenda pro centro da facecam, acima da linha divisória). Os outros layouts
// não têm essa obstrução no meio do quadro — usam uma margem menor, mais
// perto da base, mas ainda longe o bastante da borda pra não cortar em
// player com barra de UI sobreposta.
const LAYOUT_MARGIN = {
    split: 180,
    hybrid: 150,
    blur: 110,
    asd: 110,
};

function getLayoutMargin(layout) {
    return LAYOUT_MARGIN[layout] ?? 140;
}

// ─── Helpers de tempo ─────────────────────────────────────────────────────────

/** Formata segundos para o timestamp do ASS: H:MM:SS.CC (centésimos) */
function toAssTime(seconds) {
    const total = Math.max(0, seconds);
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = Math.floor(total % 60);
    const cs = Math.round((total % 1) * 100);
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
}

// ─── 1. Extração de áudio do clipe ───────────────────────────────────────────

function extractAudio(videoPath) {
    const audioPath = path.join(os.tmpdir(), `cc_cap_${Date.now()}.mp3`);
    return new Promise((resolve, reject) => {
        ffmpeg(videoPath)
            .noVideo()
            .audioCodec('libmp3lame')
            .audioBitrate('64k')
            .audioChannels(1)
            .output(audioPath)
            .on('end', () => resolve(audioPath))
            .on('error', reject)
            .run();
    });
}

// ─── 2. Transcrição com Groq Whisper (timestamps por segmento E por palavra) ──

export async function transcribeWithTimestamps(audioPath, language = 'pt') {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada no .env');

    const groq = new Groq({ apiKey });

    const response = await groq.audio.transcriptions.create({
        file: fs.createReadStream(audioPath),
        model: process.env.GROQ_WHISPER_MODEL || 'whisper-large-v3-turbo',
        language,
        response_format: 'verbose_json',
        timestamp_granularities: ['word', 'segment'],
    });

    return { segments: response.segments ?? [], words: response.words ?? [] };
}

// ─── 3. Sanitização palavra-a-palavra (preserva alinhamento de tempo) ─────────
// sanitizeCaptions() opera sobre texto livre (troca termo ofensivo por
// equivalente limpo, ou "***"). Rodando por PALAVRA em vez do texto inteiro,
// garantimos que a contagem de tokens nunca muda — essencial pra manter cada
// palavra colada no timestamp correto do Whisper.
function sanitizeWord(word) {
    const clean = sanitizeCaptions(word).trim();
    return clean || word; // nunca deixa a palavra sumir (quebraria o karaokê)
}

// ─── 3b. Sanidade dos timestamps do Whisper ───────────────────────────────────
// Em áudio ruidoso (torcida/narração de transmissão esportiva, múltiplas vozes
// sobrepostas), o Whisper às vezes devolve uma "palavra" com duração absurda
// (start/end cobrindo quase o clipe inteiro) — um artefato de transcrição, não
// uma palavra real de 10-30s. Isso travava a legenda visível do início ao fim
// do vídeo (bug real observado em cortes de futebol: mesma legenda estática
// o clipe inteiro). Nenhuma palavra falada dura mais que ~2s; descarta o que
// exceder isso ANTES de agrupar em linhas — line[0].start/line[-1].end nunca
// mais herdam um timestamp contaminado.
const MAX_WORD_DURATION_SEC = 2;

export function filterReliableWords(words) {
    return words.filter((w) => {
        const dur = w.end - w.start;
        return dur > 0 && dur <= MAX_WORD_DURATION_SEC;
    });
}

// ─── 4. Agrupa palavras em linhas curtas (ritmo viral) ────────────────────────
// Mesmo ritmo de antes (~3 palavras/linha), mas agora baseado nos timestamps
// reais de PALAVRA do Whisper — quebra também numa pausa grande (>0.6s),
// pra não colar duas frases sem relação na mesma linha.
export function groupWordsIntoLines(words, maxWordsPerLine = 3, maxGapSec = 0.6) {
    const lines = [];
    let current = [];

    for (const w of words) {
        if (current.length > 0) {
            const gap = w.start - current[current.length - 1].end;
            if (current.length >= maxWordsPerLine || gap > maxGapSec) {
                lines.push(current);
                current = [];
            }
        }
        current.push(w);
    }
    if (current.length > 0) lines.push(current);
    return lines;
}

// ─── 5. Monta o .ass com destaque de palavra sincronizado (karaokê) ──────────

function buildAssHeader(style, marginV) {
    // fontName é sobrescrevível (default 'Impact', inalterado pros nichos
    // existentes) — necessário pra conteúdo em CJK, já que Impact não tem
    // glifos de chinês/japonês/coreano (ver bilibili/capture.js).
    const fontName = style.fontName || 'Impact';
    return `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${style.fontSize},${style.highlight},${style.base},&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,4,1,2,40,40,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;
}

/** Uma linha com destaque de palavra: {\k<centésimos>}palavra por token. */
function buildKaraokeLine(lineWords) {
    let text = '';
    let prevEnd = lineWords[0].start;
    for (const w of lineWords) {
        const gapCs = Math.max(0, Math.round((w.start - prevEnd) * 100));
        const durCs = Math.max(1, Math.round((w.end - w.start) * 100)) + gapCs;
        text += `{\\k${durCs}}${sanitizeWord(w.word.trim())} `;
        prevEnd = w.end;
    }
    return text.trim();
}

// Rede de segurança final contra timestamp contaminado: mesmo já filtrando
// palavras individuais suspeitas (filterReliableWords), nada garante que o
// Whisper não devolva um SEGMENTO inteiro com duração absurda no mesmo tipo
// de áudio ruidoso. Nenhuma linha de karaokê (≤3 palavras) precisa de mais de
// alguns segundos na tela; um segmento (pode agrupar várias frases) recebe
// uma folga maior, mas ainda limitada — sem isso, um timestamp errado deixa
// a legenda "grudada" na tela pelo resto do clipe.
const MAX_LINE_DURATION_SEC = 6;
const MAX_SEGMENT_DURATION_SEC = 12;

function clampEnd(startSec, endSec, maxDurationSec) {
    return Math.min(endSec, startSec + maxDurationSec);
}

function buildAssFromWords(words, style, marginV) {
    const lines = groupWordsIntoLines(words);
    let events = '';
    for (const line of lines) {
        const startSec = line[0].start;
        const endSec = clampEnd(startSec, line[line.length - 1].end, MAX_LINE_DURATION_SEC);
        const start = toAssTime(startSec);
        const end = toAssTime(endSec);
        const text = buildKaraokeLine(line);
        events += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}\n`;
    }
    return buildAssHeader(style, marginV) + events;
}

/** Fallback sem timestamp por palavra: linha estática por segmento (3 palavras/linha, sem destaque). */
function buildAssFromSegments(segments, style, marginV) {
    let events = '';
    for (const seg of segments) {
        const words = seg.text.trim().split(/\s+/).filter(Boolean).map(sanitizeWord);
        const chunks = [];
        for (let i = 0; i < words.length; i += 3) chunks.push(words.slice(i, i + 3).join(' '));
        const startSec = seg.start;
        const endSec = clampEnd(startSec, seg.end, MAX_SEGMENT_DURATION_SEC);
        const start = toAssTime(startSec);
        const end = toAssTime(endSec);
        const text = chunks.join('\\N'); // \N = quebra de linha dentro do mesmo evento ASS
        events += `Dialogue: 0,${start},${end},Default,,0,0,0,,${text}\n`;
    }
    return buildAssHeader(style, marginV) + events;
}

// ─── 6. Queima as legendas no vídeo via FFmpeg ────────────────────────────────

function burnSubtitles(videoPath, assPath, outputPath) {
    return new Promise((resolve, reject) => {
        const assEscaped = assPath
            .replace(/\\/g, '/')
            .replace(/:/g, '\\:');

        ffmpeg(videoPath)
            .videoFilter(`subtitles='${assEscaped}'`)
            .videoCodec('libx264')
            .outputOptions(['-crf 18', '-b:v 5M', '-preset fast', '-movflags +faststart'])
            .audioCodec('copy')
            .output(outputPath)
            .on('start', () => logger.info('[Captions] Queimando legendas no vídeo...'))
            .on('progress', (p) => {
                if (p.percent) process.stdout.write(`\r  ⏳ Legendas: ${Math.min(p.percent, 100).toFixed(1)}%   `);
            })
            .on('end', () => { process.stdout.write('\n'); resolve(); })
            .on('error', (err) => { process.stdout.write('\n'); reject(err); })
            .run();
    });
}

// ─── Pipeline Principal ───────────────────────────────────────────────────────

/**
 * Adiciona legendas automáticas e sincronizadas ao clipe (in-place), com
 * destaque de palavra sincronizado (estilo karaokê) sempre que o Whisper
 * devolver timestamps por palavra. Só executa se ADD_CAPTIONS=true no .env.
 *
 * @param {string} videoPath - Caminho absoluto do .mp4 já cortado
 * @param {{ niche?: string, layout?: string }} [opts]
 *   @param {string} [opts.niche]  Nicho da persona (ver personas.js) — define cor/tamanho da legenda
 *   @param {string} [opts.layout] Layout do clipe (asd/blur/hybrid/split) — define posição vertical
 * @returns {Promise<string>} Mesmo caminho, agora com legendas queimadas
 */
export async function addCaptionsToClip(videoPath, { niche = 'default', layout = 'asd', fontName = null, language = 'pt', skipCaptions = false } = {}) {
    if (process.env.ADD_CAPTIONS !== 'true') return videoPath;
    if (skipCaptions) {
        logger.info('[Captions] Fonte provavelmente já tem legenda/letra queimada — pulando nossa legenda.');
        return videoPath;
    }

    logger.step('[Captions] Gerando legendas automáticas com Groq Whisper...');

    let audioPath = null;
    let assPath = null;
    const tempOut = videoPath.replace(/\.mp4$/i, '_sub.mp4');
    const style = fontName ? { ...getNicheStyle(niche), fontName } : getNicheStyle(niche);
    const marginV = getLayoutMargin(layout);

    try {
        // 1. Extrai áudio
        audioPath = await extractAudio(videoPath);

        // 2. Transcreve com timestamps por palavra (e por segmento, como fallback)
        const { segments, words } = await transcribeWithTimestamps(audioPath, language);
        if (!segments.length && !words.length) {
            logger.warn('[Captions] Nenhum segmento encontrado — pulando legendas.');
            return videoPath;
        }

        const reliableWords = filterReliableWords(words);
        if (words.length > 0 && reliableWords.length < words.length) {
            logger.warn(`[Captions] ${words.length - reliableWords.length}/${words.length} palavra(s) com timestamp implausível (áudio ruidoso?) — descartadas.`);
        }

        let assContent;
        if (reliableWords.length > 0) {
            logger.info(`[Captions] ${reliableWords.length} palavra(s) com timestamp — destaque sincronizado ativado (nicho: ${niche}).`);
            assContent = buildAssFromWords(reliableWords, style, marginV);
        } else {
            logger.info(`[Captions] Sem timestamp por palavra confiável — usando linhas estáticas por segmento (${segments.length} segmento(s)).`);
            assContent = buildAssFromSegments(segments, style, marginV);
        }

        // 3. Escreve o .ass
        assPath = path.join(os.tmpdir(), `cc_cap_${Date.now()}.ass`);
        fs.writeFileSync(assPath, assContent, 'utf-8');

        // 4. Queima legendas
        await burnSubtitles(videoPath, assPath, tempOut);

        // 5. Substitui o original
        fs.unlinkSync(videoPath);
        fs.renameSync(tempOut, videoPath);

        logger.success(`[Captions] Legendas adicionadas: ${path.basename(videoPath)}`);
        return videoPath;

    } catch (err) {
        logger.warn(`[Captions] Falha ao gerar legendas: ${err.message}. Vídeo sem legenda mantido.`);
        if (fs.existsSync(tempOut)) fs.unlinkSync(tempOut);
        return videoPath;

    } finally {
        if (audioPath && fs.existsSync(audioPath)) fs.unlinkSync(audioPath);
        if (assPath && fs.existsSync(assPath)) fs.unlinkSync(assPath);
    }
}
