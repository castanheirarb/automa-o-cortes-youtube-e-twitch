// poster/queue.js
// Gerencia a fila de arquivos .mp4 para upload.
// Lê ./output (ou uma subpasta de persona específica), retorna o próximo arquivo disponível,
// e move o arquivo para ./postados após o upload.
// registry.json em ./postados garante deduplicação mesmo se renameSync falhar.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { logger } from './logger.js';

const OUTPUT_DIR = path.resolve('./output');
const POSTED_DIR = path.resolve('./postados');
const REGISTRY_PATH = path.join(POSTED_DIR, 'registry.json');
const TIKTOK_REGISTRY_PATH = path.join(POSTED_DIR, 'tiktok-registry.json');
const YOUTUBE_REGISTRY_PATH = path.join(POSTED_DIR, 'youtube-registry.json');

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

// ─── Registry YouTube (deduplicação por plataforma) ──────────────────────────
// Mesmo padrão do tiktok-registry: registra ANTES de iniciar o upload para que
// uma interrupção do processo (Ctrl+C, crash) não cause re-postagem do mesmo vídeo.

function loadYouTubeRegistry() {
    try {
        if (fs.existsSync(YOUTUBE_REGISTRY_PATH)) {
            const data = JSON.parse(fs.readFileSync(YOUTUBE_REGISTRY_PATH, 'utf-8'));
            return new Set(Array.isArray(data) ? data : []);
        }
    } catch (err) {
        logger.warn(`[Queue] Falha ao ler youtube-registry.json: ${err.message} — usando registry vazio.`);
    }
    return new Set();
}

