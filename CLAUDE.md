# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## O que é este projeto

Automação completa de vários canais do YouTube (+ TikTok, + Bilibili) rodando na máquina Windows do
usuário (processos `node` de longa duração, sem deploy em nuvem):

1. **Canal principal** ("Corte Certo 034") — cortes de lives/VODs de 6 "personas" (streamers/criadores
   de YouTube e Twitch), escolhidos automaticamente pelo momento de maior audiência (heatmap/chat).
2. **A Fé Move Montanhas** — canal religioso dedicado, nome atual (o canal original, "Canal da Fé",
   morreu de strikes de copyright — ver memória `project_canal_da_fe_copyright_strike`; "Canal da
   Fé"/`FE` sobrevive só como slug técnico interno: pastas `canal_da_fe/`, `src/canal-da-fe/`, env
   vars `LONG_VIDEO_FE_*`, persona `bispobrunoleonardo` — não é o nome do canal, não use como tal).
   Shorts: cortes do próprio Bispo Bruno Leonardo, já com volume real de inscritos e views. Vídeo
   longo diário: reativado em 19/09/2026 com fonte NOVA — não mais o canal do Bispo (que gerou o
   strike original), e sim lives de oração de canais terceiros (`PRAYER_LIVE_CHANNELS` em
   `src/canal-da-fe/long-video.js`, base de permissão = interpretação de fair use, não autorização
   por escrito — risco residual real). Também existe pipeline de geração por IA (roteiro + FLUX +
   narração + Remotion, Python em `canal_da_fe/`), ainda não ativado.
3. **Canal Infantil** — Shorts educativos infantis: cortes do Luccas Neto + vídeos gerados por IA
   (roteiro Groq + Pexels + Edge-TTS + FFmpeg, pipeline Python em `canal_infantil/`). Cortes ativos
   desde 19/09/2026 (conta `ferfertanus@hotmail.com`, suspensa em 07/09, teve o acesso confirmado de
   volta via `poster/session-check.js`). Vídeo longo diário próprio (`src/canal-infantil/long-video.js`,
   mesmo padrão do Canal da Fé mas sem isolamento de voz — não se aplica ao conteúdo do Luccas Neto)
   baixa um vídeo INTEIRO do canal oficial dele pra `output/longos-infantil`. Geração por IA (roteiro
   próprio) segue desligada de propósito (`CANALINFANTIL_IN_ROTATION=false` no `.env`) — reative
   ligando a flag quando decidirem retomar esse lado também.
4. **GTA VI (FOCONOGTAVI)** — 4º canal dedicado (perfis `chrome-youtube-04`/`chrome-tiktok-04`),
   pré-lançamento do jogo (sai 19/11/2026): sem persona normal (ninguém joga ao vivo ainda), usa um
   Trend Hunter próprio (`src/trend-hunter/gta6-capture.js`) que vasculha canais BR de
   análise/reação e corta o vídeo em alta. Teve 2 suspensões (04/09 revertida, boicote/denúncias em
   massa 17/09 reativado 19/09 por decisão consciente do usuário mesmo sem confirmação de que o
   boicote esfriou — ver `project_gta6_youtube_suspended` em memória). Comment Bot desse canal foi
   **removido** (`src/comment-bot/channels.js`) — a API de Dados retorna "account suspended" de
   forma persistente só pra esse canal, mesmo com upload via Playwright funcionando normal.
5. **Bilibili** (`bilibili/`, projeto isolado) — canal mainland chinês, nunca entra no rodízio dos
   canais acima. Upload via `biliup` (binário externo, autenticação por cookies), não Playwright —
   Bilibili não tem API de upload pública utilizável. Clipa conteúdo viral chinês
   (`bilibili/sources.js`) + repost automático dos cortes do canal principal e do A Fé Move
   Montanhas + teste de conteúdo BR (`BILIBILI_BR_EXPERIMENT_RATE`). Agendamento próprio
   (`npm run bilibili:schedule`, 4x/dia), painel de audiência (`npm run bilibili:stats`).

