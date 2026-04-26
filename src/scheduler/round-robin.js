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

// ─── API Pública ──────────────────────────────────────────────────────────────

/**
 * Retorna a persona ativa no turno atual (sem avançar o índice).
 * @param {import('../capturer/personas.js').Persona[]} personas
 * @returns {import('../capturer/personas.js').Persona}
 */
export function getCurrentPersona(personas) {
    const { index } = loadState();
    return personas[index % personas.length];
}

/**
 * Avança o índice global e salva no disco.
 * Deve ser chamado APÓS um post bem-sucedido (ou após fallback com post em outra persona).
 * @param {string} personaName - Nome da persona que foi postada (para log)
 */
export function advanceQueue(personaName) {
    const state = loadState();
    state.index += 1;
    state.lastPost = new Date().toISOString();
    state.lastPersona = personaName;
    saveState(state);
    logger.info(`[RoundRobin] Índice avançado para ${state.index} (último post: ${personaName})`);
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
    const total = personas.length;
    const skipped = [];

    for (let attempt = 0; attempt < total; attempt++) {
        const candidateIndex = (index + attempt) % total;
        const candidate = personas[candidateIndex];

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
