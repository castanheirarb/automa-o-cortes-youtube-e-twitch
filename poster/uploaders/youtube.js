// poster/uploaders/youtube.js
// Automatiza o upload de um Shorts no YouTube Studio via Playwright.
// Usa um perfil persistente do Chrome para manter a sessão após login manual.

import { chromium } from 'playwright';
import path from 'node:path';
import { logger } from '../logger.js';

const PROFILE_DIR = path.resolve('./profiles/chrome-youtube');

// Seletores do YouTube Studio (atualizados para 2025)
const SELECTORS = {
    // Botão "Criar" no canto superior
    createBtn: 'ytcp-button#create-icon',
    // Opção "Fazer upload de vídeos"
    uploadMenuItem: 'tp-yt-paper-item:has-text("Fazer upload de vídeos"), tp-yt-paper-item:has-text("Upload videos")',
    // Input de arquivo (oculto)
    fileInput: 'input[type="file"]',
    // Campo de título
    titleInput: '#title-textarea #child-input, ytcp-social-suggestions-textbox[id="title-textarea"] #textbox',
    // Checkbox / botão "Não é conteúdo infantil"
    notForKids: '#radioLabel:has-text("Não, não é direcionado"), #radioLabel:has-text("No, it\'s not")',
    // Botão "Próximo" (aparece 3x no wizard)
    nextBtn: 'ytcp-button#next-button',
    // Botão "Publicar"
    publishBtn: 'ytcp-button#done-button',
    // Confirmação: URL do vídeo publicado
    publishConfirm: 'ytcp-video-info',
};

/**
 * Abre o browser com perfil persistente.
 * headless: false = modo visível (para login manual)
 * headless: true  = modo invisível (produção)
 */
async function launchBrowser(headless) {
    return chromium.launchPersistentContext(PROFILE_DIR, {
        headless,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        viewport: headless ? { width: 1280, height: 900 } : null,
    });
}

/**
 * Aguarda um elemento e clica nele com delay humano.
 */
async function humanClick(page, selector, timeout = 15000) {
    const el = await page.waitForSelector(selector, { timeout });
    await page.waitForTimeout(300 + Math.random() * 400); // 300–700ms delay
    await el.click();
}

/**
 * Digite texto simulando velocidade humana (50–120ms por caractere).
 */
async function humanType(page, selector, text, timeout = 15000) {
    const el = await page.waitForSelector(selector, { timeout });
    await el.click({ clickCount: 3 }); // Seleciona todo o texto existente
    await page.waitForTimeout(200);
    await el.type(text, { delay: 50 + Math.random() * 70 });
}

// ─── Fluxo Principal ─────────────────────────────────────────────────────────

/**
 * Faz upload de um vídeo no YouTube Studio.
 *
 * @param {string} filePath - Caminho absoluto do arquivo .mp4
 * @param {string} title    - Título do vídeo (já com hashtags)
 * @param {boolean} headless - false = modo visível
 * @returns {Promise<boolean>} true se o upload foi concluído com sucesso
 */
export async function uploadToYouTube(filePath, title, headless = true) {
    logger.step(`[YouTube] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser(headless);
    const page = await context.newPage();

    try {
        // 1. Navega para o YouTube Studio
        logger.info('[YouTube] Navegando para o YouTube Studio...');
        await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(2000);

        // 2. Clica no botão "Criar"
        logger.info('[YouTube] Abrindo menu de criação...');
        await humanClick(page, SELECTORS.createBtn, 20000);
        await page.waitForTimeout(800);

        // 3. Clica em "Fazer upload de vídeos"
        await humanClick(page, SELECTORS.uploadMenuItem, 10000);
        await page.waitForTimeout(1000);

        // 4. Envia o arquivo via input oculto (sem precisar clicar no dropzone)
        logger.info('[YouTube] Enviando arquivo...');
        const fileInput = await page.waitForSelector(SELECTORS.fileInput, { timeout: 10000 });
        await fileInput.setInputFiles(filePath);

        // 5. Aguarda o título ser preenchido automaticamente e o substitui
        logger.info('[YouTube] Preenchendo título...');
        await page.waitForTimeout(3000); // Aguarda o modal de detalhes carregar
        await humanType(page, SELECTORS.titleInput, title, 20000);

        // 6. Marca "Não é conteúdo infantil"
        await humanClick(page, SELECTORS.notForKids, 10000);
        await page.waitForTimeout(500);

        // 7. Clica em "Próximo" 3 vezes (Detalhes → Elementos → Verificações → Visibilidade)
        logger.info('[YouTube] Navegando pelo wizard de publicação...');
        for (let i = 0; i < 3; i++) {
            await humanClick(page, SELECTORS.nextBtn, 15000);
            await page.waitForTimeout(1500);
        }

        // 8. Aguarda o processamento mínimo (YouTube exige pelo menos 1%)
        logger.info('[YouTube] Aguardando processamento mínimo do vídeo...');
        await page.waitForTimeout(5000);

        // 9. Clica em "Publicar"
        logger.info('[YouTube] Publicando...');
        await humanClick(page, SELECTORS.publishBtn, 30000);

        // 10. Aguarda confirmação
        await page.waitForSelector(SELECTORS.publishConfirm, { timeout: 60000 });
        logger.success('[YouTube] ✅ Vídeo publicado com sucesso!');

        return true;

    } catch (err) {
        logger.error(`[YouTube] Falha no upload: ${err.message}`);
        // Tira screenshot para diagnóstico
        await page.screenshot({ path: `./poster-error-youtube-${Date.now()}.png` }).catch(() => { });
        return false;

    } finally {
        await page.waitForTimeout(2000);
        await context.close();
    }
}
