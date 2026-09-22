// bilibili/run.js
// Orquestrador manual do projeto Bilibili — pega a próxima fonte não
// processada (sources.js + BILIBILI_SOURCES), baixa e corta, gera metadados em
// chinês, publica. Roda por comando (npm run bilibili:run), não por cron —
// projeto ainda em validação, sem lugar no start.js.
//
// Uso: node bilibili/run.js [url] [--dry-run]
//   sem argumento → pega a primeira fonte de getSources() ainda não tentada
//   com argumento → processa essa URL específica
//   --dry-run     → faz tudo (download, corte por pico, legenda, metadados)
//                   MENOS o upload — sempre preferir isto pra testar
//                   (mesmo padrão do poster:dry do canal principal)

import 'dotenv/config';
import { getSources } from './sources.js';
import { scanTrendSignal } from './trend-radar.js';
import { pickChannelVideo, pickExperimentalBrVideo, pickRobloxVideo } from './scout.js';
import { captureFromSource, fetchSourceInfo, looksAlreadyCaptioned } from './capture.js';
import { generateChineseMetadata } from './metadata.js';
import { uploadToBilibili } from './uploader.js';
import { extractBestFrame } from '../src/processor/face-detect.js';
import fs from 'node:fs';
import { isAlreadyAttempted, registerAttempt, registerPublished } from './registry.js';
import { logger } from './logger.js';

// Teste ocasional de clipe BR (ver sources.js, EXPERIMENTAL_BR_CHANNELS) —
// fração dos ciclos que tenta a fonte BR em vez do pool chinês normal.
// Padrão baixo de propósito: é amostragem pra validar a hipótese, não uma
// migração — decisão de 03/09/2026.
const BR_EXPERIMENT_RATE = parseFloat(process.env.BILIBILI_BR_EXPERIMENT_RATE || '0.15');

/**
 * Ordem de prioridade: URL forçada > fonte individual pendente (sources.js /
 * BILIBILI_SOURCES) > pool PRIORITÁRIO de Roblox (ROBLOX_CHANNELS, pedido do
 * usuário 05/09/2026 — checado a cada ciclo, não por sorteio) > [sorteio]
 * teste BR ocasional > vídeo mais visto ainda não tentado nos canais curados
 * chineses (ver bilibili/scout.js).
 * @returns {Promise<{ url: string, isBrExperiment: boolean, isRoblox: boolean } | null>}
 */
async function pickNextSource(forceUrl) {
    if (forceUrl) return { url: forceUrl, isBrExperiment: false, isRoblox: false };

    const sources = getSources();
    const pendingSource = sources.find((url) => !isAlreadyAttempted(url));
    if (pendingSource) return { url: pendingSource, isBrExperiment: false, isRoblox: false };

    const robloxVideo = await pickRobloxVideo();
    if (robloxVideo) return { url: robloxVideo.url, isBrExperiment: false, isRoblox: true };

    if (Math.random() < BR_EXPERIMENT_RATE) {
        const brVideo = await pickExperimentalBrVideo(); // defaults já calibrados pra Shorts, ver scout.js
        if (brVideo) return { url: brVideo.url, isBrExperiment: true, isRoblox: false };
        logger.info('[Bilibili/Run] Sorteio pegou o teste BR, mas nenhum candidato elegível — seguindo pro pool chinês normal.');
    }

    // capture.js corta em torno do pico de chat quando a fonte é VOD de live
    // (ver chat-peaks.js) — lives reais podem passar de 4-5h (ex.: canal de
    // VTuber validado, ver sources.js), então o teto aqui só existe pra
    // evitar coisa absurda (ex.: maratona de 24h); a proteção real contra
    // processar vídeo INTEIRO sem corte fica em capture.js
    // (BILIBILI_FALLBACK_MAX_DURATION_SEC, só entra em jogo SEM pico).
    const channelVideo = await pickChannelVideo({ minDuration: 30, maxDuration: 6 * 3600 });
    return channelVideo ? { url: channelVideo.url, isBrExperiment: false, isRoblox: false } : null;
}

