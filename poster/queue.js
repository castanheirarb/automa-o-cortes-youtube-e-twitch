// poster/queue.js
// Gerencia a fila de arquivos .mp4 para upload.
// Lê ./output (ou uma subpasta de persona específica), retorna o próximo arquivo disponível,
// e move o arquivo para ./postados após o upload.
// registry.json em ./postados garante deduplicação mesmo se renameSync falhar.

import fs from 'node:fs';
import path from 'node:path';
import { logger } from './logger.js';

const OUTPUT_DIR = path.resolve('./output');
const POSTED_DIR = path.resolve('./postados');
const REGISTRY_PATH = path.join(POSTED_DIR, 'registry.json');
const TIKTOK_REGISTRY_PATH = path.join(POSTED_DIR, 'tiktok-registry.json');

// ─── Registry (deduplicação) ──────────────────────────────────────────────────

/**
 * Lê o registry de vídeos já postados.
 * @returns {Set<string>} conjunto de nomes de arquivo já processados
 */
function loadRegistry() {
    try {
        if (fs.existsSync(REGISTRY_PATH)) {
            const data = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf-8'));
            return new Set(Array.isArray(data) ? data : []);
        }
    } catch (err) {
        logger.warn(`[Queue] Falha ao ler registry.json: ${err.message} — usando registry vazio.`);
    }
    return new Set();
}

/**
 * Salva o registry no disco.
 * @param {Set<string>} registry
 */
function saveRegistry(registry) {
    ensureDirs();
    try {
        fs.writeFileSync(REGISTRY_PATH, JSON.stringify([...registry], null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Queue] Falha ao salvar registry.json: ${err.message}`);
    }
}

/**
 * Retorna a chave única de um arquivo no registry.
 * Usa caminho relativo ao OUTPUT_DIR para evitar colisões entre personas
 * (ex: cariani/1__pico-4s.mp4 ≠ lubatv/1__pico-4s.mp4).
 * @param {string} filePath - caminho absoluto do arquivo
 * @returns {string}
 */
function registryKey(filePath) {
    const rel = path.relative(OUTPUT_DIR, filePath);
    // Normaliza separadores para garantir consistência entre OS
    return rel.replace(/\\/g, '/');
}

/**
 * Verifica se um arquivo já foi postado (pelo caminho relativo ao OUTPUT_DIR).
 * @param {string} filePath - caminho absoluto do arquivo
 * @returns {boolean}
 */
export function isAlreadyPosted(filePath) {
    const registry = loadRegistry();
    const key = registryKey(filePath);
    // Suporte retroativo: só aceita match por basename quando o arquivo
    // está diretamente em ./output/ (sem subpasta de persona).
    // Entradas antigas sem caminho não devem contaminar outras personas.
    const isRootLevel = !key.includes('/');
    return registry.has(key) || (isRootLevel && registry.has(path.basename(filePath)));
}

/**
 * Registra um arquivo como postado no registry JSON.
 * Deve ser chamado ANTES de mover o arquivo, para garantir persistência.
 * @param {string} filePath - caminho absoluto do arquivo
 */
export function registerAsPosted(filePath) {
    const registry = loadRegistry();
    const key = registryKey(filePath);
    registry.add(key);
    saveRegistry(registry);
    logger.info(`[Queue] Registrado como postado: ${key}`);
}

// ─── Dry-Run Registry (simulação sem postar) ─────────────────────────────────
// Rastreia quais vídeos já foram exibidos em dry-run para que execuções
// consecutivas avancem para o PRÓXIMO corte em vez de repetir o mesmo arquivo.
// Reset manual: apague ./postados/dry-registry.json

const DRY_REGISTRY_PATH = path.join(POSTED_DIR, 'dry-registry.json');

function loadDryRegistry() {
    try {
        if (fs.existsSync(DRY_REGISTRY_PATH)) {
            const data = JSON.parse(fs.readFileSync(DRY_REGISTRY_PATH, 'utf-8'));
            return new Set(Array.isArray(data) ? data : []);
        }
    } catch (err) {
        logger.warn(`[Queue] Falha ao ler dry-registry.json: ${err.message} — usando vazio.`);
    }
    return new Set();
}

function saveDryRegistry(registry) {
    ensureDirs();
    try {
        fs.writeFileSync(DRY_REGISTRY_PATH, JSON.stringify([...registry], null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Queue] Falha ao salvar dry-registry.json: ${err.message}`);
    }
}

