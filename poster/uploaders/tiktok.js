// poster/uploaders/tiktok.js
// Automatiza o upload de um vídeo no TikTok via Playwright.
// Usa um perfil persistente do Chrome para manter a sessão após login manual.

import { chromium } from 'playwright';
import path from 'node:path';
import { logger } from '../logger.js';

const PROFILE_DIR = path.resolve('./profiles/chrome-tiktok');

// Seletores do TikTok Upload Studio
// URL: https://www.tiktok.com/creator-center/upload
const SELECTORS = {
    // Frame do uploader (TikTok usa iframe para o formulário de upload)
    uploaderFrame: 'iframe[src*="creator-center"]',
    // Input de arquivo dentro do iframe
    fileInput: 'input[type="file"]',
    // Campo de legenda/título
    captionInput: '[data-text="true"], .public-DraftEditor-content, .DraftEditor-editorContainer [contenteditable="true"]',
    // Botão "Postar" / "Post"
    postBtn: 'button[data-e2e="post-btn"], button:has-text("Postar"), button:has-text("Post")',
    // Indicador de upload concluído (barra de progresso sumiu)
    uploadDone: '[class*="upload-card--container"] [class*="checkmark"], [data-e2e="video-upload-icon"]',
};

async function launchBrowser(headless) {
    return chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        viewport: headless ? { width: 1280, height: 900 } : null,
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
    // Tenta encontrar um iframe do uploader
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
 * @returns {Promise<boolean>}
 */
export async function uploadToTikTok(filePath, caption, headless = true) {
    logger.step(`[TikTok] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser(headless);
    const page = await context.newPage();

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

        // 4. Aguarda o upload processar (barra de progresso)
        logger.info('[TikTok] Aguardando processamento do vídeo...');
        await page.waitForTimeout(8000); // Margem inicial para o upload iniciar

        // Aguarda até 3 minutos pelo processamento completo
        await frame.waitForSelector(SELECTORS.uploadDone, {
            timeout: 180000,
            state: 'visible',
        }).catch(() => {
            logger.warn('[TikTok] Timeout no sinal de conclusão do upload — tentando continuar...');
        });

        // 5. Preenche a legenda (caption) com o título + hashtags
        logger.info('[TikTok] Preenchendo legenda...');
        const captionEl = await frame.waitForSelector(SELECTORS.captionInput, { timeout: 15000 });
        await captionEl.click({ clickCount: 3 });
        await captionEl.fill(''); // Limpa
        await page.waitForTimeout(300);
        await captionEl.type(caption, { delay: 40 + Math.random() * 60 });

        // 6. Clica em "Postar"
        logger.info('[TikTok] Publicando...');
        await page.waitForTimeout(1000);
        await humanClick(frame, SELECTORS.postBtn, 20000);

        // 7. Aguarda redirecionamento ou confirmação
        await Promise.race([
            page.waitForURL('**/creator-center/content**', { timeout: 60000 }),
            page.waitForURL('**/manage/posts**', { timeout: 60000 }),
            page.waitForTimeout(30000), // Fallback
        ]).catch(() => { });

        logger.success('[TikTok] ✅ Vídeo publicado com sucesso!');
        return true;

    } catch (err) {
        logger.error(`[TikTok] Falha no upload: ${err.message}`);
        await page.screenshot({ path: `./poster-error-tiktok-${Date.now()}.png` }).catch(() => { });
        return false;

    } finally {
        await page.waitForTimeout(2000);
        await context.close();
    }
}
