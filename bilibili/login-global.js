// bilibili/login-global.js
// Login manual (1x) no app GLOBAL (studio.bilibili.tv) — plataforma
// SEPARADA do bilibili.com mainland (que usa biliup + QR code, ver login.js).
// Abre o Chrome visível com um perfil Playwright dedicado; você loga do jeito
// que já cadastrou a conta (telefone, e-mail, ou Google/Gmail), e a sessão
// fica salva no perfil pra bilibili/uploader-global.js reaproveitar depois.
//
// Uso: npm run bilibili:login-global

import { chromium } from 'playwright';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from './logger.js';

const PROFILE_DIR = path.resolve('./bilibili/profiles/bilibili-tv');
const CHROME_EXEC = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

function waitForEnter(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(message, () => { rl.close(); resolve(); });
    });
}

async function main() {
    console.log('\n\x1b[35m' + '═'.repeat(52) + '\x1b[0m');
    console.log('\x1b[35m  🔐  Bilibili GLOBAL (studio.bilibili.tv) — Login\x1b[0m');
    console.log('\x1b[35m' + '═'.repeat(52) + '\x1b[0m\n');

    logger.step('Abrindo studio.bilibili.tv para login manual...');
    const context = await chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: CHROME_EXEC,
        headless: false,
        args: ['--no-sandbox', '--start-maximized', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: null,
    });

    const page = await context.newPage();
    await page.goto('https://studio.bilibili.tv', { waitUntil: 'domcontentloaded' });

    logger.info('Faça login normalmente (telefone, e-mail ou Google) — a MESMA conta que você já criou.');
    await waitForEnter('\n  👉  Quando estiver logado (tela "Hi, creator!"), pressione ENTER aqui...\n');

    await context.close();
    logger.success(`✅ Sessão salva em: ${PROFILE_DIR}`);
    logger.info('A partir de agora, node bilibili/uploader-global.js reaproveita essa sessão.');
    process.exit(0);
}

main().catch((err) => {
    console.error('Erro fatal:', err.message);
    process.exit(1);
});
