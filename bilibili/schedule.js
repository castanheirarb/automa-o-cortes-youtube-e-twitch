// bilibili/schedule.js
// Agendador standalone do projeto Bilibili — dispara bilibili/run.js em
// horário fixo via cron, isolado do start.js do canal principal (não entra
// no swarm de processos dos outros canais, mesmo princípio de isolamento do
// resto de bilibili/).
//
// Horário padrão calibrado por pesquisa (03/09/2026, ver histórico da
// conversa): pico de tráfego da Bilibili é 20h-23h em Pequim (UTC+8), e a
// prática recomendada é postar 30-60min ANTES do pico pra dar tempo de
// "esquentar" engajamento antes do algoritmo empurrar mais forte. Convertido
// pro fuso do Brasil (UTC-3, diferença de 11h): pico = 9h-12h BRT → post às
// ~8h BRT. Conta ainda em cold start (0 seguidores) — 1x/dia é
// intencionalmente conservador; UP主s só recomendam 3-5x/dia DEPOIS que a
// conta já tem engajamento acumulado (ver npm run bilibili:stats).
//
// Uso: npm run bilibili:schedule (processo de longa duração, roda em loop)

import 'dotenv/config';
import cron from 'node-cron';
import { runOnce } from './run.js';
import { replicateLocal } from './replicate-local.js';
import { dequeueRepost, cleanupPending } from './repost-queue.js';
import { printStatsReport } from './stats.js';
import { logger } from './logger.js';

const CRON_EXPR = process.env.BILIBILI_CRON || '0 8 * * *';
const TIMEZONE = process.env.BILIBILI_TIMEZONE || 'America/Sao_Paulo';
// Relatório diário de audiência (views/likes/inscritos) direto no terminal —
// pedido explícito do usuário (07/09/2026): rodar tudo num único comando, sem
// depender de sessão de chat pra reportar status. Horário default casa com o
// relatório que era gerado manualmente via chat (23h).
const REPORT_CRON = process.env.BILIBILI_REPORT_CRON || '3 23 * * *';
// Checagem mais frequente, só dos 3 vídeos mais recentes (pedido do usuário
// 08/09/2026) — mais leve que o relatório completo (4 chamadas à API por
// disparo: 1 de conta + 3 de vídeo, contra N+1 do relatório diário), então
// pode rodar num intervalo menor sem problema. Padrão de 2h em 2h: a API
// pública da Bilibili não documenta limite de taxa, mas x/web-interface/view
// já demonstrou ter proteção anti-bot (412 sem cookie, ver stats.js) — nesse
// volume (12x/dia, 4 chamadas cada = ~48 chamadas/dia) fica bem abaixo de
// qualquer limiar razoável, e como a conta ainda está em cold start (views
// crescem devagar), checar com mais frequência que isso não traria sinal
// novo mesmo.
const RECENT_REPORT_CRON = process.env.BILIBILI_RECENT_REPORT_CRON || '0 */2 * * *';

let isRunning = false;

