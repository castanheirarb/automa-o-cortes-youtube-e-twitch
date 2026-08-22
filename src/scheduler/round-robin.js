// src/scheduler/round-robin.js
// Gerencia o índice global de rodízio entre personas.
// Estado persistido em ./scheduler/queue-state.json para sobreviver a reinicializações.
//
// Lógica matemática:
//   persona_ativa = personas[indice_global % total_personas]
//   Com 3 personas e 4 posts/dia, o ciclo fecha em 12 posts (LCM(3,4) = 12 = 3 dias).
//   O índice nunca reseta — cresce indefinidamente e o módulo faz a distribuição.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from '../utils/logger.js';

const STATE_DIR = path.resolve('./scheduler');
const STATE_FILE = path.join(STATE_DIR, 'queue-state.json');

// ─── Estado ───────────────────────────────────────────────────────────────────

function ensureStateDir() {
    if (!fs.existsSync(STATE_DIR)) fs.mkdirSync(STATE_DIR, { recursive: true });
}

/**
 * Lê o estado atual da fila do disco.
 * @returns {{ index: number, lastPost: string|null }}
 */
function loadState() {
    ensureStateDir();
    try {
        if (fs.existsSync(STATE_FILE)) {
            return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
        }
    } catch (err) {
        logger.warn(`[RoundRobin] Falha ao ler queue-state.json: ${err.message} — iniciando do zero.`);
    }
    return { index: 0, lastPost: null };
}

/**
 * Salva o estado no disco.
 * @param {{ index: number, lastPost: string|null }} state
 */
