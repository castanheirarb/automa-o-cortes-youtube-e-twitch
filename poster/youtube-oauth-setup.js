// poster/youtube-oauth-setup.js
// Setup manual de OAuth da YouTube Data API v3 — roda UMA VEZ por canal.
// Gera o refresh_token que o Comment Bot usa pra ler/responder comentários
// daquele canal específico (uma conta Google por canal).
//
// Uso: node poster/youtube-oauth-setup.js --channel main|fe|infantil
//
// Requer YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET já configurados no .env
// (compartilhados entre os 3 canais — ver .env.example). O client no Google
// Cloud Console PRECISA ser do tipo "App para computador" ("Desktop app"),
// não "Web application" — só esse tipo aceita qualquer redirect
// http://localhost:<porta> sem precisar cadastrar a porta exata antes.

import 'dotenv/config';
import http from 'node:http';
import { google } from 'googleapis';
import { COMMENT_BOT_CHANNELS, getChannelByKey } from '../src/comment-bot/channels.js';
import { resolveChannelId } from '../src/comment-bot/youtube-auth.js';
import { logger } from './logger.js';

const REDIRECT_PORT = parseInt(process.env.YOUTUBE_OAUTH_REDIRECT_PORT || '51739', 10);
const REDIRECT_URI = `http://localhost:${REDIRECT_PORT}/oauth2callback`;
const SCOPES = ['https://www.googleapis.com/auth/youtube.force-ssl'];

function parseChannelArg() {
    const args = process.argv.slice(2);
    const idx = args.indexOf('--channel');
    const key = idx !== -1 ? args[idx + 1] : null;
    const channel = key ? getChannelByKey(key) : null;

    if (!channel) {
        const valid = COMMENT_BOT_CHANNELS.map((c) => c.key).join(', ');
        console.error(`\x1b[31mUso: node poster/youtube-oauth-setup.js --channel <${valid}>\x1b[0m`);
        process.exit(1);
    }
    return channel;
}

/** Sobe um servidor HTTP local só pra capturar o `code` do redirect do OAuth. */
function waitForOAuthCode() {
    return new Promise((resolve, reject) => {
        const server = http.createServer((req, res) => {
            const url = new URL(req.url, `http://localhost:${REDIRECT_PORT}`);
            if (url.pathname !== '/oauth2callback') { res.writeHead(404); res.end(); return; }

            const code = url.searchParams.get('code');
            const error = url.searchParams.get('error');

            res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
            res.end(
                error
                    ? `<h2>Autenticação cancelada/negada (${error}).</h2><p>Pode fechar esta aba.</p>`
                    : `<h2>Autenticação concluída!</h2><p>Pode fechar esta aba e voltar ao terminal.</p>`
            );

            server.close();
            if (error) reject(new Error(`Autorização negada/cancelada: ${error}`));
            else if (code) resolve(code);
            else reject(new Error('Redirect sem "code" nem "error" — resposta inesperada do Google.'));
        });

        server.listen(REDIRECT_PORT, '127.0.0.1');
        server.on('error', reject);
    });
}

async function main() {
    const channel = parseChannelArg();

    console.log('\n\x1b[35m' + '═'.repeat(60) + '\x1b[0m');
    console.log(`\x1b[35m  🔐  YouTube OAuth Setup — ${channel.label}\x1b[0m`);
    console.log('\x1b[35m' + '═'.repeat(60) + '\x1b[0m\n');

    const clientId = process.env.YOUTUBE_CLIENT_ID?.trim();
    const clientSecret = process.env.YOUTUBE_CLIENT_SECRET?.trim();
    if (!clientId || !clientSecret) {
        logger.error(
            'YOUTUBE_CLIENT_ID/YOUTUBE_CLIENT_SECRET não configurados no .env.\n' +
            '  1. Google Cloud Console → habilite "YouTube Data API v3"\n' +
            '  2. Credenciais → Criar credenciais → ID do cliente OAuth → tipo "App para computador"\n' +
            '  3. Copie o Client ID/Secret pro .env (ver seção "YouTube Data API v3" no .env.example)'
        );
        process.exit(1);
    }

    const oauth2Client = new google.auth.OAuth2(clientId, clientSecret, REDIRECT_URI);
    const authUrl = oauth2Client.generateAuthUrl({
        access_type: 'offline', // necessário pra receber refresh_token
        prompt: 'consent',      // força tela de consentimento — garante um refresh_token novo mesmo se já autorizou antes
        scope: SCOPES,
    });

    logger.info(`Abra esta URL no navegador e faça login com a conta Google DESTE canal (${channel.label}):\n`);
    console.log(`\x1b[36m${authUrl}\x1b[0m\n`);
    logger.info('Aguardando autorização... (o script continua automaticamente após você autorizar)');

    let code;
    try {
        code = await waitForOAuthCode();
    } catch (err) {
        logger.error(`Falha na autorização: ${err.message}`);
        process.exit(1);
    }

    const { tokens } = await oauth2Client.getToken(code);
    if (!tokens.refresh_token) {
        logger.error(
            'Google não retornou um refresh_token. Isso acontece se esta conta já autorizou este app antes ' +
            'sem "prompt=consent" ter efeito — revogue o acesso em https://myaccount.google.com/permissions ' +
            'e rode este script de novo.'
        );
        process.exit(1);
    }

    oauth2Client.setCredentials(tokens);
    const youtubeClient = google.youtube({ version: 'v3', auth: oauth2Client });

    let sanityCheck = null;
    try {
        sanityCheck = await resolveChannelId(youtubeClient, `setup-${channel.key}`);
    } catch (err) {
        logger.warn(`Não consegui confirmar o canal autorizado (${err.message}) — confira manualmente antes de usar o token.`);
    }

    console.log('\n' + '─'.repeat(60));
    if (sanityCheck) {
        logger.success(`Autorizado: canal "${sanityCheck.title}" (${sanityCheck.id})`);
        logger.warn('Confira que é o canal CERTO antes de colar o token abaixo no .env!');
    }
    logger.success(`Cole isto no seu .env:\n`);
    console.log(`\x1b[32m${channel.refreshTokenEnv}=${tokens.refresh_token}\x1b[0m\n`);
    logger.warn('Esse valor é um segredo — nunca faça commit dele.');
    console.log('─'.repeat(60) + '\n');

    process.exit(0);
}

main().catch((err) => {
    console.error('Erro fatal:', err.message);
    process.exit(1);
});
