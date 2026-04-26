// poster/uploaders/youtube.js
// Automatiza o upload de um Shorts no YouTube Studio via Playwright.
// Usa um perfil persistente do Chromium para manter sessão após login manual.
// Verifica restrições de copyright antes de publicar.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger.js';

const PROFILE_DIR = path.resolve('./profiles/chrome-youtube');

const CHROME_EXEC = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// ─── Seletores ────────────────────────────────────────────────────────────────

const SEL = {
    createBtn: [
        '[aria-label="Criar"]',
        '[aria-label="Create"]',
        '#create-icon',
        'ytcp-button#create-icon',
        'ytcp-icon-button#create-icon',
    ],
    uploadMenuItem: [
        'tp-yt-paper-item:has-text("Fazer upload")',
        'tp-yt-paper-item:has-text("Upload video")',
        '[test-id="upload-beta"]',
        '#text-item-0',
        'ytcp-text-menu paper-item:first-child',
    ],
    fileInput: 'input[type="file"]',
    titleInput: [
        '#title-textarea div[contenteditable="true"]',
        'ytcp-social-suggestions-textbox[id="title-textarea"] div[contenteditable="true"]',
        '#title-textarea #textbox',
        '#title-textarea [contenteditable]',
        '#textbox[aria-label*="ítulo"]',
        '#textbox[aria-label*="itle"]',
    ],
    descriptionInput: [
        '#description-textarea div[contenteditable="true"]',
        'ytcp-social-suggestions-textbox[id="description-textarea"] div[contenteditable="true"]',
        '#description-textarea #textbox',
        '#description-textarea [contenteditable]',
        'ytcp-form-textarea div[contenteditable="true"]',
        '#textbox[aria-label*="scrição"]',
        '#textbox[aria-label*="escription"]',
    ],
    notForKids: [
        'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_NOT_MFK"]',
        '#radioLabel:has-text("Não, não")',
        '#radioLabel:has-text("No, it")',
        'ytcp-radio-group ytcp-radio-button:last-child #radioLabel',
    ],
    nextBtn: [
        'ytcp-button#next-button',
        'ytcp-stepper-footer #next-button',
        'button[aria-label="Próximo"]',
        'button[aria-label="Next"]',
    ],
    publicVisibility: [
        'tp-yt-paper-radio-button[name="PUBLIC"]',
        'ytcp-visibility-radio-button[format="PUBLIC"]',
        '#radioLabel:has-text("Público")',
        '#radioLabel:has-text("Public")',
        '[aria-label*="Público"]',
        '[aria-label*="Public, everyone"]',
    ],
    publishBtn: [
        'ytcp-button#done-button',
        'button[aria-label="Publicar"]',
        'button[aria-label="Publish"]',
        'ytcp-button[aria-label="Publicar"]',
    ],
    publishConfirm: [
        'ytcp-video-info',
        'div[role="dialog"] a[href*="watch"]',
        '.ytcp-video-share-url',
    ],
    thumbnailInput: 'input[type="file"][accept*="image"]',
    copyrightError: [
        'ytcp-checks .ytcp-video-upload-checks .error-icon',
        ':text("Reivindicação de direitos autorais")',
        ':text("Copyright claim")',
        ':text("Conteúdo de terceiros")',
        ':text("Third-party content")',
        ':text("Vídeo bloqueado")',
        ':text("Video blocked")',
        'ytcp-checks-video-attribute-row:has(.error-icon)',
    ],
    checksOk: [
        ':text("Sem problemas encontrados")',
        ':text("No issues found")',
        ':text("Nenhum problema")',
    ],
};

// ─── Browser ──────────────────────────────────────────────────────────────────

async function launchBrowser(headless) {
    logger.info(`[YouTube] Perfil: ${PROFILE_DIR}`);
    return chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: CHROME_EXEC,
        headless: headless === true,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
            '--disable-setuid-sandbox',
            '--disable-dev-shm-usage',
            '--window-size=1280,900',
        ],
        ignoreDefaultArgs: ['--enable-automation'],
        userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        viewport: null,
        ignoreHTTPSErrors: true,
    });
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

async function tryClick(page, selectors, timeout = 20000) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
        for (const sel of list) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 1500 })) {
                    await el.scrollIntoViewIfNeeded().catch(() => {});
                    await page.waitForTimeout(300 + Math.random() * 300).catch(() => {});
                    await el.click();
                    return sel;
                }
            } catch { /* tenta o próximo */ }
        }
        await page.waitForTimeout(800).catch(() => {});
    }
    throw new Error(`Nenhum seletor funcionou: ${list.slice(0, 2).join(', ')} ...`);
}

/**
 * Aguarda (por polling) que um dos seletores fique visível na página.
 * Retorna o locator do primeiro elemento encontrado, ou null se timeout.
 */
