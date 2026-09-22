# RESTORE.md — Restaurar o CorteCerto034 numa máquina limpa

Guia escrito em 22/09/2026, antes de uma formatação planejada da máquina Windows onde o projeto
roda. Presume que você está numa sessão nova do Claude Code, sem nenhum contexto prévio desta
conversa — leia também o `CLAUDE.md` (arquitetura completa) antes ou depois deste arquivo.

**Este arquivo não contém nenhum segredo.** Toda credencial (`.env`, tokens, cookies, perfis de
navegador logados) precisa ser restaurada a partir do backup manual que o usuário fez antes de
formatar — ver a lista de "arquivos fora do git" que foi entregue a ele separadamente no chat (não
neste arquivo). Sem esse backup, cada credencial precisa ser gerada de novo do zero (processo
descrito nas seções de cada serviço abaixo).

## 1. Runtimes — versões confirmadas em uso (22/09/2026)

| Runtime | Versão confirmada nesta máquina | Onde |
|---|---|---|
| Node.js | v24.13.0 (declarado `>=18.0.0` no `package.json`, mas valide contra 24.x se algo quebrar) | `node --version` |
| npm | 11.6.2 (vem com o Node acima) | `npm --version` |
| Python (projeto principal / ASD) | 3.11.9 | `C:\Users\Gustavo\AppData\Local\Programs\Python\Python311\python.exe` |
| Python (subprojetos `canal_da_fe`/`canal_infantil`/`voice_isolation`) | mesma 3.11.x, cada um no seu próprio `venv/` | criado via `python -m venv` a partir do 3.11 acima |

⚠️ **Armadilha conhecida nesta máquina**: existe um Python 3.14.3 registrado só como stub da
Microsoft Store (`AppData\Local\Microsoft\WindowsApps\python3`) — **não é um interpretador real**,
não instale dependências nele. Sempre use o Python 3.11 baixado de python.org (ou equivalente numa
máquina nova) para criar os venvs.

Instale o Node 24.x (ou qualquer 18+, mas 24.x é o testado) e o Python 3.11.x antes de continuar.

## 2. Binários de sistema (fora do npm/pip)

Todos foram instalados via `winget` nesta máquina — os caminhos exatos no `.env` têm um sufixo de
versão/hash que **vai mudar** numa reinstalação nova, então rode os comandos abaixo e ajuste o
`.env` com o caminho real que aparecer depois:

```powershell
winget install Gyan.FFmpeg          # ffmpeg + ffprobe
winget install yt-dlp.yt-dlp        # yt-dlp
```

Depois de instalar, descubra os caminhos reais:

```powershell
(Get-Command ffmpeg).Source
(Get-Command ffprobe).Source
(Get-Command yt-dlp).Source
```

Cole esses caminhos em `FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH` no `.env` (ou deixe as variáveis
vazias/remova-as do `.env` se os binários já estiverem no PATH do sistema — o código cai pro nome
bare `ffmpeg`/`ffprobe`/`yt-dlp` nesse caso).

Outros binários:
- **Google Chrome** (instalação normal, não portátil) — todo o Playwright do projeto abre o Chrome
  REAL via `CHROME_PATH` (`C:\Program Files\Google\Chrome\Application\chrome.exe` de padrão), nunca
  o Chromium empacotado do Playwright. **Não é necessário rodar `npx playwright install`** —
  confirmado nesta sessão que nenhum script do projeto usa `firefox.launch`/`webkit.launch`, e todo
  `chromium.launch` do projeto passa `executablePath` explícito pro Chrome real. Se quiser evitar
  que o `npm install` baixe os browsers do Playwright à toa (algumas centenas de MB sem uso),
  defina `PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD=1` no ambiente antes do `npm install` — opcional, não
  quebra nada se pular esse passo.
- **biliup** (upload pro Bilibili — sem API pública, usa esse binário da comunidade): baixe o
  release em https://github.com/biliup/biliup/releases (não tem instalador via winget/npm) e
  aponte `BILIUP_PATH` no `.env` pro `.exe` baixado.

## 3. Instalação — ordem dos comandos