**Subsistemas auxiliares** (não são canais, servem os de cima): **Agenda Esportiva / Sports Radar**
(`src/capturer/sports-radar.js` + Watchdog, único ponto do projeto com banco de dados — Prisma/SQLite
em `prisma/prisma/corte.db` — agenda jogos e minera VOD por pico de chat/gol); **Instagram**
(`poster/uploaders/instagram.js`, Reels via Playwright) — pausado desde 15/09/2026 (8/8 tentativas
automatizadas falharam, humanização adicionada depois, decisão de re-testar ainda pendente,
`UPLOAD_TO_INSTAGRAM=false`); **OBS mirror** (`src/obs/`, `npm run obs:*`) — espelha a tela via
OBS WebSocket pra uso em live, não afeta o pipeline de postagem.

Cada canal publica sozinho, em horários fixos (cron), sem aprovação manual — geração de
título/descrição/hashtags via IA (Gemini primário, Groq fallback), upload via Playwright
(YouTube/TikTok não têm API pública de upload utilizável aqui) e, para o YouTube, resposta
automática a comentários via API oficial (`googleapis`).

### Escopo "pessoal" vs projetos de cliente

O usuário roda, na mesma máquina, este projeto (**CorteCerto034** — todos os canais acima, incluindo
GTA VI e Bilibili) lado a lado com projetos profissionais/de cliente isolados em outras pastas
(`uNuts`, `livro-sagrado-br`). Ele se refere a este projeto inteiro como **"pessoal"** ou **"escopo
pessoal"**. São contextos de risco/prioridade diferentes (bugs aqui afetam só o usuário; bugs nos
projetos de cliente afetam entrega pra terceiros) — não misturar credenciais, config ou decisões
entre eles.

## Comandos comuns

```bash
# Orquestração completa (todos os serviços em paralelo — produção)
npm run start              # == npm run poster (start.js: poster + monitores + scanner + hunter)
npm run start:no-live      # sem monitor de lives Twitch
npm run start:no-poster    # sem auto-poster

# Captação de clipes (sem postar)
npm run capture            # todas as personas
node src/orchestrator.js <nome-da-persona>   # uma persona específica (ver src/capturer/personas.js)
npm run capture:force      # força re-captação

# Auto-poster (upload)
npm run poster:solo        # só o poster, com cron ativo (sem os monitores)
npm run poster:now         # ⚠️ dispara upload REAL imediatamente e encerra (não é dry-run)
npm run poster:dry         # simula um post sem publicar — sempre preferir isto para testar
npm run poster:longo       # posta o vídeo longo do dia (conta principal) agora
npm run poster:longo:fe    # idem, Canal da Fé
npm run poster:tiktok / poster:youtube   # --now restrito a uma plataforma
npm run poster:login       # login manual do Playwright num perfil de navegador (1x por conta)

# Comment Bot (resposta automática a comentários do YouTube)
npm run comment-bot:once   # 1 ciclo de teste, dry-run (não publica) — usar sempre antes de mudar algo
npm run comment-bot:dry    # loop contínuo, dry-run
npm run comment-bot        # loop contínuo, publica de verdade (respeita COMMENT_BOT_DRY_RUN do .env)
npm run youtube:oauth-setup -- --channel main|fe|infantil   # gera/renova o refresh token de um canal

# Monitores individuais (loops contínuos — normalmente já sobem via start.js)
npm run live                       # monitor de lives Twitch
node src/orchestrator.js --youtube-monitor
node src/orchestrator.js --sports-monitor

# Agenda esportiva (Prisma/SQLite)
npm run db:push             # aplica schema.prisma
npm run db:studio           # explorar o banco
npm run radar:add -- "@CazeTV" youtube "2025-06-20 21:00" 4

# Estoque
npm run stock                # roda uma vez o Stock Watcher (repõe conteúdo abaixo do mínimo)
```

