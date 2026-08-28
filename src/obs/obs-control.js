// src/obs/obs-control.js
// Controle do OBS Studio via WebSocket (obs-websocket v5, nativo no OBS 28+).
//
// Requer no OBS: Ferramentas → WebSocket Server Settings → habilitar servidor.
// Configure OBS_WS_URL / OBS_WS_PASSWORD no .env.
//
// Uso programático:
//   import { obsConnect, startStream, stopStream, setScene, ensureDesktopScene } from './obs/obs-control.js';

import 'dotenv/config';
import OBSWebSocket from 'obs-websocket-js';
import { logger } from '../utils/logger.js';

const OBS_WS_URL = process.env.OBS_WS_URL || 'ws://127.0.0.1:4455';
const OBS_WS_PASSWORD = process.env.OBS_WS_PASSWORD || '';
const OBS_SCENE = process.env.OBS_SCENE || 'Desktop';

const obs = new OBSWebSocket();
let connected = false;

export async function obsConnect() {
    if (connected) return obs;
    const { obsWebSocketVersion } = await obs.connect(OBS_WS_URL, OBS_WS_PASSWORD || undefined);
    connected = true;
    logger.info(`[OBS] Conectado (obs-websocket v${obsWebSocketVersion}) em ${OBS_WS_URL}`);
    obs.on('ConnectionClosed', () => {
        connected = false;
        logger.warn('[OBS] Conexão encerrada.');
    });
    return obs;
}

export async function obsDisconnect() {
    if (!connected) return;
    await obs.disconnect();
    connected = false;
}

// Garante que existe uma cena com captura de tela (Display Capture) e a ativa.
export async function ensureDesktopScene(sceneName = OBS_SCENE) {
    await obsConnect();

    const { scenes } = await obs.call('GetSceneList');
    const exists = scenes.some((s) => s.sceneName === sceneName);
    if (!exists) {
        await obs.call('CreateScene', { sceneName });
        logger.info(`[OBS] Cena "${sceneName}" criada.`);
    }

    const { sceneItems } = await obs.call('GetSceneItemList', { sceneName });
    const hasCapture = sceneItems.some((i) => i.inputKind === 'monitor_capture');
    if (!hasCapture) {
        // 'monitor_capture' = Display Capture no Windows (DXGI)
        await obs.call('CreateInput', {
            sceneName,
            inputName: `Tela — ${sceneName}`,
            inputKind: 'monitor_capture',
            inputSettings: { method: 2 }, // 2 = DXGI (Windows 10 1903+), menor latência
        });
        logger.info(`[OBS] Fonte de captura de tela adicionada à cena "${sceneName}".`);
    }

    await obs.call('SetCurrentProgramScene', { sceneName });
    return sceneName;
}

export async function setScene(sceneName) {
    await obsConnect();
    await obs.call('SetCurrentProgramScene', { sceneName });
    logger.info(`[OBS] Cena ativa: "${sceneName}"`);
}

export async function startStream() {
    await obsConnect();
    const { outputActive } = await obs.call('GetStreamStatus');
    if (outputActive) {
        logger.info('[OBS] Transmissão já está ativa.');
        return;
    }
    await obs.call('StartStream');
    logger.info('[OBS] Transmissão iniciada.');
}

export async function stopStream() {
    await obsConnect();
    await obs.call('StopStream');
    logger.info('[OBS] Transmissão encerrada.');
}

export async function streamStatus() {
    await obsConnect();
    const status = await obs.call('GetStreamStatus');
    const scene = await obs.call('GetCurrentProgramScene');
    return {
        ativo: status.outputActive,
        duracao: status.outputTimecode,
        bytes: status.outputBytes,
        framesPerdidos: status.outputSkippedFrames,
        cena: scene.currentProgramSceneName,
    };
}