export async function runOnce({ forceUrl = null, dryRun = false } = {}) {
    // Sinal de tendência — só informativo nesta v1 (poucas fontes curadas
    // manualmente, ainda não há entre-o-quê escolher de verdade). Fica logado
    // pra dar contexto de qual partição está mais quente agora na Bilibili.
    await scanTrendSignal().catch((err) =>
        logger.warn(`[Bilibili/Run] Trend radar falhou (não bloqueia o ciclo): ${err.message}`)
    );

    const picked = await pickNextSource(forceUrl);
    if (!picked) {
        logger.warn('[Bilibili/Run] Nenhuma fonte nova (sources.js, BILIBILI_SOURCES, nem canais curados) — nada a fazer.');
        return { published: false };
    }
    const { url: sourceUrl, isBrExperiment, isRoblox } = picked;
    if (isBrExperiment) {
        logger.step('[Bilibili/Run] 🇧🇷 Ciclo de teste — fonte BR (ver EXPERIMENTAL_BR_CHANNELS em sources.js).');
    }
    if (isRoblox) {
        logger.step('[Bilibili/Run] 🎮 Ciclo prioritário — fonte Roblox (ver ROBLOX_CHANNELS em sources.js).');
    }

    registerAttempt(sourceUrl); // registra ANTES de baixar/publicar (padrão "registra antes de tentar")

    const sourceInfo = await fetchSourceInfo(sourceUrl);
    // Fonte BR/Roblox: força pular nossa legenda — o áudio original não é
    // chinês (português ou inglês), e o pipeline de legenda está fixo em
    // transcrever como chinês (Whisper forçado em 'zh' geraria lixo tentando
    // ler outro idioma como chinês). A aposta em ambos os casos é conteúdo
    // majoritariamente visual, então não depende de legenda pra funcionar.
    const skipCaptions = isBrExperiment || isRoblox || looksAlreadyCaptioned(sourceInfo.title, sourceInfo.description);
    if (skipCaptions && !isBrExperiment && !isRoblox) {
        logger.info(`[Bilibili/Run] "${sourceInfo.title}" parece já ter legenda/letra própria — pulando nossa legenda.`);
    }

    const titleSlug = `clipe-${Date.now()}`;
    const clipPath = await captureFromSource(sourceUrl, titleSlug, { skipCaptions });

    const context = isBrExperiment
        ? `原标题(葡萄牙语，巴西主播反应视频): ${sourceInfo.title}\n原描述: ${sourceInfo.description.slice(0, 300)}\n（这是巴西主播对视觉/非语言内容的真实反应，无需理解葡萄牙语也能看懂——请用中文写标题/简介/标签，强调反应本身的趣味性）`
        : isRoblox
            ? `原标题(英语，Roblox游戏视频): ${sourceInfo.title}\n原描述: ${sourceInfo.description.slice(0, 300)}\n（这是Roblox游戏内容——搞笑/恐怖/沙雕高能时刻，无需理解英语也能看懂游戏画面和梗——请用中文写标题/简介/标签，突出游戏名和这段内容的爆点，标签里可以同时包含"Roblox"和"罗布乐思"两种叫法）`
            : `原标题: ${sourceInfo.title}\n原描述: ${sourceInfo.description.slice(0, 300)}`;
    const metadata = await generateChineseMetadata(context);

    if (dryRun) {
        logger.success('[Bilibili/Run] ✅ DRY-RUN — nada foi publicado. Clipe pronto pra inspecionar:');
        logger.info(`  ${clipPath}`);
        logger.info(`  Título: ${metadata.title}`);
        logger.info(`  Descrição: ${metadata.desc}`);
        logger.info(`  Tags: ${metadata.tags.join(', ')}`);
        return { published: false, dryRun: true, sourceUrl, clipPath, metadata };
    }

    // Capa: reaproveita a MESMA seleção de frame por IA usada no canal principal
    // (face-detect.js — Gemini → Groq → OpenRouter → null) em vez do clique
    // do próprio biliup em algum frame aleatório. Só a ESCOLHA de frame, sem
    // texto/direção de arte (thumbnail.js gera isso em português — misturaria
    // idioma errado numa capa pra público chinês, já que bilibili/metadata.js
    // gera tudo em mandarim). Falha em silêncio: sem capa boa, biliup usa o
    // frame padrão dele mesmo, nunca bloqueia o upload.
    let coverPath = null;
    try {
        coverPath = await extractBestFrame(clipPath);
    } catch (err) {
        logger.warn(`[Bilibili/Run] Seleção de capa por IA falhou (${err.message}) — biliup usa o frame padrão dele.`);
    }

    const { ok, bvid } = await uploadToBilibili(clipPath, metadata.title, metadata.desc, {
        tags: metadata.tags,
        coverPath,
        sourceUrl, // sempre marca como 转载 (reprodução) — nunca 自制 (original), ver uploader.js
    });

    if (coverPath && fs.existsSync(coverPath)) { try { fs.unlinkSync(coverPath); } catch { /* ignora */ } }

    if (ok) {
        registerPublished(sourceUrl, { title: metadata.title, clipPath, bvid });
        logger.success(`[Bilibili/Run] ✅ Ciclo completo — vídeo publicado.${bvid ? ` (${bvid})` : ''}`);
    } else {
        logger.error('[Bilibili/Run] Upload falhou — fonte já fica marcada como tentada (evita loop), verifique manualmente antes de tentar de novo.');
    }

    return { published: ok, sourceUrl, clipPath, metadata, bvid };
}

// ─── Execução: node bilibili/run.js [url] ────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('run.js')) {
    const args = process.argv.slice(2);
    const dryRun = args.includes('--dry-run');
    const forceUrl = args.find((a) => !a.startsWith('--')) || null;
    runOnce({ forceUrl, dryRun })
        .then((r) => { process.exitCode = (r.published || r.dryRun) ? 0 : 1; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
