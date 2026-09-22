// bilibili/uploader.js
// Upload de um vídeo pronto pra Bilibili — projeto isolado (ver CLAUDE.md /
// bilibili/), não usa Playwright nem as personas/rodízio do canal principal.
//
// Diferente de poster/uploaders/youtube.js e tiktok.js, a Bilibili não expõe
// API pública de upload, mas a comunidade reverse-engenheirou a API interna do
// próprio site e empacotou no `biliup` (https://github.com/biliup/biliup),
// autenticação via cookies (SESSDATA/bili_jct/DedeUserID). Login inicial ainda
// exige QR code escaneado pelo app oficial da Bilibili — ver bilibili/login.js.
// Depois disso os cookies são reaproveitados aqui, sem sessão de navegador.

import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
import { logger } from './logger.js';

const BILIUP_PATH = process.env.BILIUP_PATH || 'biliup';
const DEFAULT_COOKIES_PATH = path.resolve(process.env.BILIBILI_COOKIES_PATH || './bilibili/profiles/bilibili-cookies.json');
// 171 = eSports/highlights — partição de games mais próxima do formato "corte
// de stream". Tabela completa de tids: https://biliup.github.io/biliup/docs/reference/tid_ref
const DEFAULT_TID = parseInt(process.env.BILIBILI_DEFAULT_TID || '171', 10);

function runBiliup(args, { timeoutMs = 20 * 60 * 1000 } = {}) {
    return new Promise((resolve, reject) => {
        logger.info(`[Bilibili] $ ${BILIUP_PATH} ${args.filter((a) => a !== '-u').join(' ')}`);
        const child = spawn(BILIUP_PATH, args, { windowsHide: true });

        let stdout = '';
        let stderr = '';
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`biliup não respondeu em ${Math.round(timeoutMs / 60000)}min (comando travado?)`));
        }, timeoutMs);

        child.stdout.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            text.trim().split('\n').forEach((line) => line.trim() && logger.info(`[Bilibili] ${line.trim()}`));
        });
        child.stderr.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            text.trim().split('\n').forEach((line) => line.trim() && logger.warn(`[Bilibili] ${line.trim()}`));
        });

        child.on('error', (err) => {
            clearTimeout(timer);
            reject(new Error(
                `Não foi possível executar "${BILIUP_PATH}" — baixe o binário em ` +
                'https://github.com/biliup/biliup/releases e configure BILIUP_PATH no .env. ' +
                `Detalhe: ${err.message}`
            ));
        });

        child.on('close', (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });
}

/**
 * Faz upload de um vídeo na Bilibili via `biliup`.
 *
 * @param {string} filePath      - Caminho do vídeo a publicar
 * @param {string} title         - Título (a Bilibili limita a 80 caracteres)
 * @param {string} [description] - Descrição/simple intro
 * @param {object} [opts]
 * @param {number}   [opts.tid]         - Partição (tid) — padrão games/eSports (171)
 * @param {string[]} [opts.tags]        - Tags (a Bilibili exige pelo menos 1)
 * @param {string}   [opts.coverPath]   - Imagem de capa (opcional)
 * @param {string}   [opts.cookiesPath] - cookies.json gerado por bilibili-login.js
 * @param {string}   [opts.sourceUrl]   - URL original do vídeo-fonte — OBRIGATÓRIO na
 *   prática: todo conteúdo daqui é recortado de fora (YouTube etc.), então sempe
 *   sobe como "转载" (reprodução), nunca "自制" (original). Declarar como
 *   original quando não é viola as regras da Bilibili e arrisca banimento —
 *   ver histórico da conversa (achado de pesquisa em 03/09/2026).
 * @returns {Promise<{ ok: boolean, bvid: string|null }>}
 */
