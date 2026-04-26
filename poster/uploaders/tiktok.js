// poster/uploaders/tiktok.js
// Automatiza o upload de um vídeo no TikTok via Playwright.
// Usa um perfil persistente do Chrome para manter a sessão após login manual.

import { chromium } from 'playwright';
import path from 'node:path';
import { logger } from '../logger.js';

// Perfil persistente do Playwright — sessão salva com npm run poster:login
// Usa o Chrome real como executável para máxima compatibilidade.
const PROFILE_DIR = path.resolve('./profiles/chrome-tiktok');

const CHROME_EXEC = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Seletores do TikTok Upload Studio
const SELECTORS = {
    uploaderFrame: 'iframe[src*="creator-center"]',
    fileInput: 'input[type="file"]',
    captionInput: '[data-text="true"], .public-DraftEditor-content, .DraftEditor-editorContainer [contenteditable="true"]',
    postBtn: 'button[data-e2e="post-btn"], button:has-text("Postar"), button:has-text("Post")',
    uploadDone: '[class*="upload-card--container"] [class*="checkmark"], [data-e2e="video-upload-icon"]',
};

async function launchBrowser() {
    logger.info(`[TikTok] Perfil: ${PROFILE_DIR}`);
    return chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: CHROME_EXEC,
        headless: false, // TikTok bloqueia upload headless
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
    });
}


async function humanClick(page, selector, timeout = 15000) {
    const el = await page.waitForSelector(selector, { timeout, state: 'visible' });
    await page.waitForTimeout(300 + Math.random() * 400);
    await el.click();
}

/**
 * Obtém a página/frame correta para interagir.
 * O TikTok Creator Center envolve o formulário em um iframe.
 */
async function getUploadFrame(page) {
    await page.waitForTimeout(2000);
    const frames = page.frames();
    const uploaderFrame = frames.find((f) => f.url().includes('creator-center') || f.url().includes('tiktok'));
    return uploaderFrame || page.mainFrame();
}

// ─── Fluxo Principal ─────────────────────────────────────────────────────────

/**
 * Faz upload de um vídeo no TikTok.
 *
 * @param {string} filePath
 * @param {string} caption  - Legenda com hashtags
 * @param {boolean} headless
 * @returns {Promise<boolean>} true = publicado com sucesso confirmado; false = falhou
 */
