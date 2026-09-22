// poster/uploaders/youtube.js
// Automatiza o upload de um Shorts no YouTube Studio via Playwright.
// Usa um perfil persistente do Chromium para manter sessão após login manual.
// Verifica restrições de copyright antes de publicar.

import { chromium } from 'playwright';
import path from 'node:path';
import fs from 'node:fs';
import { logger } from '../logger.js';
import { humanType, humanClick } from '../human-behavior.js';

const DEFAULT_PROFILE_DIR = path.resolve('./profiles/chrome-youtube');

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
    madeForKids: [
        'tp-yt-paper-radio-button[name="VIDEO_MADE_FOR_KIDS_MFK"]',
        '#radioLabel:has-text("Sim, é conteúdo")',
        '#radioLabel:has-text("Yes, it")',
        'ytcp-radio-group ytcp-radio-button:first-child #radioLabel',
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
        'ytcp-stepper-footer ytcp-button',
        'button[aria-label="Próximo"]',
        'button[aria-label="Next"]',
        'button[aria-label="Avançar"]',
        'ytcp-button:has-text("Próximo")',
        'ytcp-button:has-text("Next")',
        'ytcp-button:has-text("Avançar")',
        '[id="next-button"]',
        '#next-button',
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
        'div[role="dialog"] a[href*="/shorts/"]',
        '.ytcp-video-share-url',
    ],
    // Marca o modal "Video published"/"Vídeo publicado" que o Studio mostra
    // quando o upload já foi concluído — usado como checagem final de
    // segurança antes de declarar falha (ver isVideoPublished).
    publishedDialog: [
        ':text("Video published")',
        ':text("Vídeo publicado")',
        'div[role="dialog"] a[href*="youtube.com/shorts/"]',
        'div[role="dialog"] a[href*="youtu.be/"]',
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

async function launchBrowser(headless, profileDir = DEFAULT_PROFILE_DIR) {
    logger.info(`[YouTube] Perfil: ${profileDir}`);
    return chromium.launchPersistentContext(profileDir, {
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
                    // Clique físico humanizado (ghost-cursor); se falhar por qualquer
                    // motivo cai pro clique normal do Playwright — o laço externo
                    // desta função já tolera e reretenta em caso de exceção.
                    await humanClick(page, el).catch(() => el.click());
                    return sel;
                }
            } catch { /* tenta o próximo */ }
        }
        await page.waitForTimeout(800).catch(() => {});
    }
    throw new Error(`Nenhum seletor funcionou: ${list.slice(0, 2).join(', ')} ...`);
}

/**
 * Checagem de segurança: mesmo que um passo do wizard (ex.: clique em
 * "Publicar") tenha lançado erro por seletor desatualizado, o vídeo pode já
 * ter sido publicado de fato — o Studio troca o modal para "Video published"
 * quase instantaneamente. Sem essa checagem, esses casos eram registrados
 * como falha e o clipe reentrava na fila, arriscando duplicata.
 * @returns {Promise<boolean>}
 */
