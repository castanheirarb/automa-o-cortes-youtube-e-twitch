// poster/uploaders/instagram.js
// Automatiza o upload de um Reel no Instagram via Playwright.
// Usa um perfil persistente do Chrome para manter a sessão após login manual
// (node poster/login.js --platform instagram, ou o login automático em
// poster/login.js quando UPLOAD_TO_INSTAGRAM=true).
//
// Fluxo validado ponta a ponta em 2026-09-14 (conta dedicada c0rtecerto034):
// login isolado via perfil Playwright + upload real + publicação CONFIRMADA
// de duas formas — pela tela "Reel compartilhado" E pelo post count real do
// perfil (0 → 1 post, verificado visualmente, não só o script dizendo que
// deu certo). Duas armadilhas reais encontradas no caminho, que valem a pena
// lembrar se algo quebrar de novo:
//   1. Clique físico normal (mesmo com force:true) pode ser redirecionado
//      pelo BROWSER pra outro elemento se algo estiver sobreposto na mesma
//      coordenada (force só pula a checagem do Playwright, não o hit-test
//      real) — já clicou a seta de voltar em vez do botão certo. Por isso
//      "Novo post"/"Avançar"/dismiss de modais usam dispatch via DOM
//      (el.click() via evaluate) em vez de clique físico.
//   2. EXCEÇÃO: o botão final "Compartilhar" PRECISA de clique físico de
//      verdade (isTrusted:true) — o dispatch via DOM roda sem erro e até
//      "parece" funcionar (o modal de criação reage), mas a publicação não
//      acontece de verdade (post count no perfil fica em 0). Não trocar essa
//      por dispatch mesmo que pareça mais "seguro".
// Ainda não testado: tolerância do Instagram a upload headless de verdade
// (todo teste até agora rodou com headless:false).

import { chromium } from 'playwright';
import path from 'node:path';
import { logger } from '../logger.js';
import { humanType, humanClick, humanPause } from '../human-behavior.js';

// Perfil persistente do Playwright — sessão salva com npm run poster:login
const DEFAULT_PROFILE_DIR = path.resolve('./profiles/chrome-instagram');

const CHROME_EXEC = process.env.CHROME_PATH
    || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';

// Seletores do fluxo de criação de Reel do Instagram Web (confirmados em
// 2026-09-14 — ver nota acima). Classes CSS do Instagram são atômicas/geradas
// (ex.: "x1i10hfl xjqpnuy...") e mudam a cada build — nunca usar como
// seletor. aria-label e texto visível são os únicos pontos estáveis.
const SELECTORS = {
    createButton: 'svg[aria-label="Novo post"], svg[aria-label="New post"]',
    fileInput: 'input[type="file"]',
    // Modal informativo "Agora os posts de vídeo são compartilhados como
    // reels" — aparece pelo menos na primeira vez após enviar o arquivo.
    reelsInfoOkButton: 'div[role="button"]:has-text("OK")',
    // Modal "Ativar notificações" — aparece na primeira visita de um perfil
    // novo e bloqueia cliques em qualquer coisa atrás dele.
    notificationsDismiss: 'button:has-text("Agora não"), button:has-text("Not now"), div[role="button"]:has-text("Agora não"), div[role="button"]:has-text("Not now")',
    nextButton: 'div[role="button"]:has-text("Avançar"), div[role="button"]:has-text("Next")',
    // Instagram usa um editor Lexical (contenteditable simples) — diferente
    // do Draft.js do TikTok, aceita digitação direta via page.keyboard.type
    // sem precisar de tratamento especial.
    captionInput: 'div[aria-label="Adicione uma legenda..."][role="textbox"], div[aria-label="Write a caption..."][role="textbox"]',
    shareButton: 'div[role="button"]:has-text("Compartilhar"), div[role="button"]:has-text("Share")',
};

async function launchBrowser(profileDir = DEFAULT_PROFILE_DIR) {
    logger.info(`[Instagram] Perfil: ${profileDir}`);
    return chromium.launchPersistentContext(profileDir, {
        executablePath: CHROME_EXEC,
        // Precaução: tolerância do Instagram a upload headless ainda não foi
        // testada (TikTok já força false por bloquear headless) — mantém
        // false até confirmar que headless funciona de verdade.
        headless: false,
        args: [
            '--no-sandbox',
            '--disable-blink-features=AutomationControlled',
            '--disable-features=IsolateOrigins,site-per-process',
        ],
        viewport: null,
        ignoreDefaultArgs: ['--enable-automation'],
    });
}

/**
 * Faz upload de um Reel no Instagram.
 *
 * @param {string} filePath
 * @param {string} caption  - Legenda com hashtags (poster/metadata.js formatInstagramCaption)
 * @param {boolean} headless
 * @param {string} profileDir
 * @returns {Promise<boolean>} true = publicado com sucesso confirmado; false = falhou
 */
