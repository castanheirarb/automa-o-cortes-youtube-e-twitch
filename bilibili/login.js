// bilibili/login.js
// Login manual (1x) na Bilibili via `biliup login` — mostra um QR code no
// terminal para escanear com o app oficial da Bilibili no celular. Ao
// terminar, salva cookies.json reaproveitado em todo upload seguinte por
// bilibili/uploader.js, sem precisar logar de novo até os cookies expirarem
// (rode este script outra vez se o upload começar a falhar).
//
// Uso: npm run bilibili:login

import 'dotenv/config';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from './logger.js';

const BILIUP_PATH = process.env.BILIUP_PATH || 'biliup';
const cookiesPath = path.resolve(process.env.BILIBILI_COOKIES_PATH || './bilibili/profiles/bilibili-cookies.json');

fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });

logger.step('Login manual na Bilibili — escaneie o QR code exibido abaixo com o app oficial (celular).');
logger.info(`Cookies serão salvos em: ${cookiesPath}`);

const child = spawn(BILIUP_PATH, ['-u', cookiesPath, 'login'], { stdio: 'inherit', windowsHide: true });

child.on('error', (err) => {
    logger.error(`Não foi possível executar "${BILIUP_PATH}": ${err.message}`);
    logger.info('Baixe o binário em https://github.com/biliup/biliup/releases e configure BILIUP_PATH no .env.');
    process.exitCode = 1;
});

child.on('close', (code) => {
    if (code === 0 && fs.existsSync(cookiesPath)) {
        logger.success(`✅ Login concluído! Cookies salvos em ${cookiesPath}`);
        logger.info('Teste um upload real com: npm run bilibili:upload -- <video.mp4> "<título>"');
    } else {
        logger.error(`Login não concluiu (exit code ${code}) — cookies.json não encontrado.`);
        process.exitCode = 1;
    }
});