function isDryShown(filePath) {
    const registry = loadDryRegistry();
    const key = registryKey(filePath);
    return registry.has(key);
}

function registerDryShown(filePath) {
    const registry = loadDryRegistry();
    const key = registryKey(filePath);
    registry.add(key);
    saveDryRegistry(registry);
    logger.info(`[Queue] Dry-run: simulado → ${key}`);
}

// ─── Registry TikTok (deduplicação por plataforma) ───────────────────────────

function loadTikTokRegistry() {
    try {
        if (fs.existsSync(TIKTOK_REGISTRY_PATH)) {
            const data = JSON.parse(fs.readFileSync(TIKTOK_REGISTRY_PATH, 'utf-8'));
            return new Set(Array.isArray(data) ? data : []);
        }
    } catch (err) {
        logger.warn(`[Queue] Falha ao ler tiktok-registry.json: ${err.message} — usando registry vazio.`);
    }
    return new Set();
}

function saveTikTokRegistry(registry) {
    ensureDirs();
    try {
        fs.writeFileSync(TIKTOK_REGISTRY_PATH, JSON.stringify([...registry], null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Queue] Falha ao salvar tiktok-registry.json: ${err.message}`);
    }
}

/**
 * Verifica se um arquivo já foi enviado ao TikTok (tentado ou confirmado).
 * @param {string} filePath - caminho absoluto do arquivo
 * @returns {boolean}
 */
export function isTikTokPosted(filePath) {
    const registry = loadTikTokRegistry();
    const key = registryKey(filePath);
    return registry.has(key) || registry.has(path.basename(filePath));
}

/**
 * Registra um arquivo como enviado ao TikTok.
 * Deve ser chamado ANTES de iniciar o upload para evitar duplicatas em caso de crash.
 * @param {string} filePath - caminho absoluto do arquivo
 */
export function registerTikTokPosted(filePath) {
    const registry = loadTikTokRegistry();
    const key = registryKey(filePath);
    registry.add(key);
    saveTikTokRegistry(registry);
    logger.info(`[Queue] Registrado no tiktok-registry: ${key}`);
}

// ─── Dirs ─────────────────────────────────────────────────────────────────────

/**
 * Garante que os diretórios necessários existam.
 */
export function ensureDirs() {
    [OUTPUT_DIR, POSTED_DIR].forEach((dir) => {
        if (!fs.existsSync(dir)) {
            fs.mkdirSync(dir, { recursive: true });
        }
    });
}

// ─── Fila ─────────────────────────────────────────────────────────────────────

/**
 * Retorna o PRÓXIMO arquivo .mp4 disponível na pasta ./output
 * (percorre subpastas também, para compatibilidade com a estrutura do canal corte).
 * Pula arquivos que já constam no registry (já foram postados).
 * Retorna null se não houver nenhum.
 *
 * @returns {{ filePath: string, title: string } | null}
 */
export function getNextVideo() {
    ensureDirs();

    // Busca recursivamente todos os .mp4 dentro de ./output
    const mp4Files = findMp4sRecursive(OUTPUT_DIR);

    if (mp4Files.length === 0) {
        logger.warn('Nenhum vídeo disponível em ./output para postar.');
        return null;
    }

    // Ordena por data de criação (mais antigo primeiro)
    mp4Files.sort((a, b) => fs.statSync(a).birthtimeMs - fs.statSync(b).birthtimeMs);

    // Encontra o primeiro que NOT está no registry
    for (const filePath of mp4Files) {
        if (isAlreadyPosted(filePath)) {
            logger.warn(`[Queue] Arquivo já postado (registry), pulando: ${path.basename(filePath)}`);
            // Move para postados se ainda estiver em output (limpeza)
            try { markAsPosted(filePath); } catch { /* ignora */ }
            continue;
        }

        const basename = path.basename(filePath, '.mp4');
        const title = formatTitle(basename);
        logger.info(`Próximo vídeo na fila: ${path.relative(OUTPUT_DIR, filePath)}`);
        return { filePath, title };
    }

    logger.warn('Todos os vídeos em ./output já foram postados.');
    return null;
}

/**
 * Move o arquivo de ./output para ./postados após upload bem-sucedido.
 * Preserva a estrutura de subpastas.
 * Registra no registry ANTES de mover para garantir deduplicação em caso de falha de I/O.
 *
 * @param {string} filePath - Caminho absoluto do arquivo em ./output
 */
export function markAsPosted(filePath) {
    ensureDirs();

    // Registra no registry PRIMEIRO (garante deduplicação mesmo se o rename falhar)
    registerAsPosted(filePath);

    // Recria a estrutura de subpastas dentro de ./postados
    const relative = path.relative(OUTPUT_DIR, filePath);
    const destPath = path.join(POSTED_DIR, relative);
    const destDir = path.dirname(destPath);

    if (!fs.existsSync(destDir)) {
        fs.mkdirSync(destDir, { recursive: true });
    }

    if (!fs.existsSync(filePath)) {
        logger.warn(`[Queue] Arquivo não encontrado para mover (já movido?): ${relative}`);
        return;
    }

    fs.renameSync(filePath, destPath);
    logger.success(`Arquivo movido para ./postados: ${relative}`);
}

// ─── Por Persona (Round-Robin) ───────────────────────────────────────────────

/**
 * Retorna o próximo arquivo .mp4 disponível dentro da pasta de uma persona específica.
 * Respeita o registry de deduplicação (pula já-postados).
 * Retorna null se a pasta estiver vazia ou todos já postados.
 *
 * @param {string} personaDir - Caminho absoluto da pasta da persona (ex: ./output/cariani)
 * @returns {{ filePath: string, title: string } | null}
 */
export function getNextVideoFromPersona(personaDir, { dryRun = false } = {}) {
    if (!fs.existsSync(personaDir)) {
        logger.warn(`[Queue] Pasta da persona não existe: ${personaDir}`);
        return null;
    }

    const mp4Files = findMp4sRecursive(personaDir);

    if (mp4Files.length === 0) {
        logger.warn(`[Queue] Nenhum .mp4 encontrado em: ${path.basename(personaDir)}/`);
        return null;
    }

    // Ordena por data de criação (mais antigo primeiro → FIFO)
    mp4Files.sort((a, b) => fs.statSync(a).birthtimeMs - fs.statSync(b).birthtimeMs);

    for (const filePath of mp4Files) {
        if (isAlreadyPosted(filePath)) {
            logger.warn(`[Queue] Já postado (registry), pulando: ${path.basename(filePath)}`);
            // Em dry-run não move nem registra — apenas pula para o próximo
            if (!dryRun) {
                try { markAsPosted(filePath); } catch { /* ignora */ }
            }
            continue;
        }

        // Em dry-run: pula vídeos já simulados em execuções anteriores
        // para que cada chamada a poster:dry avance para o próximo corte.
        if (dryRun && isDryShown(filePath)) {
            logger.warn(`[Queue] Dry-run: já simulado, pulando: ${path.basename(filePath)}`);
            continue;
        }

        const basename = path.basename(filePath, '.mp4');
        const title = formatTitle(basename);
        logger.info(`[Queue] Próximo vídeo (${path.basename(personaDir)}): ${path.basename(filePath)}`);

        // Registra no dry-registry para que a próxima execução avance para o próximo corte
        if (dryRun) {
            registerDryShown(filePath);
        }

        return { filePath, title };
    }

    logger.warn(`[Queue] Todos os vídeos de ${path.basename(personaDir)}/ já foram postados.`);
    return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function findMp4sRecursive(dir) {
    const results = [];
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const fullPath = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            results.push(...findMp4sRecursive(fullPath));
        } else if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp4')) {
            results.push(fullPath);
        }
    }
    return results;
}

/**
 * Transforma o nome do arquivo em um título legível.
 * Ex: "01__pico-4439s" → "Corte #1 - Pico em 1h 13m 59s"
 * Também aceita títulos com nomes de vídeo.
 */
function formatTitle(basename) {
    // Extrai número do clip e tempo de pico
    const match = basename.match(/^(\d+)__pico-(\d+)s$/);
    if (match) {
        const num = parseInt(match[1], 10);
        const sec = parseInt(match[2], 10);
        return `Corte #${num} - ${secondsToReadable(sec)} #shorts #cortes`;
    }
    // Fallback: usa o nome bruto, substitui underscores por espaços
    return basename.replace(/_+/g, ' ').trim() + ' #shorts #cortes';
}

function secondsToReadable(total) {
    const h = Math.floor(total / 3600);
    const m = Math.floor((total % 3600) / 60);
    const s = total % 60;
    return h > 0 ? `${h}h ${m}m ${s}s` : `${m}m ${s}s`;
}
