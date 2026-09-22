// src/canal-da-fe/long-video.js
// Vídeo longo diário do Canal da Fé (A Fé Move Montanhas): baixa uma live de
// oração INTEIRA (não recorta) de um dos canais terceiros abaixo para
// ./output/longos-fe — o ciclo diário do poster sobe com metadados próprios
// gerados por transcrição (express-poster, sem #shorts), no perfil dedicado
// do canal religioso.
//
// Mudança de 19/09/2026: até aqui a fonte era sempre o canal do Bispo Bruno
// Leonardo — foi o que gerou o copyright strike de 24/08/2026 (Soares Music,
// música de fundo) e, mais grave, os strikes seguintes vieram do PRÓPRIO
// Bispo objetando ao reuso do conteúdo dele (ver memória
// project_canal_da_fe_copyright_strike). Trocado por canais de oração de
// terceiros (presencial/virtual, achados por pesquisa) que o usuário avaliou
// como conteúdo republicável (interpretação de fair use / lives públicas —
// NÃO é autorização por escrito dos donos, risco residual real).
//
// Único canal ativado (@OracoesPoderosasOficial) foi confirmado visualmente em
// 19/09/2026 (47,4 mil inscritos, ativo diariamente). Teste real de ponta a
// ponta rodado no mesmo dia (node src/canal-da-fe/long-video.js): baixou,
// isolou voz e gerou o .mp4 sem erro. Ao adicionar um novo canal em
// PRAYER_LIVE_CHANNELS, confirme visualmente antes (porte pequeno/médio, sem
// produção musical/monetização pesada) — mesmo cuidado que outras personas
// com handle "pendente de confirmação visual" em src/capturer/personas.js.
//
// Mesmo padrão de src/trend-hunter/long-replicate.js, mas a fonte é sempre
// um dos canais de PRAYER_LIVE_CHANNELS (fetchYouTubeVideoList), nunca
// concorrentes aleatórios.
//
// .env:
//   LONG_VIDEO_FE_MIN_DURATION  duração mínima do vídeo-fonte em s (default 300 = 5min)
//   LONG_VIDEO_FE_MAX_DURATION  duração máxima em s (default 3600 = 60min)
//
// Registry próprio (scheduler/long-video-fe-registry.json) evita repostar a
// mesma live, mesmo trocando de canal-fonte entre execuções.

import 'dotenv/config';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';
import { fetchYouTubeVideoList } from '../capturer/fetcher.js';
import { sanitizeFilename } from '../utils/helpers.js';
import { isolateVocals } from '../processor/vocal-isolate.js';

const execFileAsync = promisify(execFile);

// Confirmado visualmente em 19/09/2026 (navegador real, não só busca):
// - @OracoesPoderosasOficial: 47,4 mil inscritos, ativo diariamente, vídeos
//   de ~12-14min ("Oração da Manhã"), poucas views — perfil condizente.
// Candidato descartado na mesma checagem:
// - @anaclararocha_exercitodedeus ("Grupo de Oração Exército de Deus"): NÃO
//   é um perfil de baixo risco — 2,09 MILHÕES de inscritos, assinatura paga
//   (R$11,99/mês), site próprio, vídeos produzidos com música/colaborações
//   ("Forrozinho do Céu"). Operação comercial grande, com o mesmo tipo de
//   risco de música que gerou o strike original da Soares Music — não usar
//   sem achar substituto de porte pequeno/médio e sem produção musical.
//
// Ampliação de 19/09/2026 — a pedido do usuário, priorizando IGREJAS (canal
// oficial de instituição) em vez de pessoa física, mesma disciplina de
// confirmação visual:
// - Igreja da Cidade (@ictv.online): 141 mil inscritos, ativa diariamente,
//   estava AO VIVO no momento da checagem, vídeos de 2-53min (cabem no filtro
//   de duração padrão). Tem assinatura opcional (R$3,99/mês) mas é o modelo
//   comum de apoiador de igreja, não produção comercial como o candidato
//   descartado acima.
// - Congregação Cristã no Brasil: 2,34 MILHÕES de inscritos, canal oficial da
//   denominação, cultos ao vivo regulares (qua+dom, com variantes
//   vídeo/áudio/Libras), sem assinatura paga, sem produção musical/comercial.
//   Cultos duram ~1h22-1h53 — por isso LONG_VIDEO_FE_MAX_DURATION foi
//   elevado pra 7200s (2h) no .env, senão esses vídeos nunca passariam no
//   filtro padrão de 3600s.
// Candidato rejeitado na mesma pesquisa: "TV Oração" (@TVOração) — inativo,
// último vídeo com vários meses (não dá pra contar como fonte confiável).
//
// Fonte PRINCIPAL (19/09/2026, a pedido do usuário): Congregação Cristã no
// Brasil vem primeiro na lista — a busca por candidatos percorre os canais
// nesta ordem e empilha os elegíveis, então o primeiro canal da lista é
// quem efetivamente prioriza a fila de download. Os outros dois só entram
// quando a Congregação não tiver vídeo elegível novo (registry) na janela
// de duração.
const PRAYER_LIVE_CHANNELS = [
    // /streams, não /videos — esse canal não expõe aba "Vídeos" padrão
    // (yt-dlp retorna "This channel does not have a videos tab"); /streams
    // funciona e lista os cultos ao vivo passados normalmente.
    { url: 'https://www.youtube.com/channel/UC4cfCNEpwLIuYnxdDKUMPYg/streams', label: 'Congregação Cristã no Brasil' },
    { url: 'https://www.youtube.com/@OracoesPoderosasOficial/videos', label: 'Orações Poderosas Oficial (Nivaldo Bildhauer)' },
    { url: 'https://www.youtube.com/@ictv.online/videos', label: 'Igreja da Cidade (ICTV)' },
];