export async function uploadToTikTok(filePath, caption, headless = true) {
    logger.step(`[TikTok] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser();
    const page = await context.newPage();
    let uploaded = false; // Só true se a URL mudar para a página de conteúdo

    try {
        // 1. Vai direto para a página de upload do Creator Center
        logger.info('[TikTok] Navegando para o Creator Center...');
        await page.goto('https://www.tiktok.com/creator-center/upload', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await page.waitForTimeout(3000);

        // 2. Obtém o frame correto (TikTok usa iframe para o uploader)
        const frame = await getUploadFrame(page);

        // 3. Envia o arquivo
        logger.info('[TikTok] Enviando arquivo...');
        const fileInput = await frame.waitForSelector(SELECTORS.fileInput, {
            timeout: 15000,
            state: 'attached',
        });
        await fileInput.setInputFiles(filePath);

        // 4. Aguarda o processamento — estratégia robusta:
        // Em vez de esperar um indicador visual (seletor frágil),
        // esperamos o campo de legenda ficar disponível e interagível,
        // o que só acontece DEPOIS que o vídeo terminou de processar.
        logger.info('[TikTok] Aguardando processamento do vídeo (até 5 min)...');
        await page.waitForTimeout(5000); // pausa inicial para o iframe montar

        const CAPTION_SELECTORS = [
            '[data-text="true"]',
            '.public-DraftEditor-content',
            '.DraftEditor-editorContainer [contenteditable="true"]',
            '[contenteditable="true"][spellcheck]',
            'div[contenteditable="true"]',
        ];

        let captionEl = null;
        const MAX_WAIT_MS = 5 * 60 * 1000; // 5 minutos
        const POLL_MS = 5_000;
        const startTime = Date.now();

        while (!captionEl && Date.now() - startTime < MAX_WAIT_MS) {
            // Tenta re-obter o frame a cada iteração (TikTok pode recarregar o iframe)
            const currentFrame = await getUploadFrame(page);

            for (const sel of CAPTION_SELECTORS) {
                try {
                    const el = await currentFrame.waitForSelector(sel, { timeout: 3000, state: 'visible' });
                    if (el) { captionEl = el; break; }
                } catch { /* tenta o próximo */ }
            }

            if (!captionEl) {
                const elapsed = Math.round((Date.now() - startTime) / 1000);
                logger.info(`[TikTok] Processando... ${elapsed}s / ${MAX_WAIT_MS / 1000}s`);
                await page.waitForTimeout(POLL_MS);
            }
        }

        if (!captionEl) {
            throw new Error('Vídeo não processou em 5 minutos — TikTok pode estar com lentidão.');
        }

        // 5. Preenche a legenda
        // Re-obtém o frame e o elemento para evitar referência stale após o poll loop.
        // O TikTok usa Draft.js (editor rico contenteditable): o texto deve ser
        // digitado via page.keyboard.type() (nível de página), não element.type(),
        // pois Draft.js só reconhece eventos de teclado disparados no documento.
        logger.info('[TikTok] Preenchendo legenda...');
        const uploadFrame = await getUploadFrame(page);

        let captionInput = null;
        for (const sel of CAPTION_SELECTORS) {
            try {
                const el = await uploadFrame.waitForSelector(sel, { timeout: 5000, state: 'visible' });
                if (el) { captionInput = el; break; }
            } catch { /* tenta o próximo */ }
        }

        if (!captionInput) throw new Error('Campo de legenda não encontrado após processamento do vídeo.');

        // Foca o campo e limpa o conteúdo existente
        await captionInput.click();
        await page.waitForTimeout(500);
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(150);
        await page.keyboard.press('Delete');
        await page.waitForTimeout(300);

        // Digita via page.keyboard para que o Draft.js receba os eventos corretamente
        const captionTrimmed = caption.slice(0, 2200);
        await page.keyboard.type(captionTrimmed, { delay: 25 + Math.random() * 30 });

        // 6. Clica em "Postar"
        logger.info('[TikTok] Publicando...');
        await page.waitForTimeout(1500);

        const POST_BTN_SELECTORS = [
            'button[data-e2e="post-btn"]',
            'button:has-text("Postar")',
            'button:has-text("Post")',
            'button:has-text("Publicar")',
            '[class*="btn-post"]',
        ];

        let clicked = false;
        for (const sel of POST_BTN_SELECTORS) {
            try {
                await uploadFrame.waitForSelector(sel, { timeout: 5000, state: 'visible' });
                await uploadFrame.click(sel);
                clicked = true;
                logger.info(`[TikTok] Botão publicar clicado (${sel})`);
                break;
            } catch { /* tenta o próximo */ }
        }

        if (!clicked) throw new Error('Botão de publicar não encontrado após processar vídeo.');

        // 7. Aguarda redirecionamento real
        const redirectResult = await Promise.race([
            page.waitForURL('**/creator-center/content**', { timeout: 60000 }).then(() => 'content'),
            page.waitForURL('**/manage/posts**', { timeout: 60000 }).then(() => 'posts'),
            page.waitForURL('**/creator-center/upload**', { timeout: 60000 }).then(() => 'upload_again'),
        ]).catch(() => 'timeout');

        if (redirectResult === 'content' || redirectResult === 'posts') {
            uploaded = true;
            logger.success('[TikTok] ✅ Vídeo publicado com sucesso!');
        } else if (redirectResult === 'upload_again') {
            logger.warn('[TikTok] Redirecionou para upload novamente — verifique manualmente.');
        } else {
            logger.warn(`[TikTok] Sem redirecionamento confirmado (${redirectResult}) — verifique manualmente.`);
        }

        return uploaded;


    } catch (err) {
        logger.error(`[TikTok] Falha no upload: ${err.message}`);
        await page.screenshot({ path: `./poster-error-tiktok-${Date.now()}.png` }).catch(() => { });
        return false;

    } finally {
        await page.waitForTimeout(2000).catch(() => {});
        await context.close().catch(() => {});
    }
}
