// bilibili/uploader-global.js
// Automatiza o upload de um vídeo no app GLOBAL do Bilibili
// (studio.bilibili.tv) via Playwright — plataforma SEPARADA do bilibili.com
// mainland (que usa biliup, ver uploader.js). Mesmo padrão dos uploaders do
// canal principal (poster/uploaders/tiktok.js): perfil Playwright persistente
// (sessão salva via bilibili/login-global.js), sem headless (upload de vídeo
// costuma travar/ser bloqueado em modo headless).
//
// Tela de metadados pós-upload NUNCA foi inspecionada de verdade em produção
// (só o formulário de seleção de arquivo, via browser interativo) — por
// isso este uploader tem um modo --inspect que sobe um vídeo real, espera
// processar, e DESPEJA os campos interativos do formulário em vez de
// adivinhar seletor. Rode isso primeiro, ajuste os seletores abaixo com o
// resultado real, DEPOIS confie no fluxo normal.
//
// Uso:
//   node bilibili/uploader-global.js <video.mp4> --inspect
//   node bilibili/uploader-global.js <video.mp4> "Título" "Descrição" --dry-run
//   node bilibili/uploader-global.js <video.mp4> "Título" "Descrição"

import { chromium } from 'playwright';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const execFileAsync = promisify(execFile);

const PROFILE_DIR = path.resolve('./bilibili/profiles/bilibili-tv');
const CHROME_EXEC = process.env.CHROME_PATH || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe';
const UPLOAD_URL = 'https://studio.bilibili.tv/archive/new';

// Seletores confirmados via --inspect em 08/09/2026 (screenshot real do
// formulário, ver bilibili-global-inspect-*.png) — não são mais palpite.
const SELECTORS = {
    // Descoberto 08/09/2026: setInputFiles direto no input[type="file"] NÃO
    // funciona nessa página (nem via Playwright nem via ferramenta de
    // navegador interativa) — o dropzone aparentemente só reage ao fluxo real
    // de clique → diálogo nativo, não a um 'change' sintético no input. Usa
    // page.waitForEvent('filechooser') interceptando o diálogo nativo que o
    // botão abre — padrão mais robusto do Playwright pra esse caso, ver
    // uploadToBilibiliGlobal/inspectUploadForm.
    selectFileBtn: 'button:has-text("Select File")',
    // Confirmado via --inspect em 08/09/2026 (screenshot real do formulário):
    // Title vem PRÉ-PREENCHIDO com o nome do arquivo (sem placeholder — por
    // isso um seletor por placeholder nunca casava), então é localizado pelo
    // texto do rótulo "Title" logo acima, não por atributo do input.
    titleInput: 'xpath=//*[normalize-space(text())="Title"]/following::input[1]',
    descInput: 'textarea[placeholder*="Describe your video" i]',
    tagInput: 'input[placeholder*="Press Enter to add a tag" i]',
    // Type: Original (padrão) vs Repost — OBRIGATÓRIO marcar Repost pra
    // conteúdo replicado do YouTube (mesma regra de compliance já aplicada
    // no mainland via uploader.js --copyright 2 --source). NUNCA deixar em
    // "Original" pra conteúdo que não é nosso.
    repostRadio: 'text=Repost',
    // Cover é marcado obrigatório (*) e NÃO se auto-preenche com um frame do
    // vídeo mesmo depois do upload processar. Fluxo real confirmado passo a
    // passo via inspeção manual ao vivo em 09/09/2026 (o usuário fez o
    // upload numa aba real enquanto eu inspecionava): clicar "Upload a
    // cover" abre um modal com filmstrip (aba "From Video") — o botão "Next"
    // fica DESABILITADO até um frame ser auto-selecionado (precisa do upload
    // do vídeo já ter progredido o bastante pra gerar os thumbnails, não é
    // instantâneo). Depois de "Next" vem a tela "Cover editor": o botão
    // "Confirm" começa desabilitado e SÓ habilita depois de clicar em "Crop"
    // primeiro (confirma a área de recorte) — clicar "Confirm" direto, sem
    // passar por "Crop", não faz nada.
    coverUploadBtn: 'text=Upload a cover',
    coverNextBtn: '.el-dialog__wrapper button:has-text("Next")',
    coverCropBtn: '.el-dialog__wrapper button:has-text("Crop")',
    coverConfirmBtn: '.el-dialog__wrapper button:has-text("Confirm")',
    // Aba "From local" do mesmo modal — upload de imagem externa em vez do
    // filmstrip do vídeo, tentando evitar o bug do "Next" travado em vídeo
    // 16:9 (ainda não testado em produção — ver uploadToBilibiliGlobal).
    coverFromLocalTab: '.el-dialog__wrapper >> text=From local',
    publishBtn: 'button:has-text("Upload Now")',
    // Confirmado FALSO via screenshot real em 15/09/2026: a capa ESTAVA
    // presente (thumbnail real visível) mas `img[src^="blob:"/"http"]` não
    // bateu — suspeita: a imagem usa URL relativa/protocol-relative do CDN
    // (ex. `//i0.hdslb.com/...`), não `http`/`blob:`. Trocado pro mesmo
    // padrão já confirmado funcionando pro campo Title: localizar pelo texto
    // do rótulo ("Cover") e pegar a primeira <img> depois dele, em vez de
    // depender do src.
    coverThumbnail: 'xpath=//*[normalize-space(text())="Cover"]/following::img[1]',
};