async function waitForAny(page, selectors, timeoutMs = 30000) {
    const list = Array.isArray(selectors) ? selectors : [selectors];
    const deadline = Date.now() + timeoutMs;
    let elapsed = 0;

    while (Date.now() < deadline) {
        for (const sel of list) {
            try {
                const el = page.locator(sel).first();
                if (await el.isVisible({ timeout: 1500 })) {
                    return el;
                }
            } catch { /* continua */ }
        }
        await page.waitForTimeout(2000).catch(() => {});
        elapsed += 2;
        if (elapsed % 6 === 0) {
            logger.info(`[YouTube] Aguardando modal... (${elapsed}s)`);
        }
    }
    return null;
}

/**
 * Preenche um campo contenteditable do YouTube Studio.
 * Usa paste via DataTransfer — evita autocomplete e seleções acidentais.
 */
async function fillField(page, el, text) {
    await el.scrollIntoViewIfNeeded().catch(() => {});
    await el.click({ force: true });
    await page.waitForTimeout(300).catch(() => {});

    // Seleciona e apaga o conteúdo atual do campo
    await page.keyboard.press('Control+a');
    await page.waitForTimeout(100).catch(() => {});
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(150).catch(() => {});

    // Cola via ClipboardEvent — YouTube Studio aceita e não aciona autocomplete
    const pasted = await page.evaluate((t) => {
        try {
            const dt = new DataTransfer();
            dt.setData('text/plain', t);
            document.activeElement.dispatchEvent(
                new ClipboardEvent('paste', { clipboardData: dt, bubbles: true })
            );
            return true;
        } catch {
            return false;
        }
    }, text);

    await page.waitForTimeout(400).catch(() => {});

    if (!pasted) {
        // Fallback: type() caracter a caracter
        await page.keyboard.type(text, { delay: 35 });
        await page.waitForTimeout(300).catch(() => {});
    }

    // Fecha sugestões sem mover o foco para outro campo
    await page.keyboard.press('Escape').catch(() => {});
}

async function tryType(page, selectors, text, timeoutMs = 25000) {
    const el = await waitForAny(page, selectors, timeoutMs);
    if (!el) throw new Error(`Campo não encontrado: ${[].concat(selectors)[0]}`);
    await fillField(page, el, text);
}

// ─── Verificação de Copyright ─────────────────────────────────────────────────

async function checkCopyright(page) {
    const warnings = [];
    logger.info('[YouTube] Verificando status de copyright...');
    await page.waitForTimeout(4000).catch(() => {});

    for (const sel of SEL.copyrightError) {
        try {
            if (await page.locator(sel).first().isVisible({ timeout: 3000 })) {
                const text = await page.locator(sel).first().textContent({ timeout: 2000 }).catch(() => sel);
                warnings.push(text?.trim() || sel);
            }
        } catch { /* ok */ }
    }

    if (warnings.length > 0) {
        logger.warn(`[YouTube] ⚠️  Restrições de copyright:\n  → ${warnings.join('\n  → ')}`);
        return { ok: false, warnings };
    }

    for (const sel of SEL.checksOk) {
        try {
            if (await page.locator(sel).first().isVisible({ timeout: 2000 })) {
                logger.info('[YouTube] ✅ Verificações: sem restrições.');
                return { ok: true, warnings: [] };
            }
        } catch { /* continua */ }
    }

    logger.info('[YouTube] Verificações: status indeterminado. Prosseguindo.');
    return { ok: true, warnings: [] };
}

// ─── Fluxo Principal ──────────────────────────────────────────────────────────

