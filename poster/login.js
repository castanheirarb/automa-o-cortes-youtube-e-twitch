// poster/login.js
// Script dedicado para fazer login manual nas plataformas.
// Abre o Chrome visível, navega para a plataforma e aguarda você fechar o navegador.
// Rode apenas UMA VEZ: node poster/login.js

import 'dotenv/config';
import { chromium } from 'playwright';
import path from 'node:path';
import readline from 'node:readline';
import { logger } from './logger.js';

const CHROME_EXEC = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

const PLATFORMS = {
    youtube: {
        profileDir: path.resolve('./profiles/chrome-youtube'),
        url: 'https://studio.youtube.com',
        name: 'YouTube Studio',
    },
    tiktok: {
        profileDir: path.resolve('./profiles/chrome-tiktok'),
        url: 'https://www.tiktok.com/login',
        name: 'TikTok',
    },
};

function waitForEnter(message) {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return new Promise((resolve) => {
        rl.question(message, () => { rl.close(); resolve(); });
    });
}

async function loginToPlatform(key) {
    const { profileDir, url, name } = PLATFORMS[key];

    logger.step(`Abrindo ${name} para login manual...`);

    const context = await chromium.launchPersistentContext(profileDir, {
        executablePath: CHROME_EXEC,
        headless: false,
        args: ['--no-sandbox', '--start-maximized', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: null,
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded' });

    logger.info(`${name} aberto. Faça login normalmente.`);
    await waitForEnter(
        `\n  👉  Faça login no ${name}, e quando estiver logado, pressione ENTER aqui...\n`
    );

    await context.close();
    logger.success(`Sessão do ${name} salva em: ${profileDir}\n`);
}


async function main() {
    const UPLOAD_YOUTUBE = process.env.UPLOAD_TO_YOUTUBE !== 'false';
    const UPLOAD_TIKTOK = process.env.UPLOAD_TO_TIKTOK !== 'false';

    console.log('\n\x1b[35m' + '═'.repeat(52) + '\x1b[0m');
    console.log('\x1b[35m  🔐  CANAL CORTE — Login Manual\x1b[0m');
    console.log('\x1b[35m' + '═'.repeat(52) + '\x1b[0m\n');

    logger.info('O browser será aberto visível para cada plataforma.');
    logger.info('Faça login normalmente e pressione ENTER no terminal para continuar.\n');

    if (UPLOAD_YOUTUBE) await loginToPlatform('youtube');
    if (UPLOAD_TIKTOK) await loginToPlatform('tiktok');

    logger.success('✅ Todos os logins concluídos!');
    logger.info('A partir de agora rode: npm run poster');
    process.exit(0);
}

main().catch((err) => {
    console.error('Erro fatal:', err.message);
    process.exit(1);
});
