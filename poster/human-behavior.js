// poster/human-behavior.js
// Digitação e cliques humanizados, compartilhados pelos 3 uploaders
// (YouTube/TikTok/Instagram). Criado em 2026-09-15 depois de 8 uploads
// automáticos do Instagram (rajada de ~40min numa conta nova) travarem todos
// na tela "Compartilhando" — suspeita é que o padrão de clique
// instantâneo/dispatch via DOM e digitação com timing perfeito contribui pra
// esses cliques serem reconhecidos como automação, ainda mais numa conta
// nova sujeita a mais escrutínio (ver poster/upload-pacing.js pro outro lado
// do mesmo problema: throttle de frequência de post).
//
// Isso NÃO resolve rate-limit de verdade (uma conta já sinalizada continua
// sinalizada) — é só pra não ADICIONAR sinais óbvios de bot em cima disso.

import { createCursor } from 'ghost-cursor-playwright';

function rand(min, max) {
    return min + Math.random() * (max - min);
}

// Vizinhos de tecla no teclado QWERTY — só pra simular erro de digitação
// ocasional seguido de correção, não é validação de layout real.
const KEY_NEIGHBORS = {
    a: 'qwsz', b: 'vghn', c: 'xdfv', d: 'serfcx', e: 'wsdr', f: 'drtgvc',
    g: 'ftyhbv', h: 'gyujnb', i: 'ujko', j: 'huikmn', k: 'jiolm', l: 'kop',
    m: 'njk', n: 'bhjm', o: 'iklp', p: 'ol', q: 'wa', r: 'edft', s: 'awedxz',
    t: 'rfgy', u: 'yhji', v: 'cfgb', w: 'qase', x: 'zsdc', y: 'tghu', z: 'asx',
};

function typoFor(ch) {
    const options = KEY_NEIGHBORS[ch.toLowerCase()];
    if (!options) return null;
    const picked = options[Math.floor(Math.random() * options.length)];
    return ch === ch.toUpperCase() ? picked.toUpperCase() : picked;
}

/**
 * Digita como um humano: delay variável por caractere (não um valor fixo),
 * pausa maior depois de pontuação/quebra de linha, e erro de digitação
 * ocasional (tecla vizinha + Backspace + correção). Itera por code point
 * (Array.from), não por índice de string — preserva emoji corretamente.
 */
export async function humanType(page, text, opts = {}) {
    const { minDelay = 18, maxDelay = 55, mistakeChance = 0.02 } = opts;

    for (const ch of Array.from(text)) {
        if (mistakeChance > 0 && Math.random() < mistakeChance) {
            const wrong = typoFor(ch);
            if (wrong) {
                await page.keyboard.type(wrong, { delay: rand(minDelay, maxDelay) });
                await page.waitForTimeout(rand(120, 280));
                await page.keyboard.press('Backspace');
                await page.waitForTimeout(rand(70, 160));
            }
        }
        await page.keyboard.type(ch, { delay: rand(minDelay, maxDelay) });
        if (ch === '\n') await page.waitForTimeout(rand(200, 450));
        else if (/[.,!?]/.test(ch)) await page.waitForTimeout(rand(150, 400));
        else if (ch === ' ' && Math.random() < 0.35) await page.waitForTimeout(rand(80, 220));
    }
}

// Um cursor "fantasma" por página — reaproveita o estado de posição anterior
// do ghost-cursor entre cliques em vez de recriar (o que faria todo clique
// partir de um ponto aleatório novo, perdendo a continuidade de movimento).
const cursorsByPage = new WeakMap();

async function getCursor(page) {
    if (!cursorsByPage.has(page)) {
        cursorsByPage.set(page, await createCursor(page));
    }
    return cursorsByPage.get(page);
}

/**
 * Clica como um humano: move o mouse em curva de Bezier (ghost-cursor) até o
 * elemento antes de clicar, com dwell/hesitação real, em vez de teleportar o
 * cursor ou disparar via DOM (el.click() via evaluate — o que os uploaders
 * usavam antes pra contornar cliques sequestrados por elemento sobreposto,
 * mas que também é um sinal clássico de automação: evento não-confiável,
 * isTrusted:false).
 *
 * @param {import('playwright').Page} page
 * @param {import('playwright').Locator|string} target - Locator (recomendado
 *   — funciona com seletores complexos, dialogs, iframes) ou seletor CSS simples.
 */
export async function humanClick(page, target, opts = {}) {
    const cursor = await getCursor(page);
    const box = typeof target === 'string'
        ? await page.locator(target).first().boundingBox()
        : await target.boundingBox();
    if (!box) {
        throw new Error('[human-behavior] elemento sem posição visível (boundingBox nulo) para clique humanizado.');
    }
    await cursor.actions.click({ target: box, waitBeforeClick: [80, 220] }, { paddingPercentage: 20 });
    if (opts.pauseAfter !== false) await page.waitForTimeout(rand(150, 400));
}

/** Pausa aleatória — em vez de page.waitForTimeout(valor fixo) espalhado pelo código. */
export function humanPause(minMs, maxMs) {
    return new Promise((resolve) => setTimeout(resolve, rand(minMs, maxMs)));
}
