// src/stock-watcher.js
// Vigia de estoque — roda uma vez e encerra (o start.js reinicia a cada
// STOCK_CHECK_MINUTES). Confere o nível de conteúdo de TODAS as fontes e
// repõe o que estiver abaixo do mínimo:
//
//   • Personas reais (personas.js)  → capturePersona (heatmap/VOD)
//   • Canal da Fé (vídeos gerados)  → generateCanalDaFeVideo (Remotion)
//   • Canal Infantil (gerados)      → generateCanalInfantilVideo (FFmpeg)
//   • Trend Hunter                  → captureTrendClip (corte em alta, futebol)
//   • GTA VI Hunter                 → captureGta6TrendClip (corte em alta, GTA6)
//   • Vídeos longos (output/longos) → replicateTrendingLongVideo (vídeo inteiro)
//   • Vídeo longo Canal da Fé (output/longos-fe) → getPrayerLongVideo (live de oração inteira, canal terceiro)
//   • Vídeo longo Canal Infantil (output/longos-infantil) → getLucasNetoLongVideo
//   • Vídeo longo GTA VI (output/longos-gta6) → getGta6LongVideo
//
// .env:
//   STOCK_MIN_CLIPS       mínimo de clipes por persona (default 3)
//   STOCK_MIN_TREND       mínimo na fila do trendhunter (default 1)
//   STOCK_MIN_GTA6        mínimo na fila do gta6hunter (default 1)
//   STOCK_MIN_LONG        mínimo em output/longos (default 1)
//   STOCK_MIN_LONG_FE     mínimo em output/longos-fe (default 1)
//   STOCK_MIN_LONG_INFANTIL / STOCK_MIN_LONG_GTA6   mínimo dos vídeos longos novos (1)
//   CANALDAFE_MIN_STOCK / CANALINFANTIL_MIN_STOCK   mínimo dos canais gerados (1)
//   STOCK_CHECK_MINUTES   intervalo entre checagens no start.js (default 30)

import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import { PERSONAS } from './capturer/personas.js';
import { capturePersona } from './capturer/capturer.js';
import { initBinaries } from './processor/ffmpeg.js';
import { logger } from './utils/logger.js';

const OUTPUT_BASE = path.resolve(process.env.OUTPUT_DIR || './output');
const LONG_DIR = path.resolve(process.env.LONG_VIDEOS_DIR || './output/longos');
const LONG_FE_DIR = path.resolve(process.env.LONG_VIDEOS_FE_DIR || './output/longos-fe');
const LONG_INFANTIL_DIR = path.resolve(process.env.LONG_VIDEOS_INFANTIL_DIR || './output/longos-infantil');
const LONG_GTA6_DIR = path.resolve(process.env.LONG_VIDEOS_GTA6_DIR || './output/longos-gta6');

const MIN_CLIPS = parseInt(process.env.STOCK_MIN_CLIPS || '3', 10);
const MIN_TREND = parseInt(process.env.STOCK_MIN_TREND || '1', 10);
const MIN_GTA6 = parseInt(process.env.STOCK_MIN_GTA6 || '1', 10);
const MIN_LONG = parseInt(process.env.STOCK_MIN_LONG || '1', 10);
const MIN_LONG_FE = parseInt(process.env.STOCK_MIN_LONG_FE || '1', 10);
const MIN_LONG_INFANTIL = parseInt(process.env.STOCK_MIN_LONG_INFANTIL || '1', 10);
const MIN_LONG_GTA6 = parseInt(process.env.STOCK_MIN_LONG_GTA6 || '1', 10);
const MIN_CANALDAFE = parseInt(process.env.CANALDAFE_MIN_STOCK || '1', 10);
const MIN_CANALINFANTIL = parseInt(process.env.CANALINFANTIL_MIN_STOCK || '1', 10);

function countMp4s(dir) {
    let n = 0;
    try {
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
            if (e.isDirectory()) n += countMp4s(path.join(dir, e.name));
            else if (e.isFile() && e.name.toLowerCase().endsWith('.mp4')) n++;
        }
    } catch { /* pasta inexistente = 0 */ }
    return n;
}

