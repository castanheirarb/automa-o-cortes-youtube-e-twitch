// poster/uploaders/tiktok.js
// Automatiza o upload de um vídeo no TikTok via Playwright.
// Usa um perfil persistente do Chrome para manter a sessão após login manual.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger.js';

// Perfil persistente do Playwright — sessão salva com npm run poster:login
// Usa o Chrome real como executável para máxima compatibilidade.
const DEFAULT_PROFILE_DIR = path.resolve('./profiles/chrome-tiktok');

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

async function launchBrowser(profileDir = DEFAULT_PROFILE_DIR) {
    logger.info(`[TikTok] Perfil: ${profileDir}`);
    return chromium.launchPersistentContext(profileDir, {
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
 * Fecha o tour de onboarding (react-joyride) que o TikTok mostra em contas
 * novas/recém-logadas no Creator Center. O overlay dele intercepta cliques
 * em qualquer elemento por baixo (ex.: o campo de legenda), travando o
 * upload com "Timeout ... element intercepts pointer events". Tenta os
 * botões usuais de fechar; se não achar nenhum, cai pra Escape.
 */
async function dismissOnboardingTour(page) {
    const overlaySel = '.react-joyride__overlay, [data-test-id="overlay"], #react-joyride-portal';
    const hasOverlay = await page.locator(overlaySel).first().isVisible({ timeout: 1500 }).catch(() => false);
    if (!hasOverlay) return;

    logger.info('[TikTok] Tour de onboarding detectado — fechando...');
    const closeSelectors = [
        'button:has-text("Pular")', 'button:has-text("Skip")',
        'button:has-text("Concluir")', 'button:has-text("Got it")', 'button:has-text("Entendi")',
        '[data-test-id="close-icon"]', 'button[aria-label="Close"]', 'button[aria-label="Fechar"]',
    ];
    for (const sel of closeSelectors) {
        try {
            const el = page.locator(sel).first();
            if (await el.isVisible({ timeout: 1000 })) {
                await el.click({ timeout: 2000 });
                await page.waitForTimeout(500);
                break;
            }
        } catch { /* tenta o próximo */ }
    }
    // Ainda visível? Escape costuma fechar o joyride também.
    if (await page.locator(overlaySel).first().isVisible({ timeout: 1000 }).catch(() => false)) {
        await page.keyboard.press('Escape').catch(() => {});
        await page.waitForTimeout(500);
    }
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
export async function uploadToTikTok(filePath, caption, headless = true, profileDir = DEFAULT_PROFILE_DIR) {
    logger.step(`[TikTok] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser(profileDir);
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
        await dismissOnboardingTour(page);

        // 1b. O TikTok às vezes redireciona para outra seção do Studio (ex: Monetização)
        // em vez de ficar na página de upload — quando isso acontece o input de arquivo
        // nunca aparece e o upload trava. Detecta e tenta corrigir clicando em "Carregar".
        if (!page.url().includes('/upload')) {
            logger.warn(`[TikTok] Redirecionado para fora do upload (${page.url()}) — tentando via botão "Carregar"...`);
            try {
                await page.locator('button:has-text("Carregar"), a:has-text("Carregar"), button:has-text("Upload")').first().click({ timeout: 10000 });
                await page.waitForTimeout(2000);
            } catch { /* segue mesmo assim — a checagem do fileInput abaixo vai falhar com erro claro */ }

            if (!page.url().includes('/upload')) {
                throw new Error(`TikTok não abriu a página de upload (URL atual: ${page.url()}).`);
            }
        }

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
        // Vídeos longos (centenas de MB) demoram bem mais que os 5 min dos Shorts:
        // escala ~1 min por 50 MB (mín. 5, teto TT_UPLOAD_WAIT_MAX_MIN, padrão 90).
        const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
        const capMin = parseInt(process.env.TT_UPLOAD_WAIT_MAX_MIN || '90', 10);
        const waitMin = Math.min(capMin, Math.max(5, Math.ceil(fileSizeMB / 50)));
        logger.info(`[TikTok] Aguardando processamento do vídeo (${Math.round(fileSizeMB)} MB — até ${waitMin} min)...`);
        await page.waitForTimeout(5000); // pausa inicial para o iframe montar

        const CAPTION_SELECTORS = [
            '[data-text="true"]',
            '.public-DraftEditor-content',
            '.DraftEditor-editorContainer [contenteditable="true"]',
            '[contenteditable="true"][spellcheck]',
            'div[contenteditable="true"]',
        ];

        // O campo de legenda fica visível/interagível assim que a tela de
        // detalhes renderiza — ou seja, LOGO NO INÍCIO do envio, com a barra
        // de progresso (ex.: "70.67% ... Faltam 27 segundos") ainda visível
        // ao lado. Usá-lo sozinho como sinal de "pronto" clica em Publicar
        // com o arquivo ainda subindo (o vídeo nunca sai do rascunho). Por
        // isso também é preciso confirmar que o indicador de progresso (%)
        // sumiu antes de seguir.
        async function uploadPercentStillVisible() {
            try {
                return await page.locator('text=/\\d{1,3}(\\.\\d+)?%/').first().isVisible({ timeout: 1000 });
            } catch {
                return false;
            }
        }

        let captionEl = null;
        const MAX_WAIT_MS = waitMin * 60 * 1000;
        const POLL_MS = 5_000;
        const startTime = Date.now();

        while (Date.now() - startTime < MAX_WAIT_MS) {
            // Tenta re-obter o frame a cada iteração (TikTok pode recarregar o iframe)
            const currentFrame = await getUploadFrame(page);

            let candidate = null;
            for (const sel of CAPTION_SELECTORS) {
                try {
                    const el = await currentFrame.waitForSelector(sel, { timeout: 3000, state: 'visible' });
                    if (el) { candidate = el; break; }
                } catch { /* tenta o próximo */ }
            }

            if (candidate && !(await uploadPercentStillVisible())) {
                captionEl = candidate;
                break;
            }

            const elapsed = Math.round((Date.now() - startTime) / 1000);
            logger.info(`[TikTok] Processando... ${elapsed}s / ${MAX_WAIT_MS / 1000}s`);
            await page.waitForTimeout(POLL_MS);
        }

        if (!captionEl) {
            throw new Error(`Vídeo não processou em ${waitMin} minutos — TikTok pode estar com lentidão.`);
        }

        // 5. Preenche a legenda
        // Re-obtém o frame e o elemento para evitar referência stale após o poll loop.
        // O TikTok usa Draft.js (editor rico contenteditable): o texto deve ser
        // digitado via page.keyboard.type() (nível de página), não element.type(),
        // pois Draft.js só reconhece eventos de teclado disparados no documento.
        await dismissOnboardingTour(page);
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

        // Fecha autocomplete de hashtags (Escape) e aguarda fechar
        await page.waitForTimeout(500);
        await page.keyboard.press('Escape');
        await page.waitForTimeout(800);

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

        // 6b. Se a verificação de conteúdo ainda não terminou, o TikTok abre um
        // segundo modal ("Continuar publicando? Ainda estamos verificando...")
        // pedindo confirmação extra — sem esse clique o vídeo fica em rascunho,
        // nunca publica, e o resto do fluxo trava esperando um redirect que
        // nunca vem.
        try {
            const confirmBtn = page.locator('button:has-text("Publicar agora"), button:has-text("Post now")').first();
            if (await confirmBtn.isVisible({ timeout: 5000 })) {
                logger.info('[TikTok] Modal de verificação em andamento — confirmando "Publicar agora"...');
                await confirmBtn.click({ timeout: 5000 });
                await page.waitForTimeout(500);
            }
        } catch { /* modal não apareceu — segue normalmente */ }

        // 6c. O TikTok Studio é uma SPA — depois de publicar, a URL costuma NÃO
        // mudar (o wait por URL abaixo dá timeout quase sempre, mesmo quando
        // publicou de verdade). Sinal mais confiável: os botões "Salvar
        // rascunho"/"Descartar" só existem ENQUANTO o post ainda não foi
        // publicado — eles somem assim que a publicação é confirmada.
        try {
            const draftControls = page.locator('button:has-text("Salvar rascunho"), button:has-text("Save draft")').first();
            const draftGone = await draftControls
                .waitFor({ state: 'hidden', timeout: 20000 })
                .then(() => true)
                .catch(() => false);
            if (draftGone) {
                uploaded = true;
                logger.success('[TikTok] ✅ Vídeo publicado (controles de rascunho sumiram da tela).');
            }
        } catch { /* segue pro próximo sinal */ }

        // 7. Aguarda saída da página de upload (qualquer URL diferente da atual)
        if (!uploaded) {
        const uploadUrl = page.url();
        const redirectResult = await Promise.race([
            page.waitForURL('**/creator-center/content**', { timeout: 60000 }).then(() => 'content'),
            page.waitForURL('**/manage/posts**', { timeout: 60000 }).then(() => 'posts'),
            page.waitForURL((url) => !url.includes('/upload'), { timeout: 60000 }).then(() => 'other'),
            page.waitForURL('**/creator-center/upload**', { timeout: 60000 }).then(() => 'upload_again'),
        ]).catch(() => 'timeout');

        if (redirectResult === 'content' || redirectResult === 'posts' || redirectResult === 'other') {
            uploaded = true;
            logger.success(`[TikTok] ✅ Vídeo publicado com sucesso! (${redirectResult})`);
        } else if (redirectResult === 'upload_again') {
            // TikTok às vezes redireciona de volta ao upload após publicar
            // Verifica se a URL mudou de fato (parâmetros diferentes)
            if (page.url() !== uploadUrl) {
                uploaded = true;
                logger.success('[TikTok] ✅ Vídeo publicado (redirecionou para nova sessão de upload).');
            } else {
                logger.warn('[TikTok] Redirecionou para upload sem mudança de URL — verifique manualmente.');
            }
        } else if (page.url() !== uploadUrl) {
            // A URL mudou para algo que nenhum dos padrões conhecidos previa,
            // mas mudou — o TikTok já reformulou essas rotas antes, então
            // qualquer navegação para fora da URL de upload é sinal de sucesso.
            uploaded = true;
            logger.success(`[TikTok] ✅ Vídeo publicado (navegou para ${page.url()}).`);
        } else {
            // timeout e URL idêntica — o vídeo provavelmente foi publicado mesmo assim
            // (o botão "Publicar" costuma sumir da tela após o clique de sucesso)
            try {
                const btnStillVisible = await uploadFrame.locator('button:has-text("Publicar"), button:has-text("Post"), button:has-text("Postar")').first().isVisible({ timeout: 3000 });
                if (!btnStillVisible) {
                    uploaded = true;
                    logger.success('[TikTok] ✅ Vídeo publicado (botão sumiu após clique).');
                } else {
                    // Caso ambíguo — relatos indicam que o vídeo costuma publicar mesmo
                    // assim. Salva screenshot aqui (não só em exceções) para dar evidência
                    // real da tela nesse momento e calibrar a detecção com precisão.
                    const shotPath = `./poster-ambiguous-tiktok-${Date.now()}.png`;
                    await page.screenshot({ path: shotPath }).catch(() => {});
                    logger.warn(`[TikTok] Sem redirecionamento confirmado (timeout) — verifique manualmente. Screenshot: ${shotPath}`);
                }
            } catch {
                const shotPath = `./poster-ambiguous-tiktok-${Date.now()}.png`;
                await page.screenshot({ path: shotPath }).catch(() => {});
                logger.warn(`[TikTok] Sem redirecionamento confirmado (timeout) — verifique manualmente. Screenshot: ${shotPath}`);
            }
        }
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
