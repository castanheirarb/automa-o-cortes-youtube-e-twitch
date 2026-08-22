// src/comment-bot/history.js
// Cache FIFO de histórico em JSON — generaliza o padrão já duplicado em
// src/capturer/youtube-monitor.js e src/capturer/sports-monitor.js (que
// gravam listas de IDs já vistos em ./tmp/*.json) num módulo único.

import fs from 'node:fs';
import path from 'node:path';

const DEFAULT_MAX_ENTRIES = 2000;
const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * @typedef {{ id: string, status: 'replied'|'skipped'|'seeded'|'dry-run', reason?: string, ts: number }} HistoryEntry
 */

/** @returns {HistoryEntry[]} */
export function loadHistory(filePath) {
    try {
        const raw = JSON.parse(fs.readFileSync(path.resolve(filePath), 'utf-8'));
        return Array.isArray(raw) ? raw : [];
    } catch {
        return [];
    }
}

/** @param {HistoryEntry[]} entries */
export function saveHistory(filePath, entries) {
    const resolved = path.resolve(filePath);
    fs.mkdirSync(path.dirname(resolved), { recursive: true });
    fs.writeFileSync(resolved, JSON.stringify(entries), 'utf-8');
}

/**
 * Adiciona uma entrada ao array (mutando-o) e aplica o cap FIFO.
 * @param {HistoryEntry[]} entries
 * @param {{ id: string, status: HistoryEntry['status'], reason?: string }} entry
 */
export function pushEntry(entries, entry, { max = DEFAULT_MAX_ENTRIES } = {}) {
    entries.push({ ...entry, ts: Date.now() });
    if (entries.length > max) entries.splice(0, entries.length - max);
}

/** @param {HistoryEntry[]} entries */
export function hasEntry(entries, id) {
    return entries.some((e) => e.id === id);
}

/**
 * Conta quantas respostas REAIS (status 'replied', não 'dry-run') saíram nas
 * últimas 24h — usado pro limite diário de cota/anti-spam. Entradas de
 * dry-run ficam de fora de propósito, pra um teste em dry-run não consumir
 * artificialmente o orçamento de um dia real depois.
 * @param {HistoryEntry[]} entries
 */
export function countRepliedInLast24h(entries) {
    const cutoff = Date.now() - DAY_MS;
    return entries.filter((e) => e.status === 'replied' && e.ts >= cutoff).length;
}