function saveState(state) {
    ensureStateDir();
    fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ─── Rodízio ponderado ────────────────────────────────────────────────────────
// Expande a lista de personas conforme o campo `weight` (default 1),
// intercalando os turnos extras em passadas sucessivas para evitar posts
// consecutivos da mesma persona.
// Ex.: cariani(w2), jon, casimiro → [cariani, jon, casimiro, cariani]

export function buildRotation(personas) {
    // Espaçamento uniforme: a k-ésima cópia de uma persona de peso w fica na
    // posição fracionária (k+0.5)/w do ciclo. Isso intercala bem mesmo quando
    // um peso é muito maior que os outros (ex.: Trend Hunter com 50% dos turnos
    // fica alternado, e não amontoado no fim do ciclo).
    const slots = [];
    for (const p of personas) {
        const w = p.weight ?? 1;
        for (let k = 0; k < w; k++) {
            slots.push({ persona: p, pos: (k + 0.5) / w });
        }
    }
    slots.sort((a, b) => a.pos - b.pos); // sort estável: empates mantêm a ordem da lista
    return slots.map((s) => s.persona);
}

// ─── API Pública ──────────────────────────────────────────────────────────────

/**
 * Retorna a persona ativa no turno atual (sem avançar o índice).
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @returns {import('../capturer/personas.js').Persona}
 */
export function getCurrentPersona(personas) {
    const { index } = loadState();
    const rotation = buildRotation(personas);
    return rotation[index % rotation.length];
}

// Nome do "turno de futebol" que se intercala entre os lotes de 3 vídeos de
// cada persona (inclusive entre os lotes do próprio Casimiro). Não é uma
// persona real de personas.js — é resolvido em poster/index.js (Casimiro/
// CazéTV + Trend Hunter de futebol via output/sports-vod).
export const FOOTBALL_TURN_NAME = 'futebol';

/**
 * Avança o índice global e salva no disco.
 * Deve ser chamado APÓS um post bem-sucedido (ou após fallback com post em outra persona).
 * @param {string} personaName - Nome da persona que foi postada (para log)
 */
export function advanceQueue(personaName) {
    const state = loadState();

    // Turno de futebol: não consome o lote de 3 de ninguém, nem avança o
    // índice — só limpa a própria pendência pra liberar a próxima persona.
    if (personaName === FOOTBALL_TURN_NAME) {
        state.pendingFootball = false;
        state.lastPost = new Date().toISOString();
        state.lastPersona = personaName;
        saveState(state);
        logger.info('[RoundRobin] Turno de futebol concluído — retomando rodízio normal.');
        return;
    }

    // Cada persona publica POSTS_PER_PERSONA vídeos seguidos antes de passar a
    // vez. O índice (e portanto o peso do rodízio) só avança ao fechar o lote.
    const porPersona = Math.max(1, parseInt(process.env.POSTS_PER_PERSONA || '3', 10));
    state.postsNoTurno = (state.postsNoTurno || 0) + 1;

    if (state.postsNoTurno >= porPersona) {
        state.index += 1;
        state.postsNoTurno = 0;
        // Depois de cada lote fechado, intercala 1 vídeo de futebol antes de
        // liberar a próxima persona (ver FOOTBALL_TURN_NAME acima).
        state.pendingFootball = true;
        logger.info(`[RoundRobin] Lote de ${porPersona} concluído — índice avançado para ${state.index} (último: ${personaName}). Turno de futebol pendente.`);
    } else {
        logger.info(`[RoundRobin] ${state.postsNoTurno}/${porPersona} do lote de "${personaName}" (índice ${state.index})`);
    }

    // Sequência de posts consecutivos da MESMA persona, independente de quem a
    // escolheu (round-robin normal ou o Hotness furando a fila). Ao contrário
    // de postsNoTurno, isso NÃO reseta ao fechar um lote — só quando uma
    // persona diferente posta. É o que impede o Hotness de repetir a mesma
    // persona indefinidamente (ver canPersonaPostAgain).
    if (state.streakPersona === personaName) {
        state.streakCount = (state.streakCount || 0) + 1;
    } else {
        state.streakPersona = personaName;
        state.streakCount = 1;
    }

    state.lastPost = new Date().toISOString();
    state.lastPersona = personaName;
    saveState(state);
}

/**
 * Verifica se uma persona pode postar de novo agora, respeitando o limite de
 * POSTS_PER_PERSONA posts consecutivos — mesmo quando quem está decidindo é o
 * Hotness (que, sem essa checagem, furaria a fila indefinidamente enquanto o
 * score dela seguir alto).
 * @param {string} personaName
 * @returns {boolean}
 */
export function canPersonaPostAgain(personaName) {
    const { streakPersona, streakCount } = loadState();
    const porPersona = Math.max(1, parseInt(process.env.POSTS_PER_PERSONA || '3', 10));
    if (streakPersona !== personaName) return true;
    return (streakCount || 0) < porPersona;
}

/**
 * true quando um lote de POSTS_PER_PERSONA acabou de fechar e o turno de
 * futebol intercalado (ver FOOTBALL_TURN_NAME) ainda não foi postado.
 * @returns {boolean}
 */
export function isFootballTurnPending() {
    return loadState().pendingFootball === true;
}

/**
 * Retorna o diretório de output da persona ativa.
 * @param {import('../capturer/personas.js').Persona} persona
 * @returns {string} caminho absoluto de ./output/<personaName>
 */
export function getPersonaOutputDir(persona) {
    return path.resolve(`./output/${persona.name}`);
}

/**
 * Verifica se a pasta de output de uma persona tem vídeos disponíveis.
 * @param {import('../capturer/personas.js').Persona} persona
 * @returns {boolean}
 */
export function hasVideosAvailable(persona) {
    const dir = getPersonaOutputDir(persona);
    if (!fs.existsSync(dir)) return false;

    const found = findMp4s(dir);
    return found.length > 0;
}

/**
 * Round-Robin com fallback automático.
 * Tenta a persona do turno atual; se estiver vazia, tenta as seguintes (até N tentativas).
 * Se nenhuma tiver vídeo, retorna null sem avançar o índice.
 *
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @returns {{ persona: import('../capturer/personas.js').Persona, skipped: string[] } | null}
 */
export function getNextPersonaWithFallback(personas) {
    const { index } = loadState();
    const rotation = buildRotation(personas);
    const total = rotation.length;
    const skipped = [];

    for (let attempt = 0; attempt < total; attempt++) {
        const candidateIndex = (index + attempt) % total;
        const candidate = rotation[candidateIndex];

        if (skipped.includes(candidate.displayName)) continue;

        if (hasVideosAvailable(candidate)) {
            if (skipped.length > 0) {
                logger.warn(`[RoundRobin] Fallback ativado! Puladas: [${skipped.join(', ')}]. Postando de: ${candidate.displayName}`);
            } else {
                logger.info(`[RoundRobin] Turno de: ${candidate.displayName} (índice global: ${index})`);
            }
            return { persona: candidate, skipped };
        }

        logger.warn(`[RoundRobin] Pasta vazia para "${candidate.displayName}" — tentando próxima...`);
        skipped.push(candidate.displayName);
    }

    logger.error('[RoundRobin] Todas as pastas estão vazias. Nenhum vídeo disponível para postar.');
    return null;
}

/**
 * Retorna o estado atual da fila (para exibição no banner).
 */
export function getQueueState() {
    return loadState();
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function findMp4s(dir) {
    const results = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            const fullPath = path.join(dir, entry.name);
            if (entry.isDirectory()) results.push(...findMp4s(fullPath));
            else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) results.push(fullPath);
        }
    } catch { /* pasta inacessível */ }
    return results;
}