async function main() {
    initBinaries();
    // Fontes conferidas, recontadas no fim para o relatório refletir o estado
    // APÓS as reposições deste ciclo.
    const checked = [];
    let reposicoes = 0;

    // ── Personas reais (inclui o Bispo) ──────────────────────────────────────
    // Personas TikTok são live-only (sem VOD/arquivo acessível pra varrer) —
    // capturePersona() lança "Plataforma desconhecida" pra elas de propósito.
    // O único jeito de gerar clipe delas é pegar a live ao vivo (TikTok Live
    // Monitor, src/capturer/live-monitor-tiktok.js, já roda dentro do
    // start.js) — aqui só puladas, mesmo critério do Scanner em orchestrator.js.
    for (const persona of PERSONAS) {
        const dir = path.join(OUTPUT_BASE, persona.name);
        const count = countMp4s(dir);
        checked.push([persona.name, dir]);
        // Live-only (TikTok): sem VOD pra varrer, capturePersona() lançaria
        // "Plataforma desconhecida" de propósito. Só reporta o nível de
        // estoque acima — reposição real só acontece pegando a live ao vivo
        // (TikTok Live Monitor, já roda dentro do start.js).
        if (persona.platform === 'tiktok') continue;
        if (count >= MIN_CLIPS) continue;

        logger.step(`[Stock] "${persona.displayName}" com ${count}/${MIN_CLIPS} clipes — captando...`);
        try {
            await capturePersona(persona, { force: false, minClips: MIN_CLIPS });
            reposicoes++;
        } catch (err) {
            logger.error(`[Stock] Captação de "${persona.displayName}" falhou: ${err.message}`);
        }
    }

    // ── Canal da Fé (vídeos gerados) ─────────────────────────────────────────
    if (process.env.CANALDAFE_IN_ROTATION !== 'false') {
        const dir = path.join(OUTPUT_BASE, 'canaldafe');
        const count = countMp4s(dir);
        checked.push(['canaldafe', dir]);
        if (count < MIN_CANALDAFE) {
            logger.step(`[Stock] Canal da Fé com ${count}/${MIN_CANALDAFE} — gerando vídeo...`);
            try {
                const { generateCanalDaFeVideo } = await import('./canal-da-fe/generate.js');
                for (let i = count; i < MIN_CANALDAFE; i++) await generateCanalDaFeVideo();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Geração do Canal da Fé falhou: ${err.message}`);
            }
        }
    }

    // ── Canal Infantil (vídeos gerados) ──────────────────────────────────────
    if (process.env.CANALINFANTIL_IN_ROTATION !== 'false') {
        const dir = path.join(OUTPUT_BASE, 'canalinfantil');
        const count = countMp4s(dir);
        checked.push(['canalinfantil', dir]);
        if (count < MIN_CANALINFANTIL) {
            logger.step(`[Stock] Canal Infantil com ${count}/${MIN_CANALINFANTIL} — gerando vídeo...`);
            try {
                const { generateCanalInfantilVideo } = await import('./canal-infantil/generate.js');
                for (let i = count; i < MIN_CANALINFANTIL; i++) await generateCanalInfantilVideo();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Geração do Canal Infantil falhou: ${err.message}`);
            }
        }
    }

    // ── Trend Hunter ─────────────────────────────────────────────────────────
    if (process.env.TREND_IN_ROTATION !== 'false') {
        const dir = path.join(OUTPUT_BASE, 'trendhunter');
        const count = countMp4s(dir);
        checked.push(['trendhunter', dir]);
        if (count < MIN_TREND) {
            logger.step(`[Stock] Trend Hunter com ${count}/${MIN_TREND} — capturando corte em alta...`);
            try {
                const { captureTrendClip } = await import('./trend-hunter/trend-capture.js');
                await captureTrendClip();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Trend Hunter falhou: ${err.message}`);
            }
        }
    }

    // ── GTA VI Hunter ────────────────────────────────────────────────────────
    if (process.env.GTA6_IN_ROTATION !== 'false') {
        const dir = path.join(OUTPUT_BASE, 'gta6hunter');
        const count = countMp4s(dir);
        checked.push(['gta6hunter', dir]);
        if (count < MIN_GTA6) {
            logger.step(`[Stock] GTA VI Hunter com ${count}/${MIN_GTA6} — capturando corte em alta...`);
            try {
                const { captureGta6TrendClip } = await import('./trend-hunter/gta6-capture.js');
                await captureGta6TrendClip();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] GTA VI Hunter falhou: ${err.message}`);
            }
        }
    }

    // ── Vídeos longos ────────────────────────────────────────────────────────
    if (process.env.LONG_VIDEO_ENABLED !== 'false') {
        const count = countMp4s(LONG_DIR);
        checked.push(['longos', LONG_DIR]);
        if (count < MIN_LONG) {
            logger.step(`[Stock] Vídeos longos com ${count}/${MIN_LONG} — replicando vídeo em alta...`);
            try {
                const { replicateTrendingLongVideo } = await import('./trend-hunter/long-replicate.js');
                await replicateTrendingLongVideo();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Replicação de vídeo longo falhou: ${err.message}`);
            }
        }
    }

    // ── Vídeo longo do Canal da Fé (canais de oração terceiros, rotativo) ────
    if (process.env.LONG_VIDEO_FE_ENABLED !== 'false') {
        const count = countMp4s(LONG_FE_DIR);
        checked.push(['longos-fe', LONG_FE_DIR]);
        if (count < MIN_LONG_FE) {
            logger.step(`[Stock] Vídeo longo do Canal da Fé com ${count}/${MIN_LONG_FE} — baixando live de oração...`);
            try {
                const { getPrayerLongVideo } = await import('./canal-da-fe/long-video.js');
                await getPrayerLongVideo();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Busca do vídeo longo do Canal da Fé falhou: ${err.message}`);
            }
        }
    }

    // ── Vídeo longo do Canal Infantil (sempre do próprio canal do Luccas Neto) ─
    if (process.env.LONG_VIDEO_INFANTIL_ENABLED !== 'false') {
        const count = countMp4s(LONG_INFANTIL_DIR);
        checked.push(['longos-infantil', LONG_INFANTIL_DIR]);
        if (count < MIN_LONG_INFANTIL) {
            logger.step(`[Stock] Vídeo longo do Canal Infantil com ${count}/${MIN_LONG_INFANTIL} — baixando vídeo do Luccas Neto...`);
            try {
                const { getLucasNetoLongVideo } = await import('./canal-infantil/long-video.js');
                await getLucasNetoLongVideo();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Busca do vídeo longo do Canal Infantil falhou: ${err.message}`);
            }
        }
    }

    // ── Vídeo longo do GTA VI (sempre dos canais curados do GTA6 Hunter) ─────
    if (process.env.LONG_VIDEO_GTA6_ENABLED !== 'false') {
        const count = countMp4s(LONG_GTA6_DIR);
        checked.push(['longos-gta6', LONG_GTA6_DIR]);
        if (count < MIN_LONG_GTA6) {
            logger.step(`[Stock] Vídeo longo do GTA VI com ${count}/${MIN_LONG_GTA6} — baixando vídeo em alta...`);
            try {
                const { getGta6LongVideo } = await import('./trend-hunter/gta6-capture.js');
                await getGta6LongVideo();
                reposicoes++;
            } catch (err) {
                logger.error(`[Stock] Busca do vídeo longo do GTA VI falhou: ${err.message}`);
            }
        }
    }

    const niveis = checked.map(([nome, dir]) => `${nome}:${countMp4s(dir)}`).join(' | ');
    logger.info(`[Stock] Níveis: ${niveis}`);
    if (reposicoes === 0) logger.success('[Stock] Estoque saudável — nada a repor neste ciclo.');
    else logger.success(`[Stock] Ciclo concluído — ${reposicoes} fonte(s) reposta(s).`);
}

main().catch((err) => {
    logger.error(`[Stock] Ciclo falhou: ${err.message}`);
    process.exit(1);
});