/**
 * Extrai um frame do vídeo pra usar como capa — usado com a aba "From local"
 * do modal de capa em vez do filmstrip embutido. Tenta a MESMA seleção de
 * frame por IA do canal principal (face-detect.js — Gemini → Groq →
 * OpenRouter, escolhe o frame com expressão mais forte nos primeiros 60s);
 * só a escolha de frame, SEM texto/direção de arte (thumbnail.js gera isso em
 * português — capa pra público chinês não pode ter texto no idioma errado).
 * Cai pro frame fixo em 1s (comportamento antigo) se a IA falhar/não achar
 * nada — nunca bloqueia o upload por causa disso.
 * @param {string} videoPath
 * @returns {Promise<string>} caminho do .jpg gerado (chamador apaga depois)
 */
async function extractCoverFrame(videoPath) {
    try {
        const { extractBestFrame } = await import('../src/processor/face-detect.js');
        const aiFrame = await extractBestFrame(videoPath);
        if (aiFrame) return aiFrame;
    } catch (err) {
        logger.warn(`[Bilibili/Global] Seleção de capa por IA falhou (${err.message}) — usando frame fixo.`);
    }

    const ffmpeg = process.env.FFMPEG_PATH?.trim() || 'ffmpeg';
    const coverPath = path.join(os.tmpdir(), `bili-cover-${crypto.randomBytes(4).toString('hex')}.jpg`);
    await execFileAsync(ffmpeg, ['-y', '-ss', '1', '-i', videoPath, '-frames:v', '1', '-q:v', '2', coverPath]);
    if (!fs.existsSync(coverPath)) throw new Error('ffmpeg terminou mas a capa não foi gerada.');
    return coverPath;
}

async function launchBrowser() {
    if (!fs.existsSync(PROFILE_DIR)) {
        throw new Error(`Perfil não encontrado (${PROFILE_DIR}) — rode "npm run bilibili:login-global" primeiro.`);
    }
    return chromium.launchPersistentContext(PROFILE_DIR, {
        executablePath: CHROME_EXEC,
        headless: false,
        args: ['--no-sandbox', '--disable-blink-features=AutomationControlled'],
        ignoreDefaultArgs: ['--enable-automation'],
        viewport: null,
    });
}

/**
 * Seleciona o arquivo via interceptação do diálogo nativo (page.waitForEvent
 * 'filechooser') — setInputFiles direto no input não funciona nessa página
 * (ver nota em SELECTORS acima).
 */
async function selectFile(page, filePath) {
    const [chooser] = await Promise.all([
        page.waitForEvent('filechooser', { timeout: 15000 }),
        page.click(SELECTORS.selectFileBtn),
    ]);
    await chooser.setFiles(filePath);
}

/**
 * Espera o formulário de metadados aparecer após o upload — usa a textarea
 * de descrição como sinal (placeholder fixo, confirmado via --inspect
 * 08/09/2026), não o título (esse vem PRÉ-PREENCHIDO com o nome do arquivo,
 * sem placeholder pra detectar). Polling com timeout curto por tentativa.
 */