async function triggerCycle() {
    if (isRunning) {
        logger.warn('[Bilibili/Schedule] Ciclo anterior ainda rodando — pulando este disparo (evita sobreposição).');
        return;
    }
    isRunning = true;
    logger.step(`[Bilibili/Schedule] ⏰ Horário atingido (${CRON_EXPR} ${TIMEZONE}) — disparando ciclo...`);
    try {
        // Prioridade (pedido do usuário, 17/09/2026): conteúdo já produzido por
        // cortecerto034/Fé Move Montanha (ver bilibili/repost-queue.js,
        // alimentada por poster/index.js) vem ANTES das fontes externas de
        // sources.js — só cai pro pool chinês/Roblox/BR de run.js quando a
        // fila estiver vazia, pra a conta nunca ficar sem postar.
        const queued = dequeueRepost();
        const result = queued
            ? await replicateLocal(queued.localPath, queued.sourceUrl).finally(() => cleanupPending(queued.localPath))
            : await runOnce();
        if (result.published) {
            logger.success(`[Bilibili/Schedule] ✅ Ciclo publicou com sucesso.${result.bvid ? ` (${result.bvid})` : ''}`);
            // Pedido do usuário (08/09/2026): mostrar a audiência de TODOS os
            // vídeos toda vez que um novo sair, não só no relatório diário —
            // dá visibilidade imediata do efeito do post recém-publicado.
            logger.step('[Bilibili/Schedule] 📊 Vídeo novo publicado — atualizando audiência de todos os vídeos...');
            try {
                await printStatsReport();
            } catch (err) {
                logger.error(`[Bilibili/Schedule] Relatório pós-publicação falhou: ${err.message}`);
            }
        } else {
            logger.warn('[Bilibili/Schedule] Ciclo terminou sem publicar (sem fonte nova, ou falha — ver logs acima).');
        }
    } catch (err) {
        // Um ciclo falhar não pode derrubar o agendador — o próximo horário
        // ainda precisa disparar normalmente.
        logger.error(`[Bilibili/Schedule] Ciclo falhou: ${err.message}`);
    } finally {
        isRunning = false;
    }
}

async function triggerReport() {
    logger.step('[Bilibili/Schedule] 📊 Horário do relatório diário — consultando audiência...');
    try {
        await printStatsReport();
    } catch (err) {
        // Mesma regra do ciclo de publicação: uma falha no relatório (ex.:
        // API da Bilibili fora do ar) não pode derrubar o agendador.
        logger.error(`[Bilibili/Schedule] Relatório falhou: ${err.message}`);
    }
}

async function triggerRecentReport() {
    logger.step('[Bilibili/Schedule] 📊 Checagem periódica — audiência dos 3 vídeos mais recentes...');
    try {
        await printStatsReport({ limit: 3 });
    } catch (err) {
        logger.error(`[Bilibili/Schedule] Checagem periódica falhou: ${err.message}`);
    }
}

function main() {
    if (!cron.validate(CRON_EXPR)) {
        logger.error(`[Bilibili/Schedule] Expressão cron inválida: "${CRON_EXPR}" — corrija BILIBILI_CRON no .env.`);
        process.exit(1);
    }
    if (!cron.validate(REPORT_CRON)) {
        logger.error(`[Bilibili/Schedule] Expressão cron inválida: "${REPORT_CRON}" — corrija BILIBILI_REPORT_CRON no .env.`);
        process.exit(1);
    }
    if (!cron.validate(RECENT_REPORT_CRON)) {
        logger.error(`[Bilibili/Schedule] Expressão cron inválida: "${RECENT_REPORT_CRON}" — corrija BILIBILI_RECENT_REPORT_CRON no .env.`);
        process.exit(1);
    }

    console.log('\n\x1b[35m' + '═'.repeat(52) + '\x1b[0m');
    console.log('\x1b[35m  📅  Bilibili — Agendador de Posts\x1b[0m');
    console.log('\x1b[35m' + '═'.repeat(52) + '\x1b[0m\n');
    logger.info(`[Bilibili/Schedule] Posts agendados: "${CRON_EXPR}" (${TIMEZONE})`);
    logger.info(`[Bilibili/Schedule] Relatório diário completo agendado: "${REPORT_CRON}" (${TIMEZONE})`);
    logger.info(`[Bilibili/Schedule] Checagem dos 3 mais recentes agendada: "${RECENT_REPORT_CRON}" (${TIMEZONE})`);
    logger.info('[Bilibili/Schedule] Ctrl+C pra parar. Processo fica rodando em loop — mantenha o terminal/máquina ligados.');

    cron.schedule(CRON_EXPR, triggerCycle, { timezone: TIMEZONE });
    cron.schedule(REPORT_CRON, triggerReport, { timezone: TIMEZONE });
    cron.schedule(RECENT_REPORT_CRON, triggerRecentReport, { timezone: TIMEZONE });
}

main();