Não há framework de testes automatizados (sem Jest/Vitest/etc). A convenção do projeto é
"self-test" via CLI direto no próprio módulo (ex.: `node poster/metadata.js`,
`node src/comment-bot/gender.js "Maria Silva" ...`) e validação com dados reais — rode o comando
relevante e leia a saída, não invente um test runner novo.

## Arquitetura

### Fluxo de dados (ponta a ponta)

```
personas.js ──► capturer.js ──► output/<persona>/*.mp4 ──► poster/index.js (round-robin)
                                                                    │
                                        gera metadados (IA) ◄───────┤
                                        valida (metadata-validator) │
                                        upload YouTube (Playwright) │
                                        upload TikTok (Playwright)  │
                                                                    ▼
                                                            postados/ + registries
```

- **Captação** (`src/capturer/`, `src/platforms/`, `src/processor/`): baixa/corta vídeo, decide o
  pico de audiência, aplica crop 9:16 (ou layout `hybrid`/`blur`/`split`), legendas com highlight de
  palavra sincronizado (`processor/captions.js`, formato ASS/karaoke via libass), detecção de quem
  fala (`processor/face-detect.js` + `processor/active_speaker.py`, MediaPipe). Grava em
  `output/<nome-da-persona>/`.
- **Postagem** (`poster/`): lê `output/`, escolhe o próximo vídeo pelo algoritmo de round-robin,
  gera título/descrição/hashtags com IA, valida conteúdo, sobe via Playwright, move para `postados/`.
- **Comment Bot** (`src/comment-bot/` + `poster/comment-*.js`): via `googleapis` (não Playwright),
  responde comentários novos nos 3 canais.
- **Pipelines Python separados** (`canal_da_fe/`, `canal_infantil/`): geram vídeo 100% por IA sob
  demanda quando chamados por `src/canal-da-fe/generate.js` / `src/canal-infantil/generate.js`, que
  invocam o `python` do respectivo `venv/`. Cada um tem seu próprio `.env` isolado dentro da pasta.

### `personas.js` é a fonte de verdade do roteamento

`src/capturer/personas.js` define cada fonte de conteúdo (`name`, `platform`, `channelUrl`, `niche`,
pesos de rodízio) — **toda** a lógica de captação e postagem itera sobre essa lista. Campos que
alteram o comportamento global:
- `niche` → seleciona o banco de fórmulas virais de `poster/metadata.js` e o estilo de legenda de
  `processor/captions.js` (cor/tamanho por nicho).
- `weight` (Shorts) / `longWeight` (vídeo longo) → peso no rodízio (`buildRotation` em
  `src/scheduler/round-robin.js`, espaçamento fracionário para intercalar bem mesmo com pesos
  desiguais).
- `youtubeProfileDir` / `tiktokProfileDir` → roteia a persona para um perfil de navegador Playwright
  **dedicado** em vez da conta principal (é assim que Bispo Bruno Leonardo → Canal da Fé e Luccas
  Neto → Canal Infantil nunca vazam para a conta principal). Perfis criados 1x via `poster/login.js`.
- `madeForKids` → declaração COPPA obrigatória no upload (Canal Infantil).
- `layout` → sobrepõe o crop padrão (`asd` dinâmico por padrão; `hybrid`/`blur`/`split`/`auto` para
  fontes com gameplay).

### Round-robin do poster (`poster/index.js` + `src/scheduler/round-robin.js`)

Não é um post por persona em sequência simples — é um sistema de camadas, avaliado nesta ordem a
cada slot de cron:
1. **Turno de futebol intercalado** — a cada lote de `POSTS_PER_PERSONA` (padrão 3) vídeos de
   qualquer persona, força um corte de futebol (Casimiro/CazéTV, com fallback ao Trend Hunter de
   futebol) antes de liberar a próxima persona.
