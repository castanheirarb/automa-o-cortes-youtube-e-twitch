// bilibili/repost-queue.js
// Fila de "conteúdo próprio pronto pra repostar no Bilibili mainland" —
// alimentada por um hook em poster/index.js sempre que cortecerto034
// (rodízio principal) ou Fé Move Montanha (religioso) publicam um corte de
// verdade no YouTube/TikTok (ver enqueueRepost ali). Consumida por
// bilibili/schedule.js, com PRIORIDADE sobre as fontes externas de
// sources.js — pedido explícito do usuário (17/09/2026): o Bilibili passa a
// repostar o conteúdo que o próprio projeto já produz, em vez de só raspar
// canais chineses/Roblox/BR externos.
//
// GTA VI (gta6) FICOU DE FORA de propósito: é Trend Hunter dinâmico (escolhe
// entre vários canais-fonte a cada ciclo, ver src/trend-hunter/gta6-capture.js)
// e não existe hoje um jeito confiável de recuperar a URL exata do vídeo
// original de um clipe já cortado sem tocar no pipeline compartilhado de
// captura (ffmpeg.js/capturer.js, usado por TODAS as personas) — e o
// sourceUrl é obrigatório por compliance (transcodificação sem fonte citada
// não é aceitável, ver replicateLocal). Se quiser cobrir GTA VI também,
// precisa de um sidecar de origem por clipe no pipeline de captura primeiro.
//
// Isolamento: a cópia do arquivo acontece AQUI, na hora de enfileirar — não
// depende do arquivo original continuar em ./output depois (ele é movido
// para ./postados pelo canal principal logo em seguida). Mesmo princípio do
// resto de bilibili/: só LÊ a fonte, nunca move/apaga o original.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const QUEUE_FILE = path.resolve('./bilibili/state/repost-queue.json');
const PENDING_DIR = path.resolve('./bilibili/state/repost-pending');
// Teto de segurança — se o consumo (1x/dia, ver BILIBILI_CRON) for mais lento
// que a produção (cortecerto034 posta várias vezes/dia), evita que o JSON e a
// pasta de cópias pendentes cresçam sem limite. Descarta os mais antigos
// primeiro (o conteúdo mais velho perde relevância mais rápido mesmo).
const MAX_QUEUE_SIZE = 200;

function readQueue() {
    try {
        return JSON.parse(fs.readFileSync(QUEUE_FILE, 'utf-8'));
    } catch {
        return [];
    }
}

function writeQueue(queue) {
    fs.mkdirSync(path.dirname(QUEUE_FILE), { recursive: true });
    fs.writeFileSync(QUEUE_FILE, JSON.stringify(queue, null, 2), 'utf-8');
}

/**
 * Enfileira um clipe já publicado por cortecerto034/Fé Move Montanha pra
 * repostar no Bilibili mainland depois. Copia o arquivo IMEDIATAMENTE (não
 * guarda só o caminho) porque o canal principal move o original pra
 * ./postados logo depois desta chamada — sem a cópia própria, o arquivo já
 * teria sumido do caminho original quando o Bilibili fosse consumir a fila.
 * Nunca lança — é best-effort, uma falha aqui não pode derrubar o post
 * principal que acabou de acontecer.
 * @param {{ localPath: string, sourceUrl: string, persona: string }} entry
 */
export function enqueueRepost({ localPath, sourceUrl, persona }) {
    try {
        if (!localPath || !sourceUrl || !fs.existsSync(localPath)) return;

        fs.mkdirSync(PENDING_DIR, { recursive: true });
        const pendingPath = path.join(PENDING_DIR, `${persona || 'clip'}-${Date.now()}${path.extname(localPath)}`);
        fs.copyFileSync(localPath, pendingPath);

        const queue = readQueue();
        queue.push({ localPath: pendingPath, sourceUrl, persona, addedAt: new Date().toISOString() });
        writeQueue(queue.slice(-MAX_QUEUE_SIZE));
        logger.info(`[Bilibili/RepostQueue] Enfileirado pra repost (${persona}): ${path.basename(localPath)}`);
    } catch (err) {
        logger.warn(`[Bilibili/RepostQueue] Falha ao enfileirar (não bloqueia o post principal): ${err.message}`);
    }
}

/**
 * Remove e retorna o item mais antigo da fila. Descarta silenciosamente (sem
 * devolver) entradas cujo arquivo pendente já não existe mais (limpeza manual,
 * por exemplo) — segue procurando até achar uma válida ou esvaziar a fila.
 * @returns {{ localPath: string, sourceUrl: string, persona: string, addedAt: string } | null}
 */
export function dequeueRepost() {
    let queue = readQueue();
    let picked = null;
    while (queue.length > 0) {
        const [next, ...rest] = queue;
        queue = rest;
        if (fs.existsSync(next.localPath)) {
            picked = next;
            break;
        }
    }
    writeQueue(queue);
    return picked;
}

/**
 * Apaga a cópia pendente depois que o Bilibili já processou o item (sucesso
 * ou falha — replicateLocal já fez sua PRÓPRIA cópia em bilibili/output antes
 * de publicar, esta cópia em repost-pending só existia pra sobreviver até lá).
 */
export function cleanupPending(localPath) {
    try {
        if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    } catch { /* não crítico */ }
}