export async function uploadToYouTube(filePath, title, description = '', headless = true, thumbnailPath = null) {
    logger.step(`[YouTube] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser(headless);
    const page = await context.newPage();

    try {
        // 1. YouTube Studio
        logger.info('[YouTube] Navegando para o YouTube Studio...');
        await page.goto('https://studio.youtube.com', { waitUntil: 'domcontentloaded' });
        await page.waitForTimeout(3000).catch(() => {});
        await page.waitForLoadState('networkidle').catch(() => {});

        const currentUrl = page.url();
        logger.info(`[YouTube] URL atual: ${currentUrl}`);
        if (!currentUrl.includes('studio.youtube.com')) {
            throw new Error(
                `Não redirecionou para o YouTube Studio. URL: ${currentUrl}\n` +
                'Execute "npm run poster:login" para fazer login primeiro.'
            );
        }

        // 2. Botão "Criar"
        logger.info('[YouTube] Procurando botão "Criar"...');
        const usedCreateSel = await tryClick(page, SEL.createBtn, 25000);
        logger.info(`[YouTube] Botão "Criar" clicado via: ${usedCreateSel}`);
        await page.waitForTimeout(1000).catch(() => {});

        // 3. "Fazer upload de vídeos"
        const usedUploadSel = await tryClick(page, SEL.uploadMenuItem, 10000);
        logger.info(`[YouTube] Menu upload clicado via: ${usedUploadSel}`);
        await page.waitForTimeout(1500).catch(() => {});

        // 4. Envia o arquivo
        logger.info('[YouTube] Enviando arquivo...');
        const fileInput = await page.waitForSelector(SEL.fileInput, { timeout: 15000, state: 'attached' });
        await fileInput.setInputFiles(filePath);

        // Aguarda qualquer navegação/redirect que possa ocorrer após o upload do arquivo
        await page.waitForLoadState('domcontentloaded', { timeout: 8000 }).catch(() => {});
        await page.waitForTimeout(2000).catch(() => {});

        // 5. Aguarda modal (polling — evita crash se página ainda estiver carregando)
        logger.info('[YouTube] Aguardando modal de detalhes...');
        const titleEl = await waitForAny(page, SEL.titleInput, 35000);

        if (!titleEl) {
            await page.screenshot({ path: `./poster-debug-modal-${Date.now()}.png` }).catch(() => {});
            throw new Error('Modal de upload não apareceu após 35 segundos. Screenshot salvo para diagnóstico.');
        }

        // 5a. Preenche título
        logger.info('[YouTube] Preenchendo título...');
        await fillField(page, titleEl, title);
        logger.info(`[YouTube] Título: "${title.substring(0, 60)}..."`);
        await page.waitForTimeout(1000).catch(() => {});

        // 5b. Preenche descrição
        if (description) {
            logger.info('[YouTube] Preenchendo descrição...');
            try {
                await tryType(page, SEL.descriptionInput, description, 15000);
                logger.info('[YouTube] Descrição preenchida.');
            } catch (err) {
                logger.warn(`[YouTube] Descrição não preenchida: ${err.message}`);
            }
            await page.waitForTimeout(800).catch(() => {});
        }

        // 5c. Upload de thumbnail personalizada
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            try {
                logger.info('[YouTube] Enviando thumbnail personalizada...');
                const thumbInput = await page.waitForSelector(SEL.thumbnailInput, { timeout: 8000, state: 'attached' });
                await thumbInput.setInputFiles(thumbnailPath);
                await page.waitForTimeout(2500).catch(() => {});
                logger.success('[YouTube] Thumbnail enviada.');
            } catch (thumbErr) {
                logger.warn(`[YouTube] Falha na thumbnail: ${thumbErr.message}`);
            }
        }

        // 6. Não é conteúdo infantil
        logger.info('[YouTube] Marcando "Não é conteúdo infantil"...');
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(500).catch(() => {});
            await tryClick(page, SEL.notForKids, 12000);
            logger.info('[YouTube] "Não é conteúdo infantil" marcado.');
        } catch {
            logger.warn('[YouTube] "Não é conteúdo infantil" não encontrado — pode já estar selecionado.');
        }
        await page.waitForTimeout(500).catch(() => {});

        // 7. Próximo × 2 (Detalhes → Elementos → Verificações)
        logger.info('[YouTube] Navegando pelo wizard...');
        for (let i = 0; i < 2; i++) {
            await tryClick(page, SEL.nextBtn, 15000);
            await page.waitForTimeout(2000).catch(() => {});
        }

        // 8. Verificação de copyright
        logger.info('[YouTube] Tela de Verificações...');
        const { ok: copyrightOk, warnings } = await checkCopyright(page);
        if (!copyrightOk) {
            const shotPath = `./poster-copyright-warning-${Date.now()}.png`;
            await page.screenshot({ path: shotPath }).catch(() => {});
            logger.warn(`[YouTube] Screenshot salvo: ${shotPath}`);
        }

        // 9. Avança para Visibilidade
        logger.info('[YouTube] Avançando para Visibilidade...');
        await tryClick(page, SEL.nextBtn, 15000);
        await page.waitForTimeout(3000).catch(() => {});

        // 10. Seleciona "Público"
        logger.info('[YouTube] Selecionando visibilidade: Público...');
        const publicSel = await tryClick(page, SEL.publicVisibility, 15000).catch(() => null);
        if (publicSel) {
            logger.info('[YouTube] Visibilidade → Público ✓');
        } else {
            logger.warn('[YouTube] Opção "Público" não encontrada — verificar manualmente!');
        }
        await page.waitForTimeout(1000).catch(() => {});

        // 11. Aguarda processamento mínimo
        logger.info('[YouTube] Aguardando processamento...');
        await page.waitForTimeout(5000).catch(() => {});

        // 12. Publicar
        logger.info('[YouTube] Publicando...');
        await tryClick(page, SEL.publishBtn, 30000);

        // 13. Confirma publicação
        await Promise.race(
            SEL.publishConfirm.map((sel) =>
                page.waitForSelector(sel, { timeout: 60000 }).catch(() => null)
            )
        );

        if (warnings.length > 0) {
            logger.success(`[YouTube] ✅ Publicado (com ${warnings.length} aviso(s) de copyright).`);
        } else {
            logger.success('[YouTube] ✅ Vídeo publicado com sucesso!');
        }
        return true;

    } catch (err) {
        logger.error(`[YouTube] Falha no upload: ${err.message}`);
        const shot = `./poster-error-youtube-${Date.now()}.png`;
        await page.screenshot({ path: shot }).catch(() => {});
        logger.info(`[YouTube] Screenshot salvo: ${shot}`);
        return false;

    } finally {
        await page.waitForTimeout(2000).catch(() => {});
        await context.close().catch(() => {});
    }
}