2. **Trend Hunter** — se for o turno dele e a pasta estiver vazia, captura na hora um corte em alta
   dos concorrentes.
3. **Hotness** (`src/scheduler/hotness.js`) — se alguma persona estiver "estourando" no canal-fonte
   (score acima do threshold) E tiver clipes prontos, ela fura a fila do rodízio normal. Limitado por
   `canPersonaPostAgain` para não repetir a mesma persona indefinidamente.
4. **Round-robin normal com fallback de 3 níveis** — persona do turno → outras personas com pasta
   não-vazia → re-captação de emergência se tudo estiver vazio.

Estado persiste em JSON (`scheduler/queue-state.json` para a fila principal;
`scheduler/religioso-state.json` / `infantil-state.json` para os canais dedicados, que rodam em
**todos** os slots de cron, não apenas no rodízio principal — ver `DEDICATED_CHANNELS` em
`poster/index.js`). O vídeo longo diário (1x/dia por canal, `output/longos` e `output/longos-fe`)
tem seu próprio ciclo cron independente (`runLongVideoCycle`).

### Rodízio ponderado por receita (`src/scheduler/revenue-weight.js`)

Camada opcional (`REVENUE_AWARE_ROTATION=true`, default `false`) que ajusta o `weight` efetivo das
personas da conta principal com base na receita real por vídeo, não só em audiência — o Hotness
(acima) mede se um canal-fonte está bombando, isto mede se compensa financeiramente. Só cobre a
conta principal nesta v1 (os canais dedicados religioso/infantil ficam de fora).

O desafio central é atribuição: as 6 personas da conta principal postam no MESMO canal do YouTube, e
o upload via Playwright (`poster/uploaders/youtube.js`) nunca retorna o `videoId` do vídeo publicado.
A ponte é por **título**: `poster/metadata-validator.js` grava `persona`/`niche`/`titulo` em
`postados/metadata-history.json` a cada post (`recordMetadataHistory`), e
`src/analytics/attribution.js` casa isso com os uploads reais do canal (YouTube Data API,
`playlistItems.list` na playlist de uploads) por título exato — vídeo sem match (renomeado
manualmente, por exemplo) fica só sem dado de receita, sem quebrar nada. Com o `videoId` resolvido,
`src/analytics/youtube-analytics.js` consulta a YouTube Analytics API v2 (`estimatedRevenue`, `views`,
etc.) por vídeo, e `revenue-weight.js` agrega por persona, cacheia em disco
(`scheduler/revenue-cache.json`, TTL 24h) e converte em multiplicador de peso (relativo à mediana
entre personas com amostra suficiente — `REVENUE_MIN_SAMPLE`).

Requer os refresh tokens (`YOUTUBE_REFRESH_TOKEN_MAIN`/`_FE`, ver Comment Bot abaixo) autorizados com
os escopos `yt-analytics.readonly` + `yt-analytics-monetary.readonly` (adicionados em
`poster/youtube-oauth-setup.js` — tokens gerados antes dessa mudança precisam ser regerados). Sem
esses escopos, sem monetização ativa (YPP) no canal, ou com a flag desligada, todo o caminho cai
silenciosamente para os pesos declarados em `personas.js` (nunca lança, nunca trava o rodízio) — ver
`getRevenueAdjustedPersonas()`. Inspecione os números antes de ativar: `npm run revenue`.

### Rodízio ponderado por inscritos — TESTE (`src/scheduler/subscriber-weight.js`)

Mesma mecânica do Revenue-Aware Rotation, mas pesando `subscribersGained/vídeo` (métrica não-monetária)
em vez de receita — funciona hoje, sem esperar YPP. Ativado em 2026-08-23 como **teste explícito** (não
uma decisão definitiva) pra ver se enviesar o rodízio por conversão de inscrito bate os pesos
declarados, já que inscritos é o gargalo confirmado do YPP nos 2 canais ativos. Flag
`SUBSCRIBER_AWARE_ROTATION`, cache `scheduler/subscriber-cache.json`, `npm run subscribers` pra
inspecionar. Encadeado com o Revenue-Aware Rotation em `runUploadCycle()` — os dois multiplicam o peso
independentemente quando ambos ativos.