```powershell
# 1. Clonar o repositório
git clone https://github.com/castanheirarb/automa-o-cortes-youtube-e-twitch.git CorteCerto034
cd CorteCerto034

# 2. Dependências Node do projeto principal
npm install

# 3. Prisma (Agenda Esportiva / Sports Radar — único subsistema com banco de dados)
npx prisma generate
npm run db:push          # cria prisma/prisma/corte.db do zero (schema em prisma/schema.prisma)

# 4. Subprojeto Remotion (geração de vídeo do canal religioso por IA — canal_da_fe/video/)
cd canal_da_fe/video
npm install
cd ../..

# 5. Venv do subprojeto Canal da Fé (Python)
python -m venv canal_da_fe/venv
canal_da_fe/venv/Scripts/pip install -r canal_da_fe/requirements.txt

# 6. Venv do subprojeto Canal Infantil (Python)
python -m venv canal_infantil/venv
canal_infantil/venv/Scripts/pip install -r canal_infantil/requirements.txt

# 7. Venv do isolamento de voz (Demucs — pesado, PyTorch)
python -m venv voice_isolation/venv
voice_isolation/venv/Scripts/pip install demucs

# 8. Dependências Python do ASD (Active Speaker Detection) — SEM venv dedicado,
#    instala direto no Python do sistema (é o que PYTHON_PATH aponta por padrão)
pip install mediapipe opencv-python numpy

# 9. Copiar os templates de .env e preencher (ver seção 4 abaixo)
copy .env.example .env
copy canal_da_fe\.env.example canal_da_fe\.env   # se existir um template lá; senão criar do zero
copy canal_infantil\.env.example canal_infantil\.env
```

Confirme que o `.gitignore` continua cobrindo `node_modules/`, `venv/`, `.env`, `profiles/`,
`output/`, `*.db` antes de qualquer commit novo — não deveria precisar mexer, mas vale um `git
status` depois do passo 1 pra conferir que nada disso aparece como novo/sujo sem querer.

## 4. Variáveis de ambiente — nomes e propósito (SEM valores)

A fonte completa e sempre atualizada é `.env.example` (comentado seção por seção, em português,
já com instruções de onde conseguir cada chave). Resumo por categoria — **nunca copie um valor
real pra este arquivo nem para o `CLAUDE.md`**:

