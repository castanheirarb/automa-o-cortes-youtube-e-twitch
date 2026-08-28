// src/obs/cli.js
// CLI de controle do OBS para espelhamento de tela na live.
//
// Uso:
//   node src/obs/cli.js mirror            → garante cena de desktop + inicia transmissão
//   node src/obs/cli.js start             → inicia transmissão
//   node src/obs/cli.js stop              → encerra transmissão
//   node src/obs/cli.js scene <nome>      → troca de cena
//   node src/obs/cli.js status            → status da transmissão

import {
    ensureDesktopScene,
    setScene,
    startStream,
    stopStream,
    streamStatus,
    obsDisconnect,
} from './obs-control.js';

const [cmd, arg] = process.argv.slice(2);

async function main() {
    switch (cmd) {
        case 'mirror': {
            const scene = await ensureDesktopScene(arg);
            await startStream();
            console.log(`✅  Espelhando a Área de Trabalho na cena "${scene}" — transmissão ativa.`);
            break;
        }
        case 'start':
            await startStream();
            break;
        case 'stop':
            await stopStream();
            break;
        case 'scene':
            if (!arg) {
                console.error('Uso: node src/obs/cli.js scene <nome-da-cena>');
                process.exit(1);
            }
            await setScene(arg);
            break;
        case 'status': {
            const s = await streamStatus();
            console.log(`  Transmissão: ${s.ativo ? '🔴 AO VIVO' : '⚫ parada'}`);
            console.log(`  Cena atual:  ${s.cena}`);
            if (s.ativo) {
                console.log(`  Duração:     ${s.duracao}`);
                console.log(`  Frames perdidos: ${s.framesPerdidos}`);
            }
            break;
        }
        default:
            console.log('Comandos: mirror | start | stop | scene <nome> | status');
            process.exit(cmd ? 1 : 0);
    }
    await obsDisconnect();
}

main().catch((err) => {
    console.error(`❌  OBS: ${err.message}`);
    console.error('    Verifique se o OBS está aberto com o WebSocket Server habilitado');
    console.error('    (Ferramentas → WebSocket Server Settings) e o OBS_WS_PASSWORD no .env.');
    process.exit(1);
});