async function waitForProcessing(page, filePath) {
    const fileSizeMB = fs.statSync(filePath).size / (1024 * 1024);
    const waitMin = Math.min(30, Math.max(3, Math.ceil(fileSizeMB / 50)));
    logger.info(`[Bilibili/Global] Aguardando processamento (${Math.round(fileSizeMB)} MB — até ${waitMin} min)...`);

    const deadline = Date.now() + waitMin * 60 * 1000;
    while (Date.now() < deadline) {
        try {
            const el = await page.waitForSelector(SELECTORS.descInput, { timeout: 3000, state: 'visible' });
            if (el) return true;
        } catch { /* ainda processando */ }
        await page.waitForTimeout(2000);
    }
    return false;
}

/**
 * Espera o upload real do arquivo (não só o formulário) terminar de verdade
 * ("Upload completed") — descoberto 09/09/2026: mexer na capa ENQUANTO o
 * upload principal ainda está em progresso (a barra de % ainda visível) faz
 * o modal da capa fechar/resetar no meio do processo quando o upload
 * termina em segundo plano (explica a flakiness dos cliques em Crop/Confirm
 * — às vezes o modal simplesmente some no meio do fluxo).
 */
async function waitForUploadCompleted(page, timeoutMs = 5 * 60 * 1000) {
    await page.waitForSelector('text=Upload completed', { timeout: timeoutMs });
}

/**
 * Confirma o passo de capa de forma 100% automática, sem depender de humano.
 * Substitui o gate manual antigo (waitForHumanCoverConfirmation) — a pedido
 * explícito de 18/09/2026: "não pode depender de mim".
 *
 * Reavaliação da investigação de 15/09/2026: a tela de recorte é
 * genuinamente intermitente do lado do bilibili.tv (2 execuções precisaram
 * de clique real, 2 investigações deram modal com corpo vazio) — mas em
 * NENHUM dos dois casos a decisão exigia julgamento humano. "Crop" só
 * confirma a área padrão (não é uma escolha de enquadramento), e "modal
 * vazio" é uma falha de renderização, não uma pergunta pra alguém responder.
 * Ou seja: o problema real sempre foi "como automatizar algo intermitente",
 * não "como automatizar uma decisão subjetiva" — dá pra resolver com
 * polling curto + retry, sem humano nenhum.
 *
 * @returns {Promise<boolean>} true = clicou Crop→Confirm (ou Confirm direto)
 *   com sucesso; false = nada apareceu dentro do timeout (modal travado/vazio
 *   — chamador decide se tenta de novo do zero).
 */
async function attemptAutomaticCoverConfirmation(page) {
    const confirmBtn = page.locator(SELECTORS.coverConfirmBtn).first();
    const cropBtn = page.locator(SELECTORS.coverCropBtn).first();

    // Confirm fica VISÍVEL desde o início, só DESABILITADO — waitFor('visible')
    // sempre retorna true mesmo sem clicar em Crop nenhuma vez (bug real
    // encontrado ao vivo em 18/09/2026: log dizia "confirmada automaticamente"
    // mas o clique não fazia nada porque o botão continuava disabled=true, o
    // que travava o clique seguinte em "Repost" com o modal ainda aberto por
    // cima). Preciso checar habilitado de verdade, não só visível.
    //
    // Clica em Crop até 3x (o clique inicial pode não "pegar" se o cropper
    // ainda estiver montando as handles de seleção) e só avança quando Confirm
    // realmente destravar.
    for (let i = 0; i < 3; i++) {
        if (await confirmBtn.isEnabled().catch(() => false)) break;
        const cropVisible = await cropBtn.waitFor({ state: 'visible', timeout: i === 0 ? 20000 : 3000 })
            .then(() => true)
            .catch(() => false);
        if (!cropVisible) break; // nem o botão Crop existe — modal travado/vazio
        logger.info(`[Bilibili/Global] Clicando Crop (tentativa ${i + 1}/3, área padrão)...`);
        // Dispatch via DOM: clique físico normal não fechava o modal em
        // testes ao vivo (18/09/2026) — suspeita de interceptação pelo
        // próprio overlay do cropper (mesmo padrão já visto no
        // Instagram/YouTube, onde outro elemento na MESMA coordenada rouba o
        // clique mesmo com o Playwright confirmando "visível/habilitado").
        await cropBtn.evaluate((el) => el.click()).catch(() => {});
        await page.waitForTimeout(1200);
    }

    const confirmEnabled = await confirmBtn.isEnabled().catch(() => false);
    if (!confirmEnabled) {
        logger.warn('[Bilibili/Global] Confirm nunca destravou — modal provavelmente travado/vazio (bug conhecido do lado do bilibili.tv).');
        return false;
    }

    await confirmBtn.evaluate((el) => el.click()).catch(() => {});
    await page.waitForTimeout(1000);
    // Modal precisa fechar de verdade — Confirm habilitado+clicado mas o
    // dialog ainda no DOM significa que não comitou de fato (achado ao vivo:
    // o clique "funcionava" mas o modal ficava aberto por cima do formulário,
    // bloqueando o clique seguinte em "Repost").
    const closed = await page.locator('.el-dialog__wrapper').first()
        .waitFor({ state: 'detached', timeout: 8000 })
        .then(() => true)
        .catch(() => false);
    if (!closed) {
        logger.warn('[Bilibili/Global] Clicou Confirm mas o modal não fechou — tratando como falha desta tentativa.');
        return false;
    }
    logger.success('[Bilibili/Global] Capa confirmada automaticamente.');
    return true;
}