| Categoria | Variáveis (nomes) | Pra que serve |
|---|---|---|
| Banco de dados | `DATABASE_URL` | SQLite local da Agenda Esportiva |
| IA — geração de copy/visão | `GEMINI_API_KEY`, `GEMINI_MODEL`, `GROQ_API_KEY`, `GROQ_COPY_MODEL`, `GROQ_WHISPER_MODEL`, `OPENROUTER_API_KEY`, `OPENROUTER_VISION_MODEL` | Título/descrição/hashtags, transcrição, thumbnail |
| YouTube Data API (Comment Bot + Analytics) | `YOUTUBE_CLIENT_ID`, `YOUTUBE_CLIENT_SECRET`, `YOUTUBE_REFRESH_TOKEN_MAIN`, `_FE`, `_INFANTIL`, `_GTA6`, `YOUTUBE_OAUTH_REDIRECT_PORT` | OAuth por canal — regenerar via `node poster/youtube-oauth-setup.js --channel <chave>` (ver seção 6) |
| Comment Bot | `COMMENT_BOT_HOURS`, `COMMENT_BOT_INTERVAL`, `COMMENT_BOT_DRY_RUN`, `COMMENT_REPLY_DELAY_MIN_SEC`, `COMMENT_REPLY_DELAY_MAX_SEC`, `COMMENT_REPLY_MAX_PER_CYCLE`, `COMMENT_REPLY_MAX_PER_DAY` | Comportamento da resposta automática — `COMMENT_BOT_DRY_RUN` **deve começar `true`** |
| Interruptores de plataforma | `UPLOAD_TO_YOUTUBE`, `UPLOAD_TO_TIKTOK`, `UPLOAD_TO_INSTAGRAM`, `INSTAGRAM_MAX_HASHTAGS`, `*_MIN_INTERVAL_MIN` | Liga/desliga cada plataforma globalmente |
| Twitch | `TWITCH_CLIENT_ID`, `TWITCH_CLIENT_SECRET` | Captação de VODs/lives Twitch |
| TikTok | `TIKTOK_SESSION_ID`, `EULERSTREAM_API_KEY`, `TIKTOK_TT_TARGET_IDC`, `TIKTOK_LIVE_CAPTURE_MINUTES`, `TIKTOK_COOKIES_PATH`, `TIKTOK_BACKFILL_*` | Monitor de live + backfill |
| Bilibili | `BILIUP_PATH`, `BILIBILI_COOKIES_PATH`, `BILIBILI_*` (~15 variáveis) | Projeto isolado — ver `.env.example` linha por linha |
| OBS | `OBS_WS_URL`, `OBS_WS_PASSWORD`, `OBS_SCENE` | Espelhamento de tela opcional |
| Binários | `FFMPEG_PATH`, `FFPROBE_PATH`, `YTDLP_PATH` | Ver seção 2 |
| Processamento de vídeo | `CLIP_BUFFER_SECONDS`, `CLIP_DURATION_MAX/MIN`, `OUTPUT_DIR`, `ADD_CAPTIONS`, `LOOP_FADE`, `BLUR_BACKGROUND`, `SPLIT_SCREEN`, `HYBRID_PANEL_Y` | Layout/duração dos cortes |
| ASD | `USE_ASD`, `PYTHON_PATH` | Crop dinâmico por quem fala |
| Isolamento de voz | `DEMUCS_PATH`, `DEMUCS_MODEL`, `DEMUCS_SEGMENT_SECONDS`, `VOCAL_ISOLATION_TIMEOUT_SEC`, `VOCAL_ISOLATION_NICHES` | Mitigação de copyright de música de fundo |
| Varredura/monitores | `YOUTUBE_SCAN_DEPTH`, `TWITCH_SCAN_DEPTH`, `SCAN_INTERVAL_HOURS`, `YT_MONITOR_*`, `SPORTS_MONITOR_*` | Frequência de checagem de conteúdo novo |
| Vídeo longo diário (×4: principal/FE/Infantil/GTA6) | `LONG_VIDEO_*_ENABLED`, `CRON_VIDEO_LONGO_*`, `LONG_VIDEOS_*_DIR`, `LONG_VIDEO_*_MIN/MAX_DURATION` | Um vídeo longo por dia por canal |
| Rodízio ponderado (experimental) | `REVENUE_AWARE_ROTATION` + `REVENUE_*`, `SUBSCRIBER_AWARE_ROTATION` + `SUBSCRIBER_*` | Pesa personas por receita/inscritos — ambos hoje `false` |
| Agendamento | `POST_TIMES`, `POST_TIMEZONE`, `POSTS_PER_PERSONA` | Horários de post |
| Segurança de conteúdo | `CONTENT_FILTER`, `LLM_TEMPERATURE`, `LLM_MAX_TOKENS`, `MIN_VALIDATION_SCORE` | Filtro de profanidade + score mínimo |
| Canais dedicados no poster | `CANALDAFE_IN_ROTATION`, `CANALDAFE_WEIGHT`, `CANALDAFE_MIN_STOCK`, `CANALINFANTIL_IN_ROTATION`, `CANALINFANTIL_MIN_STOCK`, `CANALINFANTIL_PROFILE`, `TREND_IN_ROTATION` + `TREND_*`, `GTA6_IN_ROTATION` + `GTA6_*`/`TREND_GTA6_*` | Liga/pesa cada persona virtual |
| Sports Radar | `RADAR_KEYWORDS`, `RADAR_SPIKE_WINDOW_MS`, `RADAR_COOLDOWN_MS`, `RADAR_CLIP_*`, `RADAR_SHORT_*`, `RADAR_OUTPUT_DIR` | Corte por pico de chat/gol |
| Stock Watcher | `STOCK_CHECK_MINUTES`, `STOCK_MIN_*` | Reposição automática de conteúdo |
| Thumbnail/Optimizer | `CREATE_THUMBNAIL`, `OPTIMIZE_CONTENT` | Features de IA opcionais |

Além do `.env` raiz, existem **dois `.env` isolados** dos subprojetos Python
(`canal_da_fe/.env`, `canal_infantil/.env`) — chaves próprias (Replicate, etc.), não documentadas
aqui porque não fazem parte do `.env.example` principal; confira dentro de cada pasta ou nas
instruções de cada `requirements.txt`/código-fonte se precisar recriá-las do zero.

## 5. Perfis de navegador (Playwright) — login manual, não automatizável

Cada conta usa um perfil de navegador **persistente** e dedicado, criado 1x via login manual e
depois reaproveitado (a sessão fica salva no perfil, não em variável de ambiente). Sem o backup
desses perfis (ver lista entregue ao usuário no chat), refaça o login em cada um:

```powershell
# Contas principais (perfis: chrome-youtube, chrome-tiktok, chrome-instagram)
node poster/login.js

# Contas dedicadas extras (--platform youtube|tiktok, --profile <caminho>)
node poster/login.js --platform youtube --profile ./profiles/chrome-youtube-02   # A Fé Move Montanhas
node poster/login.js --platform tiktok   --profile ./profiles/chrome-tiktok-02
node poster/login.js --platform youtube --profile ./profiles/chrome-youtube-03   # Canal Infantil
node poster/login.js --platform youtube --profile ./profiles/chrome-youtube-04   # GTA VI
node poster/login.js --platform tiktok   --profile ./profiles/chrome-tiktok-04

# Bilibili (QR code no app, não dá pra automatizar)
npm run bilibili:login          # conta principal
npm run bilibili:login-global   # conta global, se aplicável
```

