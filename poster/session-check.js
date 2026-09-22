// poster/session-check.js
// Validação de sessão "ponta a ponta" de cada conta ativa (YouTube/TikTok),
// rodada sempre antes do agendamento (cron) do poster começar. Diferente de só
// checar se o arquivo de cookies existe, isso abre o perfil de verdade via
// Playwright e navega até o Studio/Creator Center — a mesma URL que o upload
// real usa — pra pegar sessão expirada, MFA pendente ou conta suspensa ANTES
// do primeiro horário agendado tentar postar (ver histórico de sessões caídas
// e da suspensão da conta GTA VI em 2026-09-04/05). Nunca lança: uma conta com
// sessão inválida só gera um aviso no log, as outras seguem normalmente.

import { chromium } from 'playwright';
import path from 'node:path';
import { logger } from './logger.js';

const CHROME_EXEC = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const CHECK_TIMEOUT_MS = 20000;

async function checkYouTube(profileDir) {
    const context = await chromium.launchPersistentContext(path.resolve(profileDir), {
        executablePath: CHROME_EXEC,
        headless: true,
    });
    try {
        const page = await context.newPage();
        await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded', timeout: CHECK_TIMEOUT_MS });
        await page.waitForTimeout(2500).catch(() => {});
        const url = page.url();
        if (!url.includes('studio.youtube.com')) {
            return { ok: false, detail: `redirecionado para ${url}` };
        }
        let channelName = null;
        try {
            channelName = await page.locator('#channel-title, ytcp-header #entity-name, #entity-name').first().innerText({ timeout: 5000 });
        } catch { /* nem todo layout expõe isso — não é crítico pra validação */ }
        return { ok: true, detail: channelName ? `canal: ${channelName.trim()}` : 'sessão válida' };
    } finally {
        await context.close().catch(() => {});
    }
}

async function checkTikTok(profileDir) {
    const context = await chromium.launchPersistentContext(path.resolve(profileDir), {
        executablePath: CHROME_EXEC,
        headless: true,
    });
    try {
        const page = await context.newPage();
        await page.goto('https://www.tiktok.com/creator-center/upload', { waitUntil: 'domcontentloaded', timeout: CHECK_TIMEOUT_MS });
        await page.waitForTimeout(2500).catch(() => {});
        // Checa host+pathname da URL final, não a string bruta — o redirect pro
        // login (tiktok.com/login?redirect_url=...creator-center%2Fupload...)
        // contém "creator-center" DENTRO do query param codificado, então um
        // includes() na URL toda dava falso positivo (achado na prática: conta
        // deslogada sendo reportada como válida).
        const finalUrl = new URL(page.url());
        if (finalUrl.pathname.startsWith('/login')) {
            return { ok: false, detail: `redirecionado para ${finalUrl.toString()}` };
        }
        if (!finalUrl.pathname.includes('/upload') && !finalUrl.pathname.includes('creator-center')) {
            return { ok: false, detail: `redirecionado para ${finalUrl.toString()}` };
        }
        return { ok: true, detail: 'sessão válida' };
    } finally {
        await context.close().catch(() => {});
    }
}

async function checkInstagram(profileDir) {
    const context = await chromium.launchPersistentContext(path.resolve(profileDir), {
        executablePath: CHROME_EXEC,
        headless: true,
    });
    try {
        const page = await context.newPage();
        await page.goto('https://www.instagram.com/', { waitUntil: 'domcontentloaded', timeout: CHECK_TIMEOUT_MS });
        await page.waitForTimeout(2500).catch(() => {});
        const url = page.url();
        if (url.includes('/accounts/login')) {
            return { ok: false, detail: `redirecionado para ${url}` };
        }
        return { ok: true, detail: 'sessão válida' };
    } finally {
        await context.close().catch(() => {});
    }
}

const CHECKERS = {
    youtube: checkYouTube,
    tiktok: checkTikTok,
    instagram: checkInstagram,
};

const PLATFORM_LABELS = {
    youtube: 'YouTube',
    tiktok: 'TikTok',
    instagram: 'Instagram',
};

/**
 * @param {{id:string,label:string,platform:'youtube'|'tiktok'|'instagram',profileDir:string}[]} accounts
 * @returns {Promise<Array<{id:string,label:string,platform:string,profileDir:string,ok:boolean,detail:string}>>}
 */
export async function validateAllSessions(accounts) {
    const results = [];
    for (const acc of accounts) {
        try {
            const checker = CHECKERS[acc.platform] || checkTikTok;
            const r = await checker(acc.profileDir);
            results.push({ ...acc, ...r });
        } catch (err) {
            results.push({ ...acc, ok: false, detail: err.message });
        }
    }

    const sep = '─'.repeat(60);
    logger.info(sep);
    logger.info('🔐 Validação de sessões (pré-agendamento)');
    for (const r of results) {
        const icon = r.ok ? '✅' : '❌';
        const platformLabel = PLATFORM_LABELS[r.platform] || r.platform;
        logger[r.ok ? 'info' : 'warn'](`  ${icon} ${r.label} (${platformLabel}) — ${r.detail}`);
    }
    logger.info(sep);

    const failed = results.filter((r) => !r.ok);
    if (failed.length > 0) {
        logger.warn(`⚠️  ${failed.length} conta(s) com sessão inválida — uploads pra ela(s) vão falhar até relogar (node poster/login.js). Auto-poster segue rodando pras demais contas.`);
    }

    return results;
}
