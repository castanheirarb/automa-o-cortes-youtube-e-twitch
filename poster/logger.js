// poster/logger.js
// Logger colorido (mesmo estilo do canal corte)

const COLORS = {
    reset: '\x1b[0m', bright: '\x1b[1m',
    red: '\x1b[31m', green: '\x1b[32m',
    yellow: '\x1b[33m', blue: '\x1b[34m', cyan: '\x1b[36m', magenta: '\x1b[35m',
};

function ts() { return new Date().toLocaleTimeString('pt-BR'); }

export const logger = {
    info: (m) => console.log(`${COLORS.cyan}[${ts()}] ℹ INFO${COLORS.reset}  ${m}`),
    success: (m) => console.log(`${COLORS.green}[${ts()}] ✔ OK${COLORS.reset}    ${m}`),
    warn: (m) => console.log(`${COLORS.yellow}[${ts()}] ⚠ AVISO${COLORS.reset} ${m}`),
    error: (m) => console.log(`${COLORS.red}[${ts()}] ✖ ERRO${COLORS.reset}  ${m}`),
    step: (m) => console.log(`${COLORS.blue}[${ts()}] ▶ PASSO${COLORS.reset} ${COLORS.bright}${m}${COLORS.reset}`),
    cron: (m) => console.log(`${COLORS.magenta}[${ts()}] ⏰ CRON${COLORS.reset}  ${m}`),
};