/**
 * Checagem direta (não inferida pelo estado do modal) de que uma capa real
 * foi setada — pega o bug suspeito da sessão anterior: o cropper "fechar" não
 * prova que a capa foi de fato aceita, só que o modal sumiu. Roda logo depois
 * do passo de capa, ANTES de tocar em Repost/título, pra falhar cedo com um
 * screenshot em vez de descobrir só depois de "publicar" e checar a lista.
 * Seletor ainda não confirmado por --inspect (ver nota em SELECTORS) — por
 * isso isto é um aviso (log), nunca lança erro, quando não encontra nada.
 * @returns {Promise<boolean>}
 */
async function verifyCoverThumbnail(page) {
    const found = await page.locator(SELECTORS.coverThumbnail).first()
        .waitFor({ state: 'visible', timeout: 5000 })
        .then(() => true)
        .catch(() => false);

    if (!found) {
        const shotPath = `./bilibili-global-cover-missing-${Date.now()}.png`;
        await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
        logger.warn(`[Bilibili/Global] ⚠️  Nenhuma thumbnail de capa detectada após o passo de crop/confirm — capa pode não ter sido setada de verdade (seletor ainda não confirmado, pode ser falso alarme). Screenshot: ${shotPath}`);
    } else {
        logger.info('[Bilibili/Global] Thumbnail de capa detectada — capa parece setada de verdade.');
    }
    return found;
}

/**
 * Verificação de publicação REALMENTE independente — a checagem anterior
 * (page.goto pra archive-list dentro da MESMA sessão/contexto) já se provou
 * insuficiente: 3 runs seguidos "confirmaram" publicação com esse método e
 * nenhum vídeo apareceu de fato numa checagem manual depois. Suspeita: a SPA
 * mantém um estado client-side otimista (store em memória) que sobrevive a um
 * page.goto por causa de client-side routing, e/ou o backend rejeita a capa
 * de forma assíncrona alguns segundos DEPOIS do "sucesso" aparente.
 *
 * Aqui: fecha o contexto Playwright inteiro (mata qualquer estado de app em
 * memória, service worker, etc.) e abre um browser NOVO no mesmo profile
 * salvo em disco (sequencial — só pode haver 1 contexto por profile dir por
 * vez, por isso não dá pra rodar em paralelo com o context original ainda
 * aberto). Esse processo novo só tem o que está persistido em disco (cookies)
 * — qualquer coisa vista aqui veio de uma requisição de rede real, não de
 * memória. Espera um buffer antes de checar pro caso da validação do backend
 * ser assíncrona.
 * @param {string} title
 * @param {number} [bufferMs] - espera antes de sequer abrir o browser novo
 * @returns {Promise<boolean>}
 */
