// src/utils/logger.js
// Logger colorido simples para console

const COLORS = {
  reset: '\x1b[0m',
  bright: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function timestamp() {
  return new Date().toLocaleTimeString('pt-BR');
}

export const logger = {
  info: (msg) =>
    console.log(`${COLORS.cyan}[${timestamp()}] ℹ INFO${COLORS.reset}  ${msg}`),
  success: (msg) =>
    console.log(`${COLORS.green}[${timestamp()}] ✔ OK${COLORS.reset}    ${msg}`),
  warn: (msg) =>
    console.log(`${COLORS.yellow}[${timestamp()}] ⚠ AVISO${COLORS.reset} ${msg}`),
  error: (msg) =>
    console.log(`${COLORS.red}[${timestamp()}] ✖ ERRO${COLORS.reset}  ${msg}`),
  step: (msg) =>
    console.log(`${COLORS.blue}[${timestamp()}] ▶ PASSO${COLORS.reset} ${COLORS.bright}${msg}${COLORS.reset}`),
};
