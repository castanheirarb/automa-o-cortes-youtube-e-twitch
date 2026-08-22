// poster/upload-lock.js
// Mutex cross-processo para serializar uploads do Playwright.
//
// Motivação: o Cron poster e o Sports Radar rodam como processos Node DISTINTOS.
// Uma variável booleana em memória não é visível entre processos. Se ambos tentarem
// abrir o Chrome ao mesmo tempo, o segundo crashará ou ficará com UI corrompida.
//
// Solução: lock baseado em arquivo (./scheduler/upload.lock).
//   • Contém { pid, label, ts } em JSON
//   • Se o PID proprietário estiver morto OU o lock tiver > MAX_AGE_MS → stale → rouba
//   • O processo que adquire o lock é responsável por liberá-lo no finally
//
// Interface pública:
//   const release = await acquireUploadLock('cron-roundrobin');
//   try { ... } finally { release(); }

import fs   from 'node:fs';
import path from 'node:path';

const LOCK_PATH  = path.resolve('./scheduler/upload.lock');
const MAX_AGE_MS = 15 * 60 * 1000; // lock expirado se > 15 min (upload nunca demora mais)
const POLL_MS    = 5_000;           // checa disponibilidade a cada 5s
const TIMEOUT_MS = 25 * 60 * 1000; // após 25 min, força a aquisição (segurança)
// isStale() considera o lock expirado só pelo tempo desde a última escrita —
// não checa se o dono ainda está de fato trabalhando. Um fluxo legítimo que
// demore mais que MAX_AGE_MS (ex: distribuição sequencial pra várias contas)
// teria o lock "roubado" por outro processo NO MEIO do próprio upload, com
// os dois navegadores Playwright rodando ao mesmo tempo — o cenário que esse
// lock existe pra evitar. O heartbeat abaixo renova o timestamp periodicamente
// enquanto o dono ainda está ativo, mantendo o lock "fresco" de verdade.
const HEARTBEAT_MS = 5 * 60 * 1000; // bem abaixo de MAX_AGE_MS — nunca deixa "envelhecer"

// ─── Utilitários ──────────────────────────────────────────────────────────────

function isProcessAlive(pid) {
    try {
        process.kill(pid, 0); // sinal 0 apenas testa existência, não mata
        return true;
    } catch {
        return false; // ESRCH = processo não existe
    }
}

function writeLock(label) {
    try {
        const dir = path.dirname(LOCK_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(
            LOCK_PATH,
            JSON.stringify({ pid: process.pid, label, ts: Date.now() }),
            'utf8'
        );
    } catch { /* best-effort — falha silenciosa não impede o upload */ }
}

function deleteLock() {
    try { fs.unlinkSync(LOCK_PATH); } catch { /* já removido */ }
}

function readLock() {
    try {
        return JSON.parse(fs.readFileSync(LOCK_PATH, 'utf8'));
    } catch {
        return null;
    }
}

function isStale(lock) {
    if (!lock) return true;
    if (Date.now() - lock.ts > MAX_AGE_MS) return true;      // expirado por tempo
    if (!isProcessAlive(lock.pid)) return true;              // processo morto
    return false;
}

// ─── API pública ──────────────────────────────────────────────────────────────

/**
 * Aguarda até que o lock esteja livre, então o adquire.
 * Retorna uma função `release` que deve ser chamada no `finally`.
 *
 * @param {string} label - Identificador do solicitante (ex: 'cron', 'express-gol-1')
 * @returns {Promise<() => void>} função de release
 *
 * @example
 * const release = await acquireUploadLock('cron-roundrobin');
 * try { await uploadToYouTube(...); }
 * finally { release(); }
 */
export async function acquireUploadLock(label = 'unknown') {
    const deadline = Date.now() + TIMEOUT_MS;

    while (true) {
        const existing = readLock();

        if (!existing || isStale(existing)) {
            // Lock livre ou stale — adquire agora
            deleteLock();
            writeLock(label);
            // Dupla verificação após escrita (evita race de milissegundos)
            await new Promise((r) => setTimeout(r, 100));
            const confirm = readLock();
            if (confirm?.pid === process.pid) {
                // Adquiriu com sucesso — heartbeat mantém o lock fresco enquanto ativo
                const heartbeat = setInterval(() => writeLock(label), HEARTBEAT_MS);
                return () => {
                    clearInterval(heartbeat);
                    deleteLock();
                };
            }
            // Outra processo escreveu no mesmo instante — volta ao loop
            continue;
        }

        // Lock ativo e válido
        const age = Math.round((Date.now() - existing.ts) / 1000);
        console.log(
            `[UploadLock] Aguardando: em uso por "${existing.label}" ` +
            `(PID ${existing.pid}, ${age}s ago). Retentando em ${POLL_MS / 1000}s...`
        );

        if (Date.now() >= deadline) {
            // Timeout de segurança — força aquisição para nunca bloquear infinitamente
            console.warn('[UploadLock] Timeout de espera — forçando aquisição.');
            deleteLock();
            writeLock(label);
            const heartbeat = setInterval(() => writeLock(label), HEARTBEAT_MS);
            return () => {
                clearInterval(heartbeat);
                deleteLock();
            };
        }

        await new Promise((r) => setTimeout(r, POLL_MS));
    }
}