Cada post grava, em `postados/metadata-history.json`, qual combinação de flags estava ativa no momento
(`rotationMode`: `'baseline'` | `'subscriber'` | `'revenue'` | `'revenue+subscriber'` — ver
`getActiveRotationMode()` em `poster/index.js`). **`npm run compare-rotation`** agrega o resultado real
(inscritos/views/receita por vídeo) por esse rótulo — é uma comparação observacional por período
(antes/depois), não A/B controlado, e só é confiável com amostra grande (10+ vídeos por modo).

### Painel de elegibilidade YPP (`src/scheduler/eligibility.js`)

`npm run eligibility` — mostra, por canal, a distância até os requisitos do YouTube Partner Program
(1.000 inscritos + 4.000h de watch time em 12 meses OU 10M views em Shorts em 90 dias) e qual dos dois
caminhos está mais perto. Ao contrário do Revenue-Aware Rotation acima (que só serve depois da
monetização), este painel é útil **antes** — é o que orienta se vale mais focar em vídeo longo ou
Shorts em cada canal. Inscritos não precisa de escopo novo (já funciona com o token atual do Comment
Bot); watch hours e views de Shorts precisam de `yt-analytics.readonly` (mesma reautorização do
Revenue-Aware Rotation — reautorizar uma vez resolve os dois painéis de uma vez).

`npm run audience` (`src/scheduler/audience-recent.js`) é um painel mais leve e independente: views/
likes/comentários só dos ÚLTIMOS 3 vídeos publicados por canal, via YouTube Data API v3
(`videos.list`), sem depender da Analytics API (desabilitada no projeto GCP atual). Roda também como
serviço contínuo do `start.js` (`AUDIENCE_CHECK_HOURS`, padrão 3h) — custo de cota irrisório (~12
unidades/rodada pros 4 canais).

### Padrão "registra antes de tentar" (anti-duplicata em caso de crash)

Em todo lugar que publica algo irreversível — `poster/queue.js` (registries por plataforma:
`postados/registry.json`, `tiktok-registry.json`, `youtube-registry.json`), o estado de vídeo longo
(`postados/long-video-state.json`), o Comment Bot (`src/comment-bot/history.js`) — o registro é
gravado em disco **antes** da tentativa de upload/publicação, não depois. Isso evita reposts em caso
de crash no meio do upload, mas tem uma armadilha conhecida: se o upload falhar de verdade (não
crashar, só falhar), a entrada falso-positiva bloqueia retentativas legítimas até que alguém remova a
chave manualmente do registry (`registryKey()` = caminho relativo a `OUTPUT_DIR`, ex.:
`longos-fe/ARQUIVO.mp4`). Isso já causou 2 incidentes reais de vídeos legítimos ficando presos — ao
depurar "vídeo não postou", sempre checar os registries relevantes antes de assumir outra causa.

### Lock de upload cross-processo (`poster/upload-lock.js`)

O Poster, o Sports Radar e os canais dedicados rodam como processos Node distintos mas todos abrem o
mesmo tipo de sessão Playwright — `acquireUploadLock(label)` serializa via arquivo
(`scheduler/upload.lock`) com PID + heartbeat, não uma trava em memória (que não seria visível entre
processos). Também existe uma trava de instância única do `start.js` inteiro
(`scheduler/start.lock`) para impedir 2 swarms completos rodando ao mesmo tempo.

### Comment Bot (`src/comment-bot/`, `poster/comment-*.js`, `poster/youtube-oauth-setup.js`)