async function verifyPublishIndependently(title, bufferMs = 45000) {
    logger.info(`[Bilibili/Global] Verificação independente: aguardando ${Math.round(bufferMs / 1000)}s antes de checar com um browser novo...`);
    await new Promise((resolve) => setTimeout(resolve, bufferMs));

    const context = await launchBrowser();
    const page = await context.newPage();
    try {
        await page.goto('https://studio.bilibili.tv/archive-list', { waitUntil: 'networkidle' }).catch(() => {});
        await page.waitForTimeout(2000);

        // Bug real apontado pelo usuário 16/09/2026: checar só UMA VEZ se o
        // título apareceu e já fechar é o MESMO tipo de falso positivo que já
        // aconteceu antes (ver histórico acima) — o título pode aparecer numa
        // linha ainda em estado transitório (processando/sem status real
        // resolvido) antes do backend decidir de verdade o que aconteceu com
        // ele. Estados REAIS já confirmados via screenshot real (não
        // adivinhados): "Under review" (pendente moderação), "Rejected"
        // (recusado), ou — quando já aprovado — a linha ganha os botões
        // Edit/Data/Interactions em vez de um texto de status. Faz polling
        // (a cada 10s, até o teto abaixo) esperando um desses estados REAIS
        // aparecer antes de considerar a verificação concluída, em vez de
        // aceitar a primeira olhada.
        // Container real confirmado via inspeção ao vivo do DOM em 16/09/2026
        // (não adivinhado): cada card da lista é `.archive-card`, não `li`/
        // `tr`/`*item*`/`*row*` como um palpite genérico sugeriria.
        //
        // Teto aumentado de 2min pra 4min em 17/09/2026: uma publicação REAL
        // no dia anterior levou pouco mais de 2min pra resolver pra "Under
        // review" — a função desistiu e reportou falha (screenshot
        // bilibili-global-verify-failed-*.png) bem no momento em que o status
        // real já tinha aparecido na lista. Publicação em si funcionou; só o
        // teto de espera estava curto demais.
        const row = page.locator(`text=${title.slice(0, 40)}`).first()
            .locator('xpath=ancestor::*[contains(@class,"archive-card")][1]');

        const maxWaitMs = 4 * 60 * 1000;
        const pollIntervalMs = 10000;
        const deadline = Date.now() + maxWaitMs;
        let resolvedStatus = null;

        while (Date.now() < deadline) {
            const titleVisible = await page.locator(`text=${title.slice(0, 40)}`).first().isVisible({ timeout: 5000 }).catch(() => false);
            if (!titleVisible) {
                await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
                await page.waitForTimeout(2000);
                continue;
            }

            const [underReview, rejected, hasDataBtn] = await Promise.all([
                row.locator('text=Under review').count().catch(() => 0),
                row.locator('text=Rejected').count().catch(() => 0),
                row.locator('button:has-text("Data")').count().catch(() => 0),
            ]);

            if (underReview > 0) resolvedStatus = 'Under review';
            else if (rejected > 0) resolvedStatus = 'Rejected';
            else if (hasDataBtn > 0) resolvedStatus = 'Approved (live)';

            if (resolvedStatus) break;

            logger.info(`[Bilibili/Global] Título visível mas status ainda não resolvido (transitório/processando) — checando de novo em ${pollIntervalMs / 1000}s...`);
            await page.reload({ waitUntil: 'networkidle' }).catch(() => {});
            await page.waitForTimeout(pollIntervalMs);
        }

        if (!resolvedStatus) {
            const shotPath = `./bilibili-global-verify-failed-${Date.now()}.png`;
            await page.screenshot({ path: shotPath, fullPage: true }).catch(() => {});
            logger.warn(`[Bilibili/Global] Verificação independente: status nunca resolveu pra um estado real em ${Math.round(maxWaitMs / 1000)}s (nem "Under review", nem "Rejected", nem aprovado). Screenshot: ${shotPath}`);
            return false;
        }

        logger.info(`[Bilibili/Global] Status real confirmado: "${resolvedStatus}".`);
        return resolvedStatus !== 'Rejected';
    } finally {
        await context.close().catch(() => {});
    }
}

/**
 * Sobe o arquivo, espera processar, e DESPEJA os elementos interativos da
 * tela — não preenche nem publica nada. Uso: descobrir os seletores reais do
 * formulário de metadados antes de confiar em uploadToBilibiliGlobal().
 * Também clica em "Repost" (ver SELECTORS.repostRadio) e tira UMA SEGUNDA
 * screenshot, pra revelar os campos de compliance (fonte/atribuição) que só
 * aparecem nesse estado — precisamos disso pra nunca publicar como Original.
 * @param {string} filePath
 */
