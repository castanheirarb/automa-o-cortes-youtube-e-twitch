// ============================================
// [Lek Do BlacK] - TikTok Live Monitor Server
// Backend WebSocket para monitoramento e clonagem
// Porta: 8081
// ============================================

const WebSocket = require('ws');
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

// ============================================
// CONFIGURAÇÕES
// ============================================

const PORT = 8081;
const LOG_DIR = path.join(__dirname, '../../logs');
const LOG_FILE = path.join(LOG_DIR, 'tiktok-monitor.log');

// Cria diretório de logs se não existir
if (!fs.existsSync(LOG_DIR)) {
    fs.mkdirSync(LOG_DIR, { recursive: true });
}

// ============================================
// LOGGER
// ============================================

function log(message, type = 'info') {
    const timestamp = new Date().toISOString();
    const entry = `[${timestamp}] [${type.toUpperCase()}] ${message}`;
    console.log(entry);

    try {
        fs.appendFileSync(LOG_FILE, entry + '\n');
    } catch (err) {
        console.error('Erro ao escrever log:', err.message);
    }
}

// ============================================
// ESTADO GLOBAL
// ============================================

let monitoredUsers = [];       // Lista de @usernames monitorados
let activeLives = [];          // Lives ativas com dados
let clonedLives = new Map();   // username -> { config, process, startedAt }
let wss = null;                // Servidor WebSocket

// ============================================
// SIMULADOR DE LIVES (Substitua pela API real)
// ============================================

function createSimulatedLive(username) {
    return {
        username: username,
        roomId: `room_${username}_${Date.now()}`,
        title: `Live de @${username}`,
        summary: {
            currentViewers: Math.floor(Math.random() * 5000) + 100,
            peakViewers: Math.floor(Math.random() * 10000) + 500,
            totalChatMessages: Math.floor(Math.random() * 500),
            totalGifts: Math.floor(Math.random() * 50),
            liveDuration: Math.floor(Math.random() * 3600),
        },
        startedAt: new Date().toISOString(),
        isLive: true,
    };
}

function updateSimulatedMetrics(live) {
    const change = Math.floor(Math.random() * 200) - 100;
    live.summary.currentViewers = Math.max(10, live.summary.currentViewers + change);
    live.summary.totalChatMessages += Math.floor(Math.random() * 10);
    live.summary.totalGifts += Math.random() < 0.3 ? 1 : 0;
    live.summary.liveDuration += 5;

    if (live.summary.currentViewers > live.summary.peakViewers) {
        live.summary.peakViewers = live.summary.currentViewers;
    }
}

// ============================================
// GERENCIAMENTO DE CLONAGEM (FFmpeg)
// ============================================

function startFFmpegClone(config) {
    const { username, rtmpUrl, streamKey, delay, overlay } = config;

    const fullRtmpUrl = `${rtmpUrl}${streamKey}`;

    log(`🎥 Iniciando FFmpeg: @${username} -> ${fullRtmpUrl.substring(0, 30)}...`, 'clone');

    // Comando FFmpeg para restreaming com overlay e delay
    const ffmpegArgs = [
        '-re',                                          // Leitura em tempo real
        '-i', `https://tiktok.com/@${username}/live`,   // URL da live (precisa de ajuste real)
        '-vf', `drawtext=text='${overlay.text}':fontcolor=white:fontsize=24:box=1:boxcolor=black@0.5:x=10:y=10`,
        '-c:v', 'libx264',                              // Codec de vídeo
        '-preset', 'veryfast',                          // Velocidade de encoding
        '-b:v', '3000k',                                // Bitrate
        '-maxrate', '3000k',
        '-bufsize', '6000k',
        '-c:a', 'aac',                                  // Codec de áudio
        '-b:a', '128k',
        '-f', 'flv',                                    // Formato RTMP
        fullRtmpUrl,
    ];

    log(`🔧 Comando FFmpeg: ffmpeg ${ffmpegArgs.join(' ')}`, 'clone');

    // Spawn FFmpeg
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    ffmpeg.stdout.on('data', (data) => {
        log(`[FFmpeg stdout] ${data.toString().trim()}`, 'clone');
    });

    ffmpeg.stderr.on('data', (data) => {
        log(`[FFmpeg stderr] ${data.toString().trim()}`, 'clone');
    });

    ffmpeg.on('close', (code) => {
        log(`⏹️ FFmpeg encerrado com código ${code}`, 'clone');
        stopClone(username);
    });

    ffmpeg.on('error', (err) => {
        log(`❌ Erro FFmpeg: ${err.message}`, 'error');
        stopClone(username);
    });

    return ffmpeg;
}