Depois de logar cada perfil extra, confira que ele está registrado no lugar certo do código
(`src/capturer/personas.js` pros canais dedicados, `poster/accounts.js` pra contas extra de
replicação de futebol) — o caminho do perfil sozinho não basta, o código precisa apontar pra ele.

## 6. YouTube Data API — reautorizar do zero (Comment Bot + Analytics)

1. Google Cloud Console → criar/selecionar projeto → habilitar **YouTube Data API v3**.
2. Credenciais → Criar credenciais → ID do cliente OAuth → tipo **"App para computador"** (não
   "Web application" — só esse tipo aceita qualquer `redirect_uri` `localhost:<porta>`).
3. Copie Client ID/Secret pro `.env` (`YOUTUBE_CLIENT_ID`/`YOUTUBE_CLIENT_SECRET`).
4. **Tela de consentimento OAuth**: se o app ficar em modo "Testing" (comum, evita processo de
   verificação do Google), cada conta Google que for autorizar precisa estar cadastrada em
   "Test users" ANTES de tentar — senão a autorização é bloqueada com "Access blocked: app not
   verified". **Além disso, nesse modo os refresh tokens expiram sozinhos em ~7 dias** — foi a
   causa de os 4 tokens ficarem `invalid_grant` ao mesmo tempo na sessão de 19-20/09/2026. Se
   quiser parar de reautorizar toda semana, considere publicar o app pra produção (pode exigir
   revisão do Google pelos escopos de Analytics, que são "restritos").
5. Gere um refresh token por canal:
   ```
   node poster/youtube-oauth-setup.js --channel main
   node poster/youtube-oauth-setup.js --channel fe
   node poster/youtube-oauth-setup.js --channel infantil
   node poster/youtube-oauth-setup.js --channel gta6
   ```
   Cada comando abre um link — abra no navegador **logado com a conta Google certa daquele canal**
   (confira o nome do canal confirmado no final antes de colar o token no `.env` — já aconteceu de
   autorizar a conta errada sem perceber).

## 7. Como testar que voltou a funcionar

Rode nesta ordem, cada um deve terminar sem erro antes de ir pro próximo:

```powershell
# 1. Sintaxe/dependências básicas
node --check start.js
node --check poster/index.js

# 2. Ferramentas locais (não precisam de credencial)
node poster/metadata.js                 # self-test de geração de copy (precisa GEMINI/GROQ key)

# 3. Sessões de navegador — confirma que os perfis logaram de verdade
#    (abre o Studio/creator-center REAL, não só checa cookie salvo)
#    Não tem comando standalone pronto — session-check.js é chamado automaticamente
#    dentro de `npm run poster`, ou importe validateAllSessions() num script rápido.

# 4. Comment Bot — SEMPRE em dry-run primeiro
npm run comment-bot:once

# 5. Banco de dados
npm run db:studio                       # abre a Agenda Esportiva no navegador

# 6. Bilibili (se for usar)
npm run bilibili:dry                    # simula um ciclo sem publicar

# 7. Isolamento de voz (Demucs) — testa com um .mp4 qualquer de output/
node -e "import('./src/processor/vocal-isolate.js').then(m => m.isolateVocals('./output/<algum-arquivo>.mp4'))"

# 8. Dry-run completo do poster (não publica nada de verdade)
npm run poster:dry

# 9. Só depois de 1-8 passarem: orquestração completa
npm run start
```

Se `npm run start` subir sem erros nos primeiros ~30s de log (banner de cada serviço aparecendo:
Poster, Scanner, Trend Hunter, Stock Watcher, Comment Bot, Audience Panel) e o `session-check`
mostrar todos os canais ativos com ✅, a restauração está completa.

## 8. Ordem de prioridade sugerida (se não quiser restaurar tudo de uma vez)

1. `.env` + Node + `npm install` + login do canal principal (YouTube/TikTok) — já dá pra rodar o
   canal principal sozinho.
2. Login dos perfis dedicados (A Fé Move Montanhas, Canal Infantil, GTA VI) conforme for
   religando cada um.
3. Prisma/Sports Radar — só se for usar a Agenda Esportiva.
4. Demucs (`voice_isolation/venv`) — só necessário pro vídeo longo do A Fé Move Montanhas.
5. `canal_da_fe/venv` + Remotion — só se for reativar a geração por IA (hoje desligada,
   `CANALDAFE_IN_ROTATION` já `true` no `.env.example` mas o pipeline real depende do venv
   existir).
6. `canal_infantil/venv` — só se for reativar a geração por IA infantil (hoje desligada de
   propósito).
7. Bilibili — subsistema totalmente isolado, pode ficar por último.