export async function inspectUploadForm(filePath) {
    const context = await launchBrowser();
    const page = await context.newPage();
    try {
        await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
        await selectFile(page, filePath);

        const ready = await waitForProcessing(page, filePath);
        logger.info(`[Bilibili/Global] Formulário ${ready ? 'detectado' : 'NÃO detectado (timeout)'} — capturando estado da tela...`);

        const shotPath = `./bilibili-global-inspect-${Date.now()}.png`;
        await page.screenshot({ path: shotPath, fullPage: true });
        logger.success(`[Bilibili/Global] Screenshot (Original, estado padrão): ${shotPath}`);

        let repostShotPath = null;
        try {
            await page.locator(SELECTORS.repostRadio).first().click({ timeout: 5000 });
            await page.waitForTimeout(1000);
            repostShotPath = `./bilibili-global-inspect-repost-${Date.now()}.png`;
            await page.screenshot({ path: repostShotPath, fullPage: true });
            logger.success(`[Bilibili/Global] Screenshot (Repost — ver campos de fonte/atribuição): ${repostShotPath}`);
        } catch (err) {
            logger.warn(`[Bilibili/Global] Não consegui clicar em "Repost": ${err.message}`);
        }

        return { shotPath, repostShotPath };
    } finally {
        await page.waitForTimeout(2000).catch(() => {});
        await context.close().catch(() => {});
    }
}

/**
 * @param {string} filePath
 * @param {string} title
 * @param {string} [description]
 * @param {object} [opts]
 * @param {boolean} [opts.dryRun] - preenche tudo mas NÃO clica em publicar
 * @param {string[]} [opts.tags]
 * @returns {Promise<boolean>}
 */