Usa a YouTube Data API v3 diretamente (`googleapis`), não Playwright — é o único caminho do projeto
que não depende de perfil de navegador. Canais atendidos: `main`/`fe`/`infantil`
(`src/comment-bot/channels.js`) — **GTA VI foi removido** dessa lista em 19/09/2026 porque a API de
Dados retorna "account suspended" de forma persistente só pra esse canal (upload via Playwright não
é afetado, só a resposta automática de comentário; reavaliar se o Google liberar de novo). Cada
canal tem seu próprio refresh token OAuth (`YOUTUBE_REFRESH_TOKEN_MAIN/_FE/_INFANTIL`, client
id/secret compartilhados), gerado via `poster/youtube-oauth-setup.js --channel <main|fe|infantil>`
— **não é "gerado 1x e esquece"**: se o projeto OAuth no Google Cloud Console estiver em modo
"Testing" (não publicado), os refresh tokens expiram sozinhos em ~7 dias mesmo sem revogação manual
(achado nesta sessão: os 4 tokens — incluindo o do GTA VI, então em uso — estavam `invalid_grant` ao
mesmo tempo). Nesse modo, cada conta Google usada também precisa estar na lista de "Test users" da
tela de consentimento OAuth do projeto, senão a autorização é bloqueada antes mesmo de gerar o
token. Ver `RESTORE.md` pra reautorizar os 3 canais do zero numa máquina nova. Portão de segurança
nos dois sentidos
(`poster/comment-safety.js`): classifica o comentário recebido (spam, crise, pedido de dados
pessoais) antes de responder, e a resposta gerada antes de publicar. Inferência de gênero pelo nome
(`src/comment-bot/gender.js`) via API do Censo do IBGE, com fallback neutro quando a confiança é
baixa — nunca menciona a inferência ao usuário. Roda 1 passada/dia por padrão
(`COMMENT_BOT_HOURS=24` em `start.js`), não polling contínuo. **`COMMENT_BOT_DRY_RUN` deve
permanecer `true` até um teste manual explícito confirmar o tom da resposta** — sempre validar com
`comment-bot:once` antes de mudar o prompt de voz de um canal.

### Monitor de live do TikTok (`src/capturer/live-monitor-tiktok.js`, `src/platforms/tiktok-peaks.js`)

Orientado a evento via WebSocket (`tiktok-live-connector`), não polling — assim que a sala entra "ao
vivo" a captação já dispara. A mesma conexão que detecta o status recebe chat e gifts em tempo real;
`tiktok-peaks.js` prioriza os clipes nas janelas de maior engajamento durante a gravação (gifts pesam
mais que chat — é dinheiro de verdade, sinal de hype mais confiável que volume de mensagem). Sem
chat/gift no período (sala silenciosa, live pequena), cai pra distribuição uniforme automaticamente.
Personas TikTok não têm VOD arquivado — enquanto a live não acontece de novo,
`src/trend-hunter/tiktok-persona-scout.js` faz backfill buscando no YouTube lives BRUTAS/completas
que outros canais já re-hospedaram (ex.: Royal Clipes) e corta com o pipeline normal; nunca reaproveita
um corte que outro canal já editou (filtro de duração mínima descarta clipes curtos de 60-100s de
terceiros, só sobra live bruta/recap longo).

### Segurança e confiabilidade de upload

Camada adicionada em 2026-09-15 depois de um incidente real: 8 uploads automáticos do Instagram numa
conta nova, em rajada de ~40min, travaram todos na tela "Compartilhando" (0 publicados) — suspeita é
que digitação/clique com timing perfeito soma sinais de automação, e rajada de posts é o padrão mais
óbvio de bot pra detecção de conta nova.
- `poster/human-behavior.js` — digitação e cliques humanizados (via `ghost-cursor-playwright`),
  compartilhado pelos 3 uploaders (YouTube/TikTok/Instagram). Não resolve rate-limit de verdade (conta
  já sinalizada continua sinalizada), só evita adicionar sinais óbvios de bot.