function saveYouTubeRegistry(registry) {
    ensureDirs();
    try {
        fs.writeFileSync(YOUTUBE_REGISTRY_PATH, JSON.stringify([...registry], null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Queue] Falha ao salvar youtube-registry.json: ${err.message}`);
    }
}

/**
 * Verifica se um arquivo já foi enviado ao YouTube (tentado ou confirmado).
 * @param {string} filePath - caminho absoluto do arquivo
 * @returns {boolean}
 */
export function isYouTubePosted(filePath) {
    const registry = loadYouTubeRegistry();
    const key = registryKey(filePath);
    return registry.has(key) || registry.has(path.basename(filePath));
}

/**
 * Registra um arquivo como enviado ao YouTube.
 * Deve ser chamado ANTES de iniciar o upload para evitar duplicatas em caso de crash.
 * @param {string} filePath - caminho absoluto do arquivo
 */
export function registerYouTubePosted(filePath) {
    const registry = loadYouTubeRegistry();
    const key = registryKey(filePath);
    registry.add(key);
    saveYouTubeRegistry(registry);
    logger.info(`[Queue] Registrado no youtube-registry: ${key}`);
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

    // Remove da fila os resíduos já postados (registry) e filtra os disponíveis
    const available = [];
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
        available.push(filePath);
    }

    if (available.length === 0) {
        logger.warn(`[Queue] Todos os vídeos de ${path.basename(personaDir)}/ já foram postados.`);
        return null;
    }

    // ── Seleção com continuidade de contexto ──────────────────────────────────
    // Clipes da mesma subpasta vêm do MESMO vídeo-fonte e formam uma sequência
    // (1__, 2__, ...). Depois de postar o 1º, os turnos seguintes da persona
    // continuam no mesmo vídeo, em ordem numérica, até esgotar a sequência.
    // Sem sequência aberta, começa pelo vídeo-fonte com MAIS clipes restantes
    // (maior peso = mais contexto encadeado); desempate pelo mais antigo.
    const personaName = path.basename(personaDir);
    const groups = new Map();
    for (const f of available) {
        const key = path.dirname(f);
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(f);
    }
    const clipNum = (f) => {
        const m = path.basename(f).match(/^(\d+)/);
        return m ? parseInt(m[1], 10) : Number.MAX_SAFE_INTEGER;
    };
    for (const list of groups.values()) {
        list.sort((a, b) => clipNum(a) - clipNum(b) || a.localeCompare(b));
    }

    const seqState = loadSequenceState();
    let chosenGroup = seqState[personaName];
    if (chosenGroup && groups.has(chosenGroup)) {
        logger.info(
            `[Queue] Continuando sequência de "${path.basename(chosenGroup)}" ` +
            `(${groups.get(chosenGroup).length} clipe(s) restante(s)).`
        );
    } else {
        chosenGroup = [...groups.keys()].sort((a, b) =>
            groups.get(b).length - groups.get(a).length ||
            fs.statSync(groups.get(a)[0]).birthtimeMs - fs.statSync(groups.get(b)[0]).birthtimeMs
        )[0];
        if (groups.size > 1) {
            logger.info(
                `[Queue] Nova sequência: "${path.basename(chosenGroup)}" ` +
                `(${groups.get(chosenGroup).length} clipe(s) — maior contexto entre ${groups.size} vídeos-fonte).`
            );
        }
    }

    const filePath = groups.get(chosenGroup)[0];

    // Persiste a sequência aberta (não em dry-run, que não deve mudar estado real)
    if (!dryRun) {
        seqState[personaName] = chosenGroup;
        saveSequenceState(seqState);
    }

    const basename = path.basename(filePath, '.mp4');
    const title = formatTitle(basename);
    logger.info(`[Queue] Próximo vídeo (${personaName}): ${path.basename(filePath)}`);

    // Registra no dry-registry para que a próxima execução avance para o próximo corte
    if (dryRun) {
        registerDryShown(filePath);
    }

    return { filePath, title };
}

// ─── Estado de sequência (continuidade de contexto por persona) ──────────────

const SEQUENCE_STATE_FILE = path.join(POSTED_DIR, 'sequence-state.json');

function loadSequenceState() {
    try { return JSON.parse(fs.readFileSync(SEQUENCE_STATE_FILE, 'utf-8')); }
    catch { return {}; }
}

function saveSequenceState(state) {
    try {
        if (!fs.existsSync(POSTED_DIR)) fs.mkdirSync(POSTED_DIR, { recursive: true });
        fs.writeFileSync(SEQUENCE_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Queue] Falha ao salvar sequence-state: ${err.message}`);
    }
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

// ─── Dedup por CONTEÚDO (impressão digital) ──────────────────────────────────
// O registry normal usa o CAMINHO do arquivo. Isso não pega o caso em que o
// mesmo conteúdo é regerado com outro nome — foi o que causou a postagem do
// mesmo vídeo longo em dois dias seguidos (compilação idêntica, nomes
// diferentes por causa do Date.now()). O hash abaixo compara o conteúdo real.
//
// Para arquivos grandes, faz hash de amostras (início, meio e fim) + tamanho:
// rápido e suficiente para detectar arquivos byte-a-byte iguais.

const CONTENT_REGISTRY = path.join(POSTED_DIR, 'content-hashes.json');
const SAMPLE_BYTES = 2 * 1024 * 1024; // 2 MB por amostra

export function fileContentHash(filePath) {
    const size = fs.statSync(filePath).size;
    const hash = crypto.createHash('sha1');
    hash.update(String(size));

    const fd = fs.openSync(filePath, 'r');
    try {
        const offsets = [0, Math.max(0, Math.floor(size / 2) - SAMPLE_BYTES / 2), Math.max(0, size - SAMPLE_BYTES)];
        const buf = Buffer.alloc(SAMPLE_BYTES);
        for (const off of offsets) {
            const read = fs.readSync(fd, buf, 0, Math.min(SAMPLE_BYTES, size - off), off);
            if (read > 0) hash.update(buf.subarray(0, read));
        }
    } finally {
        fs.closeSync(fd);
    }
    return hash.digest('hex');
}

function loadContentHashes() {
    try { return JSON.parse(fs.readFileSync(CONTENT_REGISTRY, 'utf-8')); }
    catch { return {}; }
}

/**
 * True se um arquivo com ESTE CONTEÚDO já foi postado antes.
 */
export function isContentPosted(filePath) {
    try {
        const hashes = loadContentHashes();
        const h = fileContentHash(filePath);
        if (hashes[h]) {
            logger.warn(`[Queue] Conteúdo idêntico já postado em ${hashes[h].postedAt}: "${hashes[h].file}"`);
            return true;
        }
        return false;
    } catch (err) {
        logger.warn(`[Queue] Falha ao calcular hash de conteúdo: ${err.message} — seguindo sem esse check.`);
        return false;
    }
}

/**
 * Registra a impressão digital do conteúdo postado.
 */
export function registerContentPosted(filePath) {
    try {
        const hashes = loadContentHashes();
        hashes[fileContentHash(filePath)] = {
            file: path.basename(filePath),
            postedAt: new Date().toISOString(),
        };
        if (!fs.existsSync(POSTED_DIR)) fs.mkdirSync(POSTED_DIR, { recursive: true });
        fs.writeFileSync(CONTENT_REGISTRY, JSON.stringify(hashes, null, 2), 'utf-8');
    } catch (err) {
        logger.warn(`[Queue] Falha ao registrar hash de conteúdo: ${err.message}`);
    }
}
