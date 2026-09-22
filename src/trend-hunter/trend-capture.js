// src/trend-hunter/trend-capture.js
// Persona virtual "Trend Hunter": vasculha os principais canais de cortes
// concorrentes, identifica o vídeo em alta (mais views recentes) e gera
// clipes dele via pipeline normal (heatmap → processClip).
//
// Entra no round-robin do poster como uma persona a mais, então os posts
// intercalam naturalmente: seus cortes → ... → corte em alta → seus cortes...
//
// Uso standalone: node src/trend-hunter/trend-capture.js
//
// .env:
//   TREND_CORTES_CHANNELS      canais a vasculhar (vírgula) — default abaixo
//   TREND_WEIGHT               turnos por ciclo no round-robin (default 1)
//   TREND_SCAN_PER_CHANNEL     vídeos recentes analisados por canal (default 10)
//   TREND_MAX_SOURCE_DURATION  duração máx. do vídeo-fonte em s (default 3600)

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import Groq from 'groq-sdk';
import { logger } from '../utils/logger.js';
import { capturePersona } from '../capturer/capturer.js';

const execFileAsync = promisify(execFile);

const DEFAULT_CORTES_CHANNELS = [
    'https://www.youtube.com/@CortesdoFlow/videos',
    'https://www.youtube.com/@CortesdoInteligencia/videos',
    'https://www.youtube.com/@PodpahCortes/videos',
];

// Filtro de assunto por palavra-chave no TÍTULO — os 3 canais acima são de
// "cortes" genéricos (podcast/entrevista), então às vezes o vídeo mais visto
// do dia é sobre um assunto fora do tema do canal (já aconteceu 2x: conteúdo
// político publicado sem relação nenhuma com o canal, tanto num Short quanto
// no vídeo longo — os dois consomem esta mesma função). Termos institucionais
// genéricos, sem citar partido/político específico, pra não parecer viés —
// o objetivo é só manter o canal no tema de cortes de entretenimento, não
// tomar posição em nada.
const DEFAULT_BLOCKLIST_KEYWORDS = [
    'política', 'eleição', 'eleições', 'eleitoral', 'presidente', 'presidência',
    'stf', 'supremo tribunal', 'congresso nacional', 'câmara dos deputados', 'senado federal',
    'ministro', 'ministério', 'candidato', 'candidatura', 'urna eletrônica', 'tse',
];

function getBlocklistKeywords() {
    const raw = process.env.TREND_BLOCKLIST_KEYWORDS?.trim();
    if (!raw) return DEFAULT_BLOCKLIST_KEYWORDS;
    const parsed = raw.split(',').map((k) => k.trim().toLowerCase()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_BLOCKLIST_KEYWORDS;
}

function isOffTopic(title) {
    const t = (title || '').toLowerCase();
    return getBlocklistKeywords().some((kw) => t.includes(kw));
}

// ─── Segunda camada: classificação por IA (título em qualquer idioma) ────────
// O filtro por palavra-chave acima só pega termos institucionais em
// português — um título em inglês sobre política brasileira ("IS BRAZIL'S
// FISCAL BOMB ABOUT TO EXPLODE? - KIM KATAGUIRI AND GLENN GREENWALD",
// reproduzido em teste real) passa direto. Só chamado nos candidatos FINAIS
// (dentro de maxAttempts em captureTrendClip/replicateTrendingLongVideo), não
// nos ~30 vídeos escaneados — poucas chamadas por ciclo. Groq com
// reasoning_effort:'low' (mesmo padrão de poster/metadata.js — sem isso o
// modelo estoura max_tokens com raciocínio interno). Falha aberta: se a IA
// cair, deixa passar (o filtro de palavra-chave já rodou antes) em vez de
// travar a captura inteira por causa de uma checagem extra.
export async function isOffTopicByAI(title) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) return false;

    try {
        const groq = new Groq({ apiKey });
        const completion = await groq.chat.completions.create({
            model: process.env.GROQ_COPY_MODEL || 'openai/gpt-oss-120b',
            // reasoning_effort:'low' NÃO elimina o raciocínio interno do
            // gpt-oss-120b, só reduz — com max_tokens baixo o modelo gasta
            // tudo raciocinando e corta antes de emitir SIM/NAO
            // (finish_reason:"length", content vazio, reproduzido em teste
            // real). Mesma lição documentada em poster/metadata.js: margem
            // generosa, não o mínimo teórico da resposta esperada.
            reasoning_effort: 'low',
            max_tokens: 300,
            temperature: 0,
            messages: [
                {
                    role: 'system',
                    content: 'Você classifica títulos de vídeo pra um canal de cortes de entretenimento (podcast/reação/games). Responda APENAS "SIM" se o título for sobre política, eleições, governo, ou notícia/polêmica institucional — mesmo em outro idioma. Responda APENAS "NAO" para qualquer outro assunto (entretenimento, jogos, esporte, humor, relacionamento, etc.).',
                },
                { role: 'user', content: title },
            ],
        });
        const raw = completion.choices[0]?.message?.content?.trim().toUpperCase() ?? '';
        return raw.startsWith('SIM');
    } catch (err) {
        logger.warn(`[TrendCapture] Classificação por IA falhou (${err.message}) — seguindo sem essa checagem extra.`);
        return false;
    }
}

const REGISTRY_FILE = path.resolve('./scheduler/trend-registry.json');