- `poster/upload-pacing.js` — intervalo mínimo forçado entre posts REAIS por plataforma,
  independente do cron (`INSTAGRAM_MIN_INTERVAL_MIN` etc. no `.env`) — evita rajada mesmo quando
  vários slots de cron caem perto um do outro (round-robin pulando de persona em persona rápido).
- `poster/session-check.js` — validação de sessão ponta a ponta de cada conta ativa, rodada sempre
  ANTES do cron do poster começar. Abre o perfil de verdade via Playwright e navega até o
  Studio/Creator Center (mesma URL que o upload real usa) pra pegar sessão expirada, MFA pendente ou
  conta suspensa antes do primeiro horário agendado tentar postar. Nunca lança — conta com sessão
  inválida só gera aviso no log, as outras seguem normalmente.
- `src/utils/gemini-quota-guard.js` — circuit breaker compartilhado pra cota diária do Gemini free
  tier (20 req/dia/modelo). Sem isso, cada chamador (`metadata.js`, `content-optimizer`,
  `face-detect.js`, `thumbnail.js`) descobria a cota estourada por conta própria, gastando round-trip +
  retry do 429 em cada post pelo resto do dia (visto em produção em 06/09/2026). Uma vez que qualquer
  chamador detecta o 429, todos pulam Gemini direto pro fallback (Groq/frame simples) por 24h de
  cooldown fixo a partir da primeira detecção.

### Geração de metadados e legendas

- `poster/metadata.js` — Gemini (`GEMINI_MODEL`) primário, Groq (`GROQ_COPY_MODEL`) como fallback em
  qualquer falha. Fórmulas virais por `niche` (`VIRAL_FORMULAS`), anti-repetição de hashtags (injeta
  os últimos hashtags usados no MESMO nicho no prompt, via `poster/metadata-validator.js`).
- `poster/metadata-validator.js` — valida título/descrição/hashtags contra regras do YouTube/TikTok
  (CAPS, tamanho, etc.) antes de qualquer upload; score mínimo configurável
  (`MIN_VALIDATION_SCORE`) barra posts de baixa qualidade.
- `src/processor/captions.js` — legendas ASS com highlight de palavra sincronizado (karaoke), estilo
  (cor/tamanho) por `niche`, margem por `layout`. Transcrição via Groq Whisper com granularidade de
  palavra. **Alucinação do Whisper em áudio sem fala clara** (crowd noise de transmissão esportiva,
  sem narração) é um risco conhecido — o Whisper já foi visto inventando frases inteiras
  ("A CIDADE NO BRASIL", créditos de legendagem fictícios) com timestamps de palavra absurdos (uma
  "palavra" de 8s), o que travava a legenda queimada por todo o clipe. Mitigado em duas camadas:
  `filterReliableWords()` descarta palavras com duração individual implausível (>2s) antes de
  agrupar em linhas, e `buildAssFromWords`/`buildAssFromSegments` limitam a duração máxima de
  qualquer linha renderizada (6s/12s) como rede de segurança — mesmo que sobre algum timestamp
  contaminado, a legenda nunca mais fica "grudada" na tela. `no_speech_prob`/`avg_logprob` do Whisper
  NÃO detectam esse caso (a API retorna confiança alta mesmo alucinando) — a defesa real é a duração.
- Vídeos 100% gerados (Canal da Fé, Canal Infantil) já vêm com metadados prontos num sidecar
  `<video>.meta.json` — o poster usa esse sidecar em vez de gerar por transcrição.

### Chamadas a LLM (Groq): `reasoning_effort` é obrigatório