async function isVideoPublished(page) {
    for (const sel of SEL.publishedDialog) {
        try {
            if (await page.locator(sel).first().isVisible({ timeout: 1500 })) return true;
        } catch { /* tenta o próximo */ }
    }
    return false;
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
 *
 * Antes isso era feito disparando um ClipboardEvent('paste') sintético via
 * page.evaluate(). Dois problemas com isso, descobertos revisando o pipeline:
 *   1. O evento tem isTrusted=false e quase nunca lança exceção — então a
 *      variável que checava "deu certo" ficava sempre true mesmo quando o
 *      editor do YouTube Studio ignorava o evento sintético e o campo
 *      continuava vazio (o fallback de digitação real nunca era acionado).
 *      Isso explica descrições saindo em branco sem nenhum erro no log.
 *   2. Eventos DOM sintéticos (isTrusted=false) são um sinal clássico de
 *      automação para heurísticas anti-bot.
 * Agora usa page.keyboard.type() (input real via CDP, mesmo mecanismo já
 * usado com sucesso no caption do TikTok) e confere se o texto realmente
 * apareceu no campo antes de seguir, tentando de novo uma vez se não bateu.
 */
async function fillField(page, el, text) {
    for (let attempt = 1; attempt <= 2; attempt++) {
        await el.scrollIntoViewIfNeeded().catch(() => {});
        await el.click({ force: true });
        await page.waitForTimeout(300).catch(() => {});

        // Seleciona e apaga o conteúdo atual do campo
        await page.keyboard.press('Control+a');
        await page.waitForTimeout(100).catch(() => {});
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(150).catch(() => {});

        // Digitação real (trusted input) — evita o problema do paste sintético acima
        await humanType(page, text);
        await page.waitForTimeout(400).catch(() => {});
        // NÃO pressiona Escape aqui: quando não há popup de autocomplete aberto
        // (comum ao digitar o título), o Escape fecha o MODAL DE UPLOAD INTEIRO
        // em vez de só a sugestão — foi isso que causou o vídeo publicar sem
        // descrição/miniatura/visibilidade (o diálogo fechava logo após o título).
        // Clicar no próximo campo (feito pela próxima chamada de fillField) já
        // dispensa qualquer sugestão aberta ao tirar o foco deste campo.

        const current = (await el.innerText().catch(() => '')).trim();
        if (current.length > 0 && current.replace(/\s+/g, ' ').includes(text.trim().slice(0, 20).replace(/\s+/g, ' '))) {
            return;
        }
        logger.warn(`[YouTube] Campo não confirmou o texto na tentativa ${attempt}/2 (conteúdo atual: "${current.slice(0, 40)}").`);
    }
    throw new Error('Campo não aceitou o texto digitado após 2 tentativas.');
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

/**
 * Aguarda o envio do arquivo terminar antes de publicar.
 * Shorts (~10 MB) terminam antes do wizard acabar, mas vídeos longos (centenas
 * de MB) ainda estão em "Enviando X%" quando chegamos na tela de Visibilidade —
 * clicar em Publicar nesse estado deixa o botão inerte e o fluxo antigo
 * estourava o timeout e FECHAVA o navegador no meio do envio (vídeo preso em
 * rascunho a X%). Faz polling do texto de progresso do modal até ele parar de
 * dizer "Enviando/Uploading".
 */
/**
 * Classifica o texto do label de progresso do Studio.
 *
 * ATENÇÃO: "Checking X%" / "Verificando X%" NÃO significa envio concluído —
 * o YouTube ainda está recebendo/analisando o arquivo. Tratar esse estado como
 * pronto foi o que deixou os vídeos longos presos em "Envio interrompido":
 * o robô publicava e fechava o navegador no meio da transferência.
 */
function parseProgressState(text) {
    if (!text) return 'ausente';
    const t = text.trim().toLowerCase();
    const pctMatch = t.match(/(\d{1,3})\s*%/);
    const pct = pctMatch ? parseInt(pctMatch[1], 10) : null;

    // Sinais de que os bytes já chegaram (transcodificação/checagem final)
    if (/(envio conclu|upload complete|uploaded|processando|processing|verifica[çc][õo]es conclu|checks? complete)/i.test(t)) {
        return 'concluido';
    }
    // Ainda transferindo ou analisando o arquivo
    if (/(enviando|uploading|fazendo upload|checking|verificando)/i.test(t)) {
        return pct !== null && pct >= 100 ? 'concluido' : 'enviando';
    }
    return 'ausente';
}

async function readProgressLabel(page) {
    return page
        .locator('ytcp-video-upload-progress .progress-label, span.progress-label')
        .first()
        .textContent({ timeout: 3000 })
        .catch(() => null);
}

// Segundo sinal de progresso, independente do texto: barra de progresso via
// aria-valuenow. Só é usado como confirmação POSITIVA (>=100) — nunca como
// base pra "adivinhar" conclusão a partir da ausência de alguma coisa.
async function readProgressBarPercent(page) {
    try {
        const el = page.locator('ytcp-video-upload-progress [role="progressbar"], [role="progressbar"]').first();
        const val = await el.getAttribute('aria-valuenow', { timeout: 1500 });
        return val !== null ? parseFloat(val) : null;
    } catch {
        return null;
    }
}

async function waitForUploadComplete(page, fileSizeMB) {
    // ~1 min por 10 MB, mínimo 15 min, teto configurável (padrão 90 min).
    // A checagem final do YouTube costuma anunciar "10 minutes left" mesmo em
    // arquivos pequenos, então o piso é generoso de propósito.
    const capMin = parseInt(process.env.YT_UPLOAD_WAIT_MAX_MIN || '90', 10);
    const timeoutMs = Math.min(capMin, Math.max(15, Math.ceil(fileSizeMB / 10))) * 60_000;
    const deadline = Date.now() + timeoutMs;
    let lastLogged = '';

    // IMPORTANTE: já tivemos DOIS falsos positivos reais em produção tentando
    // "adivinhar" conclusão a partir da AUSÊNCIA de algo (label sumiu; depois
    // botão de publicar habilitado) — nos dois casos o Studio já deixava o
    // botão clicável / o label sumia com o envio ainda em andamento (~82%),
    // e o vídeo saía sem publicar de fato. Por isso agora só existem sinais
    // POSITIVOS e explícitos de conclusão (texto "concluído/checks complete"
    // ou barra em 100%). Sem eles, o código espera até o timeout calculado
    // pelo tamanho do arquivo — mais lento, mas nunca clica Publicar cedo.
    while (Date.now() < deadline) {
        const text = await readProgressLabel(page);
        const state = parseProgressState(text);

        if (state === 'concluido') {
            logger.info(`[YouTube] Envio do arquivo concluído (${text.trim()}).`);
            return true;
        }

        const pct = await readProgressBarPercent(page);
        if (pct !== null && pct >= 100) {
            logger.info(`[YouTube] Barra de progresso em 100% — envio concluído.`);
            return true;
        }

        if (state !== 'ausente') {
            const clean = text.trim();
            if (clean !== lastLogged) {
                logger.info(`[YouTube] ${clean} (aguardando o envio terminar...)`);
                lastLogged = clean;
            }
        }

        await page.waitForTimeout(10_000).catch(() => {});
    }

    logger.error(`[YouTube] Envio NÃO terminou em ${Math.round(timeoutMs / 60_000)}min.`);
    return false;
}

/**
 * Depois de publicar, segura o navegador aberto enquanto o Studio ainda estiver
 * transferindo. Fechar antes disso é exatamente o que produz o estado
 * "Envio interrompido — Retomar o envio" no painel.
 */
async function waitBeforeClosing(page, fileSizeMB) {
    const capMin = parseInt(process.env.YT_UPLOAD_WAIT_MAX_MIN || '90', 10);
    const deadline = Date.now() + Math.min(capMin, Math.max(10, Math.ceil(fileSizeMB / 10))) * 60_000;

    while (Date.now() < deadline) {
        const state = parseProgressState(await readProgressLabel(page));
        if (state !== 'enviando') return true;
        logger.info('[YouTube] Ainda enviando após publicar — mantendo o navegador aberto...');
        await page.waitForTimeout(15_000).catch(() => {});
    }
    logger.warn('[YouTube] Tempo esgotado aguardando o fim do envio antes de fechar.');
    return false;
}

// ─── Fluxo Principal ──────────────────────────────────────────────────────────

export async function uploadToYouTube(filePath, title, description = '', headless = true, thumbnailPath = null, profileDir = DEFAULT_PROFILE_DIR, madeForKids = false) {
    logger.step(`[YouTube] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser(headless, profileDir);
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

        // Sanity check: confirma que o modal de upload ainda está aberto antes de
        // seguir. Sem isso, se o diálogo fechar sozinho por qualquer motivo, o
        // código gastava 15-20s tentando achar campos que nunca mais vão aparecer
        // e o vídeo publicava incompleto (sem descrição/miniatura/visibilidade).
        const stillInModal = await page.locator(SEL.titleInput[0]).first().isVisible({ timeout: 3000 }).catch(() => false);
        if (!stillInModal) {
            const shotPath = `./poster-error-modal-closed-${Date.now()}.png`;
            await page.screenshot({ path: shotPath }).catch(() => {});
            throw new Error(`O modal de upload fechou sozinho logo após o título. Screenshot: ${shotPath}`);
        }

        // 5b. Preenche descrição
        if (description) {
            logger.info('[YouTube] Preenchendo descrição...');
            try {
                await tryType(page, SEL.descriptionInput, description, 15000);
                logger.info('[YouTube] Descrição preenchida.');
            } catch (err) {
                // Antes era só um warning e o vídeo seguia sem descrição, silenciosamente.
                // Com fillField() agora verificando o conteúdo antes de dar certo, chegar
                // aqui é raro — mas quando acontece precisa ficar visível, não escondido.
                logger.error(`[YouTube] ⚠️  Descrição NÃO foi preenchida — vídeo vai publicar sem descrição: ${err.message}`);
                const shotPath = `./poster-warning-no-description-${Date.now()}.png`;
                await page.screenshot({ path: shotPath }).catch(() => {});
                logger.error(`[YouTube] Screenshot salvo: ${shotPath}`);
            }
            await page.waitForTimeout(800).catch(() => {});
        }

        // 5c. Upload de thumbnail personalizada
        if (thumbnailPath && fs.existsSync(thumbnailPath)) {
            try {
                logger.info('[YouTube] Enviando thumbnail personalizada...');

                // NÃO clicar em nada antes: o input#file-loader já fica attached no
                // DOM (só oculto visualmente) desde que o modal de detalhes abre —
                // setInputFiles funciona em input[type=file] oculto, não precisa de
                // clique pra "revelar". Um clique aqui é só risco: o seletor genérico
                // que existia antes ([aria-label*="miniatura"]) batia primeiro no link
                // real "Saiba mais sobre as miniaturas" da UI (a[aria-label="Saiba
                // mais sobre as miniaturas"]) — clicar nisso abre o artigo de ajuda do
                // YouTube ("Adicionar miniaturas personalizadas no YouTube") em vez do
                // seletor de arquivo, e a thumbnail nunca é enviada de verdade
                // (achado em produção, relatado pelo usuário em 17/09/2026).
                const thumbInput = await page.waitForSelector(SEL.thumbnailInput, { timeout: 10000, state: 'attached' });
                await thumbInput.setInputFiles(thumbnailPath);
                await page.waitForTimeout(2500).catch(() => {});
                logger.success('[YouTube] Thumbnail enviada.');
            } catch (thumbErr) {
                logger.warn(`[YouTube] Falha na thumbnail: ${thumbErr.message}`);
            }
        }

        // 6. Público-alvo (obrigatório e sujeito a regras de proteção infantil).
        // Canal infantil PRECISA marcar "feito para crianças"; declarar errado
        // é violação das regras do YouTube/COPPA, não só um detalhe de metadado.
        const rotulo = madeForKids ? 'É conteúdo para crianças' : 'Não é conteúdo infantil';
        logger.info(`[YouTube] Marcando "${rotulo}"...`);
        try {
            await page.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
            await page.waitForTimeout(500).catch(() => {});
            await tryClick(page, madeForKids ? SEL.madeForKids : SEL.notForKids, 12000);
            logger.info(`[YouTube] "${rotulo}" marcado.`);
        } catch {
            logger.warn(`[YouTube] "${rotulo}" não encontrado — verificar manualmente!`);
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

        // 11. Aguarda o ENVIO do arquivo terminar (crítico para vídeos longos)
        const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
        logger.info(`[YouTube] Aguardando envio do arquivo (${Math.round(fileSizeMB)} MB)...`);
        const enviado = await waitForUploadComplete(page, fileSizeMB);

        // Publicar com o arquivo ainda subindo deixa o vídeo preso em
        // "Envio interrompido" — melhor falhar e deixar o clipe para o próximo
        // ciclo do que registrar como publicado algo que não foi.
        if (!enviado) {
            const shot = `./poster-error-youtube-${Date.now()}.png`;
            await page.screenshot({ path: shot }).catch(() => {});
            logger.error(`[YouTube] Abortando publicação — envio incompleto. Screenshot: ${shot}`);
            return false;
        }

        // 12. Publicar
        logger.info('[YouTube] Publicando...');
        try {
            await tryClick(page, SEL.publishBtn, 30000);
        } catch (clickErr) {
            // O botão pode já ter sido clicado (ou o Studio publicou sem ele)
            // antes do seletor conseguir confirmar — checa o modal de sucesso
            // antes de desistir, senão um vídeo publicado é registrado como
            // falha e o clipe volta pra fila arriscando duplicata.
            if (!(await isVideoPublished(page))) throw clickErr;
            logger.warn('[YouTube] Botão "Publicar" não respondeu a tempo, mas o modal de publicação já apareceu — seguindo como sucesso.');
        }

        // 13. Confirma publicação
        await Promise.race(
            SEL.publishConfirm.map((sel) =>
                page.waitForSelector(sel, { timeout: 60000 }).catch(() => null)
            )
        );

        // 14. Só fecha o navegador quando o Studio parar de transferir
        await waitBeforeClosing(page, fileSizeMB);

        if (warnings.length > 0) {
            logger.success(`[YouTube] ✅ Publicado (com ${warnings.length} aviso(s) de copyright).`);
        } else {
            logger.success('[YouTube] ✅ Vídeo publicado com sucesso!');
        }
        return true;

    } catch (err) {
        // Rede de segurança final: qualquer passo depois do upload em si
        // (thumbnail, verificações, wizard de visibilidade) pode lançar por
        // seletor desatualizado mesmo com o vídeo já publicado de fato —
        // checa o modal de sucesso antes de declarar falha e reenfileirar
        // um clipe que na verdade já foi ao ar.
        if (await isVideoPublished(page).catch(() => false)) {
            logger.warn(`[YouTube] Falha em "${err.message}", mas o modal de publicação está visível — vídeo já publicado, seguindo como sucesso.`);
            return true;
        }
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