export async function uploadToInstagram(filePath, caption, headless = true, profileDir = DEFAULT_PROFILE_DIR) {
    logger.step(`[Instagram] Iniciando upload: ${path.basename(filePath)}`);

    const context = await launchBrowser(profileDir);
    const page = await context.newPage();
    let uploaded = false;

    try {
        logger.info('[Instagram] Navegando para o feed...');
        await page.goto('https://www.instagram.com/', {
            waitUntil: 'domcontentloaded',
            timeout: 30000,
        });
        await page.waitForTimeout(3000);

        // 0. Dispensa o modal "Ativar notificações" se aparecer (perfil novo)
        try {
            const notifDismiss = page.locator(SELECTORS.notificationsDismiss).first();
            if (await notifDismiss.isVisible({ timeout: 4000 })) {
                await notifDismiss.evaluate((el) => el.click());
                await page.waitForTimeout(500);
            }
        } catch { /* modal não apareceu — segue */ }

        // 1. Abre o modal de criação de publicação
        // O ícone fica dentro de um link da barra lateral que mostra um
        // tooltip ao passar o mouse — esse tooltip intercepta o clique físico
        // normal (elemento por cima bloqueando o pointer event), então força
        // o clique e cai pro dispatch via JS se ainda assim não registrar.
        logger.info('[Instagram] Abrindo criação de publicação...');
        const createEl = page.locator(SELECTORS.createButton).first();
        await createEl.waitFor({ state: 'visible', timeout: 15000 });
        // Clique físico (mesmo com force:true) pode ser redirecionado pelo
        // browser pra outro elemento se algo estiver sobreposto na MESMA
        // coordenada (force só pula a checagem de actionability do
        // Playwright, não o hit-test real do navegador) — já causou um clique
        // fantasma na seta de voltar em vez do botão certo. dispatch via DOM
        // el.click() ignora hit-test de coordenada e é o caminho confiável.
        await createEl.evaluate((el) => el.closest('a, div[role="button"]')?.click());
        await page.waitForTimeout(1000);

        // A partir daqui, TODA busca de elemento fica restrita a este diálogo
        // — o feed de fundo tem seu próprio botão "Compartilhar" (o ícone de
        // enviar/compartilhar post por DM, que abre um painel de
        // compartilhamento externo completamente diferente) e uma busca sem
        // escopo já acertou ele por engano em vez do botão de publicar do
        // editor de Reel (achado na prática).
        const dialog = page.locator('div[role="dialog"]').first();
        await dialog.waitFor({ state: 'visible', timeout: 15000 });

        // 2. Envia o arquivo
        logger.info('[Instagram] Enviando arquivo...');
        const fileInputLoc = dialog.locator(SELECTORS.fileInput).first();
        await fileInputLoc.waitFor({ state: 'attached', timeout: 15000 });
        await fileInputLoc.setInputFiles(filePath);
        await page.waitForTimeout(3000);

        // 2b. Modal informativo "Agora os posts de vídeo são compartilhados
        // como reels" — cobre a tela e bloqueia os cliques seguintes se não
        // for dispensado. Só costuma aparecer com certa frequência (não
        // confirmado se é 1x por conta ou recorrente), então trata como
        // opcional.
        try {
            const infoOk = page.locator(SELECTORS.reelsInfoOkButton).first();
            if (await infoOk.isVisible({ timeout: 4000 })) {
                await infoOk.evaluate((el) => el.click());
                await page.waitForTimeout(500);
            }
        } catch { /* modal não apareceu — segue */ }

        // 3. Avança pelas telas de recorte/edição (Reels verticais geralmente
        // não precisam de ajuste de crop, mas o modal tem 2 telas "Avançar"
        // antes da legenda — clica em ambas se aparecerem). Dispatch via DOM,
        // não clique físico (mesmo problema de interceptação de coordenada
        // dos outros botões — já travou aqui silenciosamente sem lançar erro).
        for (let i = 0; i < 2; i++) {
            try {
                const nextBtn = dialog.locator(SELECTORS.nextButton).first();
                if (await nextBtn.isVisible({ timeout: 8000 })) {
                    await nextBtn.evaluate((el) => el.click());
                    await page.waitForTimeout(1500);
                }
            } catch { /* tela pode não existir — segue */ }
        }

        // 4. Preenche a legenda
        logger.info('[Instagram] Preenchendo legenda...');
        const captionInput = dialog.locator(SELECTORS.captionInput).first();
        await captionInput.waitFor({ state: 'visible', timeout: 20000 });
        await captionInput.click();
        await page.waitForTimeout(300);
        await humanType(page, caption.slice(0, 2200));

        // Digitar "#" pode abrir um dropdown de sugestão de hashtags que
        // intercepta cliques por cima do botão Compartilhar. IMPORTANTE: NÃO
        // usar Escape pra fechar — se não houver dropdown aberto no momento,
        // o Escape é capturado pelo modal inteiro e abre "Descartar post?"
        // em vez de só fechar o autocomplete (achado na prática). Em vez
        // disso, tira o foco do campo clicando no contador de caracteres
        // ("X/2.200"), que é texto simples fora do contenteditable — fecha
        // qualquer dropdown por perda de foco sem acionar atalho do modal.
        await page.waitForTimeout(500);
        await dialog.locator('text=/\\d+\\/2[.,]?200/').first().click({ timeout: 3000 }).catch(() => {});
        await page.waitForTimeout(500);

        // 5. Compartilha — busca escopada ao diálogo (ver nota acima sobre o
        // "Compartilhar" do feed de fundo). Clique FÍSICO real (não
        // dispatch/evaluate): confirmado na prática que o dispatch via DOM
        // (el.click(), evento não-confiável/isTrusted:false) não aciona a
        // publicação de verdade nessa ação específica — o botão some da tela
        // mas nada é publicado (post count no perfil fica em 0). Um clique
        // físico de verdade (mouse down/up simulado, isTrusted:true) é
        // necessário aqui. A busca já está escopada ao diálogo certo, então
        // o risco de interceptação por outro elemento (que motivou o
        // dispatch nos outros botões) é bem menor.
        logger.info('[Instagram] Publicando...');
        const shareEl = dialog.locator(SELECTORS.shareButton).first();
        await shareEl.waitFor({ state: 'visible', timeout: 15000 });
        await shareEl.scrollIntoViewIfNeeded();
        // Clique físico real via ghost-cursor (curva até o botão + mouse down/up
        // de verdade, isTrusted:true) — continua sendo obrigatório clique físico
        // aqui (ver nota acima), só trocou o movimento instantâneo por um
        // trajeto humanizado.
        await humanClick(page, shareEl, { pauseAfter: false });

        // 6. Confirmação: o diálogo de criação NÃO desaparece — ele passa por
        // uma tela intermediária "Compartilhando" (spinner) e só depois vira
        // a tela de sucesso ("Reel compartilhado" / "Seu reel foi
        // compartilhado.", botão "Concluir"), confirmado visualmente na
        // prática (post real apareceu no perfil, 20s não foi tempo
        // suficiente — subiu pra 90s de margem). Esperar o diálogo sumir do
        // DOM (`detached`) nunca resolve, pois ele só troca de conteúdo no
        // mesmo lugar — o sinal real é o texto de confirmação (passado, não
        // o "Compartilhar" do botão em si, que é infinitivo).
        //
        // Polling em vez de um isVisible({timeout}) único: em 2026-09-15, 7 de
        // 8 tentativas automáticas reais ficaram presas indefinidamente na tela
        // "Compartilhando" (spinner nunca resolveu, print confirmou) — provável
        // rate-limit por rajada de uploads numa conta nova, não lentidão real.
        // O polling não resolve esse caso (nada resolve, a não ser esperar/
        // reduzir frequência — ver poster/upload-pacing.js), mas dá mais
        // margem pra uploads genuinamente lentos e gera evidência (screenshot
        // aos 60s) pra diferenciar os dois casos depois, em vez de um timeout
        // mudo.
        const CONFIRM_TIMEOUT_MS = 150_000;
        const successEl = page.locator('text=/reel compartilhado|foi compartilhado|post shared|was shared/i').first();
        const confirmStart = Date.now();
        let confirmed = false;
        let diagnosticShotTaken = false;
        let lastLoggedS = -1;
        while (Date.now() - confirmStart < CONFIRM_TIMEOUT_MS) {
            if (await successEl.isVisible({ timeout: 2000 }).catch(() => false)) {
                confirmed = true;
                break;
            }
            const elapsedS = Math.round((Date.now() - confirmStart) / 1000);
            if (elapsedS >= 60 && !diagnosticShotTaken) {
                diagnosticShotTaken = true;
                await page.screenshot({ path: `./poster-instagram-still-waiting-${Date.now()}.png` }).catch(() => {});
                logger.warn(`[Instagram] Ainda sem confirmação após ${elapsedS}s — pode ser upload lento OU o padrão do incidente de 09/15 (rate-limit). Screenshot salvo.`);
            } else if (elapsedS - lastLoggedS >= 15) {
                lastLoggedS = elapsedS;
                logger.info(`[Instagram] Aguardando confirmação de publicação... ${elapsedS}s/${Math.round(CONFIRM_TIMEOUT_MS / 1000)}s`);
            }
        }
        if (confirmed) {
            uploaded = true;
            logger.success('[Instagram] ✅ Reel publicado (tela de confirmação "compartilhado").');
            // Fecha a tela de sucesso — ação benigna, o post já foi publicado.
            try {
                const concluirBtn = page.locator('div[role="button"]:has-text("Concluir"), div[role="button"]:has-text("Done")').first();
                if (await concluirBtn.isVisible({ timeout: 3000 })) await concluirBtn.click();
            } catch { /* não crítico */ }
        } else {
            const shotPath = `./poster-ambiguous-instagram-${Date.now()}.png`;
            await page.screenshot({ path: shotPath }).catch(() => {});
            logger.warn(`[Instagram] Sem confirmação clara de publicação — verifique manualmente. Screenshot: ${shotPath}`);
        }

        return uploaded;

    } catch (err) {
        logger.error(`[Instagram] Falha no upload: ${err.message}`);
        await page.screenshot({ path: `./poster-error-instagram-${Date.now()}.png` }).catch(() => {});
        return false;

    } finally {
        await page.waitForTimeout(2000).catch(() => {});
        await context.close().catch(() => {});
    }
}