function stopClone(username) {
    const cloneData = clonedLives.get(username);
    if (!cloneData) return;

    log(`⏹️ Parando clonagem de @${username}`, 'clone');

    // Mata processo FFmpeg
    if (cloneData.process) {
        try {
            cloneData.process.kill('SIGTERM');
            setTimeout(() => {
                if (cloneData.process && !cloneData.process.killed) {
                    cloneData.process.kill('SIGKILL');
                }
            }, 5000);
        } catch (err) {
            log(`Erro ao matar FFmpeg: ${err.message}`, 'error');
        }
    }

    clonedLives.delete(username);

    // Notifica clientes
    broadcast({
        type: 'clone_stopped',
        data: { username, timestamp: new Date().toISOString() }
    });
}

// ============================================
// BROADCAST PARA TODOS OS CLIENTES
// ============================================

function broadcast(data) {
    if (!wss) return;

    const message = JSON.stringify(data);
    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            client.send(message);
        }
    });
}

// ============================================
// SERVIDOR WEBSOCKET
// ============================================

function startServer() {
    wss = new WebSocket.Server({ port: PORT });

    log(`🚀 TikTok Live Monitor rodando na porta ${PORT}`, 'success');
    log(`📁 Logs: ${LOG_FILE}`, 'info');
    log(`📡 Aguardando conexões...`, 'info');

    wss.on('connection', (ws) => {
        const clientId = `client_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        log(`📱 Cliente conectado: ${clientId}`, 'info');

        // Envia estado inicial
        ws.send(JSON.stringify({
            type: 'init',
            data: {
                status: activeLives,
                clones: Array.from(clonedLives.keys()),
                stats: getStats(),
            }
        }));

        // Handler de mensagens
        ws.on('message', (data) => {
            try {
                const msg = JSON.parse(data.toString());
                log(`📨 [${clientId}] ${msg.action}: ${JSON.stringify(msg).substring(0, 100)}`, 'info');
                handleMessage(ws, msg);
            } catch (err) {
                log(`❌ Mensagem inválida: ${err.message}`, 'error');
                ws.send(JSON.stringify({ type: 'error', message: 'JSON inválido' }));
            }
        });

        // Handler de desconexão
        ws.on('close', () => {
            log(`📱 Cliente desconectado: ${clientId}`, 'info');
        });

        // Handler de erro
        ws.on('error', (err) => {
            log(`❌ Erro WebSocket [${clientId}]: ${err.message}`, 'error');
        });
    });

    wss.on('error', (err) => {
        log(`❌ Erro no servidor WebSocket: ${err.message}`, 'error');
    });

    wss.on('listening', () => {
        log(`✅ Servidor WebSocket iniciado com sucesso`, 'success');
    });
}

// ============================================
// HANDLER DE MENSAGENS
// ============================================

function handleMessage(ws, msg) {
    const { action } = msg;

    switch (action) {
        // ==========================================
        // MONITORAMENTO
        // ==========================================

        case 'start_monitor':
            const username = (msg.username || '').replace('@', '').trim();

            if (!username) {
                ws.send(JSON.stringify({ type: 'error', message: 'Username vazio!' }));
                return;
            }

            if (monitoredUsers.includes(username)) {
                ws.send(JSON.stringify({ type: 'ack', action, status: 'already_monitoring', username }));
                return;
            }

            monitoredUsers.push(username);
            log(`✅ Monitorando @${username}`, 'success');

            // Cria live simulada (substitua pela conexão real ao TikTok)
            const live = createSimulatedLive(username);
            activeLives.push(live);

            ws.send(JSON.stringify({ type: 'ack', action, status: 'ok', username }));

            // Notifica todos que live iniciou
            broadcast({
                type: 'live_started',
                data: { username, ...live }
            });
            break;

        case 'stop_monitor':
            const stopUsername = (msg.username || '').replace('@', '');
            monitoredUsers = monitoredUsers.filter(u => u !== stopUsername);
            activeLives = activeLives.filter(l => l.username !== stopUsername);
            ws.send(JSON.stringify({ type: 'ack', action, status: 'ok', username: stopUsername }));
            break;

        // ==========================================
        // CLONAGEM
        // ==========================================

        case 'start_clone':
            const cloneConfig = msg.config;

            if (!cloneConfig || !cloneConfig.username) {
                ws.send(JSON.stringify({ type: 'error', message: 'Configuração de clone inválida!' }));
                return;
            }

            if (clonedLives.has(cloneConfig.username)) {
                ws.send(JSON.stringify({ type: 'error', message: `Já clonando @${cloneConfig.username}!` }));
                return;
            }

            log(`🔄 Iniciando clonagem: @${cloneConfig.username}`, 'clone');

            // Inicia FFmpeg (substitua pela captura real)
            const ffmpegProcess = startFFmpegClone(cloneConfig);

            clonedLives.set(cloneConfig.username, {
                config: cloneConfig,
                process: ffmpegProcess,
                startedAt: Date.now(),
            });

            ws.send(JSON.stringify({ type: 'ack', action, status: 'ok', username: cloneConfig.username }));

            broadcast({
                type: 'clone_started',
                data: {
                    username: cloneConfig.username,
                    delay: cloneConfig.delay,
                    overlay: cloneConfig.overlay,
                    timestamp: new Date().toISOString(),
                }
            });
            break;

        case 'stop_clone':
            const cloneUsername = (msg.username || '').replace('@', '');

            if (!clonedLives.has(cloneUsername)) {
                ws.send(JSON.stringify({ type: 'error', message: `@${cloneUsername} não está sendo clonado!` }));
                return;
            }

            stopClone(cloneUsername);
            ws.send(JSON.stringify({ type: 'ack', action, status: 'ok', username: cloneUsername }));
            break;

        // ==========================================
        // CONSULTAS
        // ==========================================

        case 'get_status':
            ws.send(JSON.stringify({ type: 'status', data: activeLives }));
            break;

        case 'get_stats':
            ws.send(JSON.stringify({ type: 'stats', data: getStats() }));
            break;

        case 'get_clones':
            const clones = Array.from(clonedLives.entries()).map(([username, data]) => ({
                username,
                startedAt: data.startedAt,
                duration: Math.floor((Date.now() - data.startedAt) / 1000),
                config: {
                    delay: data.config.delay,
                    overlay: data.config.overlay,
                },
            }));
            ws.send(JSON.stringify({ type: 'clones', data: clones }));
            break;

        default:
            ws.send(JSON.stringify({ type: 'error', message: `Ação desconhecida: ${action}` }));
    }
}

// ============================================
// ESTATÍSTICAS
// ============================================

function getStats() {
    return {
        activeMonitors: activeLives.length,
        activeClones: clonedLives.size,
        totalMonitored: monitoredUsers.length,
        uptime: Math.floor(process.uptime()),
        totalViewers: activeLives.reduce((sum, l) => sum + l.summary.currentViewers, 0),
        totalChatMessages: activeLives.reduce((sum, l) => sum + l.summary.totalChatMessages, 0),
        serverMemory: Math.round(process.memoryUsage().heapUsed / 1024 / 1024) + ' MB',
    };
}

// ============================================
// ATUALIZAÇÃO PERIÓDICA DE MÉTRICAS
// ============================================

function startMetricsUpdater() {
    setInterval(() => {
        // Atualiza métricas simuladas
        activeLives.forEach(live => {
            updateSimulatedMetrics(live);

            // Notifica viewers atualizados
            broadcast({
                type: 'viewers',
                data: {
                    username: live.username,
                    count: live.summary.currentViewers,
                    peak: live.summary.peakViewers,
                }
            });
        });

        // Atualiza status de clones
        if (clonedLives.size > 0) {
            const clonesStatus = Array.from(clonedLives.entries()).map(([username, data]) => ({
                username,
                duration: Math.floor((Date.now() - data.startedAt) / 1000),
            }));

            broadcast({
                type: 'clones_update',
                data: clonesStatus,
            });
        }

    }, 5000); // A cada 5 segundos
}

// ============================================
// LIMPEZA DE LIVES INATIVAS (SIMULADA)
// ============================================

function startCleanupService() {
    setInterval(() => {
        const now = Date.now();

        // Remove lives com mais de 4 horas (simulado)
        activeLives = activeLives.filter(live => {
            const startedAt = new Date(live.startedAt).getTime();
            const duration = (now - startedAt) / 1000;

            if (duration > 14400) { // 4 horas
                log(`🏁 Live encerrada (timeout): @${live.username}`, 'warning');

                // Se estava clonando, para
                if (clonedLives.has(live.username)) {
                    stopClone(live.username);
                }

                broadcast({
                    type: 'live_ended',
                    data: {
                        username: live.username,
                        reason: 'timeout',
                        duration: Math.floor(duration),
                    }
                });

                return false;
            }
            return true;
        });

    }, 60000); // A cada 1 minuto
}

// ============================================
// INICIALIZAÇÃO
// ============================================

function init() {
    console.log(`
╔══════════════════════════════════════════════════════╗
║                                                      ║
║   🎥 TIKTOK LIVE MONITOR - Lek Do BlacK            ║
║   Backend WebSocket Server                          ║
║                                                      ║
║   Porta: ${PORT}                                        ║
║   Logs:  ${LOG_FILE}
║                                                      ║
╚══════════════════════════════════════════════════════╝
    `);

    startServer();
    startMetricsUpdater();
    startCleanupService();

    log('✅ Todos os serviços iniciados', 'success');
    log('📡 Aguardando conexões WebSocket...', 'info');
    log('💡 Dica: Abra index.html no navegador', 'info');
}

// ============================================
// GRACEFUL SHUTDOWN
// ============================================

process.on('SIGINT', () => {
    log('💀 Encerrando servidor...', 'warning');

    // Para todos os clones
    clonedLives.forEach((data, username) => {
        stopClone(username);
    });

    // Fecha WebSocket
    if (wss) {
        wss.close();
    }

    log('✅ Servidor encerrado', 'success');
    process.exit(0);
});

process.on('uncaughtException', (err) => {
    log(`❌ Erro não tratado: ${err.message}`, 'error');
    log(err.stack, 'error');
});

// ============================================
// START!
// ============================================

init();