Todo lugar que chama a Groq API (`metadata.js`, `smart-boundary.js`, `comment-reply.js`) usa
`reasoning_effort: 'low'` no payload. Sem isso, o modelo (`openai/gpt-oss-120b`) consome centenas de
tokens de raciocínio oculto antes de emitir o JSON de saída, estourando `max_tokens` e causando
`json_validate_failed` com `failed_generation` vazio — já foi a causa raiz de falhas de fallback em
produção. Ao adicionar uma nova chamada Groq, sempre incluir `reasoning_effort: 'low'` e deixar
margem generosa de `max_tokens` (não o mínimo teórico do JSON esperado).

### Isolamento de voz (`src/processor/vocal-isolate.js`) — mitigação de copyright strike

Separação de fontes de áudio via Demucs (`--two-stems=vocals`), aplicada automaticamente a todo
conteúdo do nicho `religioso` (cortes em `processClip`/ffmpeg.js e o vídeo longo em
`src/canal-da-fe/long-video.js`) — mitigação técnica pro copyright strike de 2026-08-24 (Soares
Music Digital): lives de oração têm música de fundo ambiente que o Content ID reconhece mesmo sob a
voz. Requer um venv Python **dedicado** (`voice_isolation/venv/`, PyTorch — não reaproveita o venv
do MediaPipe/ASD) com `DEMUCS_PATH` apontando pro executável. Sem isso configurado, ou se o processo
falhar/estourar o timeout, cai de volta pro áudio original sem isolar, nunca quebra o pipeline.
**Redução de risco, não garantia** — Content ID pode ainda pegar resíduo.

`--segment` é sempre passado ao Demucs (`DEMUCS_SEGMENT_SECONDS`, default 7 — **não pode passar de
7.8**, teto do próprio modelo `htdemucs`, que é um Transformer com contexto de treino fixo; valores
maiores derrubam com "Cannot use a Transformer model with a longer segment than it was trained
for"). Adicionado em 19/09/2026 depois de um vídeo de 112min pedir ~9,4GB e estourar memória sem
segmentação — processar em blocos menores mantém o pico de memória limitado independente da duração
do arquivo. Mesmo assim, **a máquina precisa ter RAM livre de verdade** — nessa sessão, com o
sistema rodando só ~459MB livres de 16GB (várias outras apps abertas ao mesmo tempo: TikTok LIVE
Studio, TikFinity, Chrome com muitas abas, outro agente de IA — ver seção de snapshot no fim deste
arquivo), a isolação falhou mesmo segmentada (pediu só ~1,18GB e não coube). Se um vídeo longo
publicar sem a mitigação aplicada, checar RAM livre antes de suspeitar de bug no código.

### Sub-projetos Python (`canal_da_fe/`, `canal_infantil/`)

Não são workspaces npm — são projetos Python independentes com seu próprio `venv/` e `.env`,
invocados como subprocesso a partir do Node (`CANALDAFE_PYTHON` / `CANALINFANTIL_PYTHON` apontam
para o interpretador do venv). Vídeos que geram vão para `output/canaldafe/` /
`output/canalinfantil/` como qualquer outra persona, com o sidecar `.meta.json` descrito acima. Ao
mexer neles, tratar como dois projetos separados dentro do repo, não como módulos JS do projeto
principal.

### Convenções gerais

- ESM em todo o projeto (`"type": "module"` no `package.json`) — usar `import`/`export`, nunca
  `require`.
- Windows é a plataforma alvo real (paths, `taskkill`, `process.kill` cross-processo) — não assumir
  comportamento POSIX ao tocar em process management.
- Todo estado persistente de runtime é JSON em disco (`scheduler/`, `postados/`, `tmp/`), nunca banco
  de dados — a única exceção é a Agenda Esportiva (Prisma/SQLite, só para o Watchdog/Sports Radar).
  Esses arquivos JSON não são commitados (ver `.gitignore`) e mudam a cada execução — não tratar seu
  conteúdo atual como parte do código-fonte.
- `.env.example` é a documentação viva de toda variável de ambiente do projeto (comentado por seção)
  — antes de adicionar uma variável nova, verificar se uma equivalente já existe lá.