export async function uploadToBilibili(filePath, title, description = '', opts = {}) {
    if (!fs.existsSync(filePath)) throw new Error(`Arquivo não encontrado: ${filePath}`);

    const {
        tid = DEFAULT_TID,
        tags = ['clipes', 'gameplay', 'highlights'],
        coverPath = null,
        cookiesPath = DEFAULT_COOKIES_PATH,
        sourceUrl = null,
    } = opts;

    if (!fs.existsSync(cookiesPath)) {
        throw new Error(
            `Cookies da Bilibili não encontrados em ${cookiesPath}. ` +
            'Rode "npm run bilibili:login" uma vez (QR code, manual) antes do primeiro upload.'
        );
    }
    if (!sourceUrl) {
        throw new Error(
            'sourceUrl não informado — todo upload deste projeto é reprodução de conteúdo de ' +
            'fora (nunca conteúdo original), então precisa declarar a fonte (--copyright 2 --source). ' +
            'Publicar sem isso viola as regras da Bilibili.'
        );
    }

    logger.step(`[Bilibili] Iniciando upload: ${path.basename(filePath)}`);

    const args = [
        '-u', cookiesPath,
        'upload', filePath,
        '--title', title.slice(0, 80),
        '--tid', String(tid),
        '--tag', tags.join(','),
        '--copyright', '2', // 1=自制(original) 2=转载(reprodução) — sempre 2 aqui
        '--source', sourceUrl.slice(0, 200),
    ];
    if (description) args.push('--desc', description.slice(0, 2000));
    if (coverPath && fs.existsSync(coverPath)) args.push('--cover', coverPath);

    const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const capMin = parseInt(process.env.BILIBILI_UPLOAD_WAIT_MAX_MIN || '60', 10);
    const timeoutMs = Math.min(capMin, Math.max(10, Math.ceil(fileSizeMB / 5))) * 60_000;

    try {
        const { code, stdout, stderr } = await runBiliup(args, { timeoutMs });

        // `biliup` não documenta um contrato de saída estável — exit code 0 é o
        // sinal primário, mas também varre a saída por indicadores conhecidos de
        // falha silenciosa (cookie expirado, bloqueio de risco de conta), já que
        // CLIs de terceiros às vezes retornam 0 mesmo sem publicar de fato.
        const combined = `${stdout}\n${stderr}`.toLowerCase();
        const failureSignals = ['账号异常', '登录已过期', 'login expired', 'traceback', 'panicked'];
        const looksFailed = failureSignals.some((s) => combined.includes(s));

        if (code === 0 && !looksFailed) {
            // biliup loga a resposta da API em formato de debug do Rust, ex.:
            // ResponseData { code: 0, data: Some(Object {"bvid": String("BV1p1tD6QEY5"), ...
            // Extraído do stdout ORIGINAL (não de `combined`, que é lowercased
            // pra checagem de failureSignals — bvid é case-sensitive).
            const bvidMatch = stdout.match(/"bvid":\s*String\("(BV[0-9A-Za-z]+)"\)/);
            const bvid = bvidMatch ? bvidMatch[1] : null;
            logger.success(`[Bilibili] ✅ Vídeo publicado com sucesso!${bvid ? ` (${bvid})` : ''}`);
            return { ok: true, bvid };
        }

        logger.error(`[Bilibili] Falha no upload (exit code ${code}).`);
        return { ok: false, bvid: null };
    } catch (err) {
        logger.error(`[Bilibili] Falha no upload: ${err.message}`);
        return { ok: false, bvid: null };
    }
}

// ─── Self-test (convenção do projeto: sem test runner, valida direto) ────────
// Uso: node bilibili/uploader.js <video.mp4> "<título>" "<sourceUrl>" ["<descrição>"]
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
    const [, , videoPath, title, sourceUrl, description] = process.argv;
    if (!videoPath || !title || !sourceUrl) {
        console.error('Uso: node bilibili/uploader.js <video.mp4> "<título>" "<sourceUrl>" ["<descrição>"]');
        process.exit(1);
    }
    uploadToBilibili(videoPath, title, description || '', { sourceUrl })
        .then(({ ok, bvid }) => {
            if (bvid) console.log(`bvid: ${bvid}`);
            process.exitCode = ok ? 0 : 1;
        })
        .catch((err) => {
            console.error('Erro fatal:', err.message);
            process.exitCode = 1;
        });
}