export async function uploadToBilibiliGlobal(filePath, title, description = '', { dryRun = false, tags = [] } = {}) {
    logger.step(`[Bilibili/Global] Iniciando upload: ${path.basename(filePath)}`);
    const context = await launchBrowser();
    const page = await context.newPage();
    let published = false;

    try {
        await page.goto(UPLOAD_URL, { waitUntil: 'domcontentloaded' });
        logger.info('[Bilibili/Global] Enviando arquivo...');
        await selectFile(page, filePath);

        const ready = await waitForProcessing(page, filePath);
        if (!ready) throw new Error('Formulário de metadados não apareceu — rode --inspect pra confirmar os seletores.');

        logger.info('[Bilibili/Global] Aguardando o upload do vídeo terminar de verdade antes de mexer na capa...');
        await waitForUploadCompleted(page);
        // Confirmado pelo usuário 09/09/2026 ao vivo: o Crop/Confirm só fica
        // disponível quando o upload chega a 100% de verdade no backend —
        // o texto "Upload completed" pode aparecer um pouco antes disso
        // (client-side otimista), então uma folga extra evita mexer na capa
        // cedo demais.
        await page.waitForTimeout(3000);

        // Cover é REALMENTE obrigatório. O passo de recorte é intermitente do
        // lado do bilibili.tv (ver attemptAutomaticCoverConfirmation) — em
        // vez de gate humano, tenta o sub-fluxo inteiro do zero até
        // MAX_COVER_ATTEMPTS vezes, confirmando sucesso real via
        // verifyCoverThumbnail (não só "o modal fechou") a cada tentativa.
        const coverPath = await extractCoverFrame(filePath);
        const MAX_COVER_ATTEMPTS = 3;
        let coverConfirmed = false;
        try {
            for (let attempt = 1; attempt <= MAX_COVER_ATTEMPTS; attempt++) {
                logger.info(`[Bilibili/Global] Definindo capa — tentativa ${attempt}/${MAX_COVER_ATTEMPTS}...`);
                await page.locator(SELECTORS.coverUploadBtn).first().click({ timeout: 5000 }).catch(() => {});
                await page.locator(SELECTORS.coverFromLocalTab).first().click({ timeout: 5000 }).catch(() => {});
                // #cover-upload-btn é um input[type=file] REAL e diretamente
                // acessível (confirmado via erro de click interceptado
                // 09/09/2026) — diferente do input do vídeo principal, aqui
                // setInputFiles direto funciona.
                await page.locator('#cover-upload-btn').setInputFiles(coverPath, { timeout: 5000 }).catch(() => {});

                await attemptAutomaticCoverConfirmation(page);

                // Bug real encontrado ao vivo 10/09/2026 (usuário observando a
                // janela): o cropper "fechar" (elemento sumir do DOM) não
                // significa que o upload da imagem de capa em si já terminou
                // no backend — a checagem de thumbnail rodava só instantes
                // depois e podia pegar o estado "ainda subindo". Espera a
                // rede ficar ociosa antes de checar.
                await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
                await page.waitForTimeout(2000);

                coverConfirmed = await verifyCoverThumbnail(page);
                if (coverConfirmed) break;

                if (attempt < MAX_COVER_ATTEMPTS) {
                    logger.warn(`[Bilibili/Global] Capa não confirmada na tentativa ${attempt} — fechando e tentando de novo do zero...`);
                    // Escape NÃO fecha esse modal (confirmado ao vivo em
                    // 18/09/2026 — o clique seguinte em "Repost" continuava
                    // bloqueado pelo dialog depois de um Escape). Usa o botão
                    // "Cancel" real do modal; se nem esse existir mais (já
                    // fechou, ou DOM diferente), o "X" do canto também fecha.
                    const dialog = page.locator('.el-dialog__wrapper').first();
                    const cancelled = await dialog.locator('button:has-text("Cancel")').first()
                        .click({ timeout: 3000 }).then(() => true).catch(() => false);
                    if (!cancelled) {
                        await dialog.locator('[aria-label="Close"], .el-dialog__close, button:has-text("×")').first()
                            .click({ timeout: 3000 }).catch(() => {});
                    }
                    await dialog.waitFor({ state: 'detached', timeout: 5000 }).catch(() => {});
                    await page.waitForTimeout(1000);
                }
            }
        } finally {
            if (fs.existsSync(coverPath)) fs.unlinkSync(coverPath);
        }

        if (!coverConfirmed) {
            logger.warn(`[Bilibili/Global] ⚠️ Capa não confirmada após ${MAX_COVER_ATTEMPTS} tentativas automáticas — publicando sem capa customizada (bilibili.tv usa o próprio padrão dele). Nunca bloqueia o upload por causa disso.`);
        }

        // Diagnóstico + limpeza agressiva: em testes ao vivo (18/09/2026),
        // NENHUM clique (físico, forçado ou dispatch, em Confirm/Cancel/X)
        // conseguiu fechar o dialog do editor de capa quando ele trava — o
        // overlay `.cropper-drag-box` sobrevive e bloqueia qualquer clique
        // seguinte no formulário (ex.: "Repost"). Em vez de insistir em achar
        // o botão certo num modal que não coopera, remove o overlay
        // diretamente do DOM — mais bruto, mas não deixa a publicação inteira
        // travada por um elemento de UI órfão.
        const dialogCount = await page.locator('.el-dialog__wrapper').count().catch(() => -1);
        const overlayStuck = await page.locator('.cropper-drag-box, .cropper-modal, .v-modal').first().isVisible({ timeout: 1000 }).catch(() => false);
        if (overlayStuck || dialogCount > 0) {
            // v-modal é o BACKDROP escurecido do Element-UI, elemento
            // separado do dialog em si — removendo só .el-dialog__wrapper
            // (tentativa anterior) deixava o backdrop sozinho ainda
            // bloqueando clique em qualquer coisa (achado ao vivo em
            // 18/09/2026: interceptor mudou de "cropper-drag-box" pra
            // "v-modal" depois da 1ª remoção — sobrou exatamente esse).
            logger.warn(`[Bilibili/Global] Overlay/modal travado ainda no DOM (${dialogCount} dialog(s) el-dialog__wrapper) — removendo diretamente via DOM antes de seguir.`);
            await page.evaluate(() => {
                document.querySelectorAll('.el-dialog__wrapper, .cropper-drag-box, .cropper-modal, .cropper-container, .v-modal')
                    .forEach((el) => el.remove());
                document.body.classList.remove('el-popup-parent--hidden');
            }).catch(() => {});
            await page.waitForTimeout(500);
        }

        // Compliance: SEMPRE marca Repost — nunca Original, conteúdo vem do
        // YouTube. Mesma regra já aplicada no mainland (uploader.js).
        logger.info('[Bilibili/Global] Marcando como Repost (compliance)...');
        await page.locator(SELECTORS.repostRadio).first().click({ timeout: 5000 });
        await page.waitForTimeout(500);

        logger.info('[Bilibili/Global] Preenchendo título...');
        const titleEl = page.locator(SELECTORS.titleInput).first();
        await titleEl.click();
        await page.keyboard.press('Control+a');
        await page.keyboard.type(title.slice(0, 100), { delay: 20 });

        if (description) {
            await page.locator(SELECTORS.descInput).first().click();
            await page.keyboard.type(description.slice(0, 2000), { delay: 15 });
        }

        for (const tag of tags.slice(0, 10)) {
            try {
                const tagEl = page.locator(SELECTORS.tagInput).first();
                await tagEl.click();
                await page.keyboard.type(tag.slice(0, 20), { delay: 20 });
                await page.keyboard.press('Enter');
                await page.waitForTimeout(200);
            } catch { /* tag individual falhou — segue com as outras, não é crítico */ }
        }

        if (dryRun) {
            const shotPath = `./bilibili-global-dryrun-${Date.now()}.png`;
            await page.screenshot({ path: shotPath, fullPage: true });
            logger.success(`[Bilibili/Global] ✅ DRY-RUN — formulário preenchido, nada publicado. Screenshot: ${shotPath}`);
            return false;
        }

        logger.info('[Bilibili/Global] Publicando...');
        await page.locator(SELECTORS.publishBtn).first().click({ timeout: 5000 });

        const urlBefore = page.url();
        await page.waitForURL((u) => u.toString() !== urlBefore, { timeout: 30000 }).catch(() => {});

        // Bug real encontrado ao vivo 10/09/2026 (usuário observando a janela):
        // clicar "Upload Now" dispara uma chamada assíncrona pro backend que
        // NÃO termina no momento em que a URL muda — fechar o contexto logo em
        // seguida corre o risco de abortar essa requisição no meio (o browser
        // mata requests em voo ao fechar), o que criaria um falso NEGATIVO
        // causado por nós mesmos, sem relação com o bug de estado otimista da
        // SPA. Espera a rede ficar ociosa (ou um teto de 10s) antes de fechar.
        await page.waitForLoadState('networkidle', { timeout: 10000 }).catch(() => {});
        await page.waitForTimeout(3000);

        // Bug real corrigido 10/09/2026: a checagem antiga (page.goto pra
        // archive-list DENTRO da mesma sessão/contexto) já se provou
        // insuficiente — deu "sucesso" 3 vezes seguidas e nenhum vídeo
        // apareceu numa checagem manual depois. Fecha este contexto inteiro e
        // abre um browser NOVO (mesmo profile salvo em disco, memória/estado
        // zerados) só pra confirmar — ver verifyPublishIndependently().
        await context.close().catch(() => {});
        published = await verifyPublishIndependently(title);

        if (published) {
            logger.success(`[Bilibili/Global] ✅ Publicado e confirmado (verificação independente, browser novo).`);
        } else {
            logger.warn(`[Bilibili/Global] Verificação independente não encontrou o vídeo — provavelmente FALHOU de verdade (não é só falta de confirmação).`);
        }
        return published;
    } catch (err) {
        logger.error(`[Bilibili/Global] Falha no upload: ${err.message}`);
        await page.screenshot({ path: `./bilibili-global-error-${Date.now()}.png` }).catch(() => {});
        return false;
    } finally {
        await page.waitForTimeout(2000).catch(() => {});
        await context.close().catch(() => {});
    }
}

// ─── Self-test ────────────────────────────────────────────────────────────
if (process.argv[1] && process.argv[1].endsWith('uploader-global.js')) {
    const args = process.argv.slice(2);
    const filePath = args[0];
    const inspect = args.includes('--inspect');
    const dryRun = args.includes('--dry-run');

    if (!filePath) {
        console.error('Uso: node bilibili/uploader-global.js <video.mp4> [--inspect | "Título" "Descrição" [--dry-run]]');
        process.exit(1);
    }

    const run = inspect
        ? inspectUploadForm(filePath).then(() => true)
        : uploadToBilibiliGlobal(filePath, args[1] || 'Teste', args[2] || '', { dryRun });

    run
        .then((ok) => { process.exitCode = ok ? 0 : 1; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