const REGISTRY_FILE = path.resolve('./scheduler/long-video-fe-registry.json');
const LONG_FE_DIR = path.resolve(process.env.LONG_VIDEOS_FE_DIR || './output/longos-fe');

function loadRegistry() {
    try { return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8')); }
    catch { return []; }
}

function registerAttempted(videoId) {
    const registry = loadRegistry();
    if (!registry.includes(videoId)) {
        registry.push(videoId);
        fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
        fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
    }
}

async function downloadFullVideo(video, destPath) {
    const ytDlp = process.env.YTDLP_PATH?.trim() || 'yt-dlp';
    logger.step(`[LongVideoFé] Baixando vídeo completo (${Math.round(video.duration / 60)}min): "${video.title}"...`);
    await execFileAsync(ytDlp, [
        '--extractor-args', 'youtube:player_client=android',
        '--format', 'bestvideo[ext=mp4][height<=1080]+bestaudio[ext=m4a]/best[ext=mp4]/best',
        '--merge-output-format', 'mp4',
        '--no-playlist',
        '-o', destPath,
        video.videoUrl,
    ], { maxBuffer: 20 * 1024 * 1024 });
    if (!fs.existsSync(destPath)) throw new Error('yt-dlp terminou mas o arquivo não existe.');
    return destPath;
}

/**
 * Baixa uma live de oração inteira de um dos canais em PRAYER_LIVE_CHANNELS
 * para ./output/longos-fe. Percorre os canais em ordem a cada chamada (não
 * fixo num só) para não depender de uma única fonte.
 * @returns {Promise<string|null>} caminho do .mp4 baixado, ou null se nada elegível
 */
export async function getPrayerLongVideo({ maxAttempts = 3, listSize = 15 } = {}) {
    const minDur = parseInt(process.env.LONG_VIDEO_FE_MIN_DURATION || '300', 10);
    const maxDur = parseInt(process.env.LONG_VIDEO_FE_MAX_DURATION || '3600', 10);
    const registry = loadRegistry();

    let candidates = [];
    for (const channel of PRAYER_LIVE_CHANNELS) {
        logger.info(`[LongVideoFé] Buscando vídeos recentes de "${channel.label}"...`);
        try {
            const videos = await fetchYouTubeVideoList(channel.url, listSize);
            const eligible = videos.filter((v) =>
                !registry.includes(v.id) &&
                v.duration !== null &&
                v.duration >= minDur &&
                v.duration <= maxDur
            );
            candidates.push(...eligible);
        } catch (err) {
            logger.error(`[LongVideoFé] Falha ao listar vídeos de "${channel.label}": ${err.message}`);
        }
    }

    if (candidates.length === 0) {
        logger.warn('[LongVideoFé] Nenhum vídeo elegível nos canais de oração configurados (duração/registry).');
        return null;
    }

    fs.mkdirSync(LONG_FE_DIR, { recursive: true });

    for (const video of candidates.slice(0, maxAttempts)) {
        registerAttempted(video.id); // antes do download: falha não vira loop
        const destPath = path.join(LONG_FE_DIR, `${sanitizeFilename(video.title)}.mp4`);
        try {
            await downloadFullVideo(video, destPath);
            // Mitigação do copyright strike de 2026-08-24 (Soares Music
            // Digital): remove música de fundo antes de entrar na fila de
            // postagem. Nunca lança — sem Demucs configurado, segue com o
            // áudio original (ver src/processor/vocal-isolate.js).
            await isolateVocals(destPath);
            logger.success(`[LongVideoFé] Vídeo longo pronto: ${path.basename(destPath)}`);
            return destPath;
        } catch (err) {
            logger.error(`[LongVideoFé] Falha ao baixar "${video.title}": ${err.message}`);
        }
    }

    return null;
}

// Execução standalone: node src/canal-da-fe/long-video.js
if (process.argv[1] && path.basename(process.argv[1]) === 'long-video.js') {
    const p = await getPrayerLongVideo();
    process.exitCode = p ? 0 : 1;
}