export const TREND_PERSONA = {
    name: 'trendhunter',
    displayName: 'Trend Hunter (cortes em alta)',
    platform: 'youtube',
    clipsPerRun: parseInt(process.env.TREND_CLIPS_PER_RUN || '3', 10),
    niche: 'podcast',
    weight: parseInt(process.env.TREND_WEIGHT || '1', 10),
    // Cortes de concorrentes já vêm com legendas queimadas — não sobrepor as nossas
    skipCaptions: true,
    // Fonte mista (gameplay/podcast já em 9:16 ou 16:9): preserva o frame inteiro
    layout: 'blur',
};

// ─── Registry: evita recapturar o mesmo vídeo-fonte ──────────────────────────

function loadRegistry() {
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function registerAttempted(videoId) {
    const registry = loadRegistry();
    if (!registry.includes(videoId)) {
        registry.push(videoId);
        fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }
}

// ─── Scout: lista os vídeos recentes dos canais de cortes, ordena por views ──

function getCortesChannels() {
    const raw = process.env.TREND_CORTES_CHANNELS?.trim();
    if (!raw) return DEFAULT_CORTES_CHANNELS;
    const parsed = raw.split(',').map((c) => c.trim()).filter(Boolean);
    return parsed.length > 0 ? parsed : DEFAULT_CORTES_CHANNELS;
}

async function scanChannel(channelUrl, perChannel) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    const { stdout } = await execFileAsync(ytDlp, [
        '--dump-json', '--flat-playlist',
        '--playlist-end', String(perChannel),
        channelUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });

    return stdout.trim().split('\n').filter(Boolean).map((line) => {
        const v = JSON.parse(line);
        return {
            id: v.id,
            url: `https://www.youtube.com/watch?v=${v.id}`,
            title: v.title,
            views: v.view_count ?? 0,
            duration: v.duration ?? 0,
            channel: channelUrl,
        };
    });
}

export async function scoutTrendingCortes() {
    const channels = getCortesChannels();
    const perChannel = parseInt(process.env.TREND_SCAN_PER_CHANNEL || '10', 10);
    logger.info(`[TrendCapture] Vasculhando ${channels.length} canais de cortes (${perChannel} vídeos/canal)...`);

    const all = [];
    for (const channel of channels) {
        try {
            all.push(...await scanChannel(channel, perChannel));
        } catch (err) {
            logger.warn(`[TrendCapture] Falha ao vasculhar ${channel}: ${err.message}`);
        }
    }

    const filtered = all.filter((v) => !isOffTopic(v.title));
    const blocked = all.length - filtered.length;
    if (blocked > 0) {
        logger.warn(`[TrendCapture] ${blocked} vídeo(s) descartado(s) por assunto fora do tema (política/institucional).`);
    }

    filtered.sort((a, b) => b.views - a.views);
    logger.success(`[TrendCapture] ${filtered.length} vídeos encontrados — top: "${filtered[0]?.title}" (${filtered[0]?.views} views)`);
    return filtered;
}

// ─── Captura: baixa e corta o vídeo em alta via pipeline normal ──────────────

/**
 * Identifica o corte em alta e gera clipes dele em ./output/trendhunter/.
 * Tenta os próximos candidatos se o topo não tiver heatmap/falhar.
 * @returns {{ clipsGenerated: number, source?: object }}
 */
export async function captureTrendClip({ maxAttempts = 4 } = {}) {
    const maxDuration = parseInt(process.env.TREND_MAX_SOURCE_DURATION || '3600', 10);
    const registry = loadRegistry();

    const candidates = (await scoutTrendingCortes()).filter((v) =>
        !registry.includes(v.id) &&
        v.duration >= 120 &&           // ignora Shorts do concorrente (sem material p/ cortar)
        v.duration <= maxDuration
    );

    if (candidates.length === 0) {
        logger.warn('[TrendCapture] Nenhum candidato novo (todos já capturados ou fora dos critérios).');
        return { clipsGenerated: 0 };
    }

    for (const video of candidates.slice(0, maxAttempts)) {
        if (await isOffTopicByAI(video.title)) {
            logger.warn(`[TrendCapture] "${video.title}" classificado como fora do tema (IA) — descartando.`);
            registerAttempted(video.id);
            continue;
        }

        logger.step(`[TrendCapture] 🔥 Em alta: "${video.title}" (${video.views} views) — capturando...`);
        registerAttempted(video.id); // registra antes: falha não vira loop infinito

        const result = await capturePersona(TREND_PERSONA, {
            dynamicTarget: {
                platform: 'youtube',
                url: video.url,
                title: video.title,
                duration: video.duration,
            },
        });

        if (result.clipsGenerated > 0) {
            logger.success(`[TrendCapture] ${result.clipsGenerated} clipe(s) do corte em alta prontos para a fila.`);
            return { ...result, source: video };
        }
        logger.warn(`[TrendCapture] "${video.title}" não gerou clipes — tentando próximo candidato...`);
    }

    logger.error('[TrendCapture] Nenhum candidato gerou clipes nesta rodada.');
    return { clipsGenerated: 0 };
}

// ─── Execução standalone: npm run trend:capture ──────────────────────────────

if (process.argv[1] && path.basename(process.argv[1]) === 'trend-capture.js') {
    const { initBinaries } = await import('../processor/ffmpeg.js');
    initBinaries();
    const r = await captureTrendClip();
    process.exitCode = r.clipsGenerated > 0 ? 0 : 1;
}
