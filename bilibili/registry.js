// bilibili/registry.js
// Registro anti-duplicata — mesmo padrão "registra antes de tentar" do resto
// do projeto (ver CLAUDE.md): a fonte é marcada como tentada ANTES do
// download/upload, não depois, pra não reprocessar a mesma URL se o processo
// cair no meio. Estado próprio deste projeto (bilibili/state/), nunca toca
// nos registries dos outros canais (postados/*.json).

import fs from 'node:fs';
import path from 'node:path';

const REGISTRY_FILE = path.resolve('./bilibili/state/registry.json');

function loadRegistry() {
    try {
        return JSON.parse(fs.readFileSync(REGISTRY_FILE, 'utf-8'));
    } catch {
        return {};
    }
}

function saveRegistry(registry) {
    fs.mkdirSync(path.dirname(REGISTRY_FILE), { recursive: true });
    fs.writeFileSync(REGISTRY_FILE, JSON.stringify(registry, null, 2), 'utf-8');
}

export function isAlreadyAttempted(sourceUrl) {
    return Object.prototype.hasOwnProperty.call(loadRegistry(), sourceUrl);
}

export function registerAttempt(sourceUrl) {
    const registry = loadRegistry();
    if (!registry[sourceUrl]) {
        registry[sourceUrl] = { attemptedAt: new Date().toISOString(), published: false };
        saveRegistry(registry);
    }
}

export function registerPublished(sourceUrl, meta = {}) {
    const registry = loadRegistry();
    registry[sourceUrl] = {
        ...(registry[sourceUrl] || {}),
        published: true,
        publishedAt: new Date().toISOString(),
        ...meta,
    };
    saveRegistry(registry);
}
