# Canal Corte 🎬

Automação de cortes de lives do **YouTube** e **Twitch**. O sistema detecta o momento de maior audiência de um VOD, corta o trecho e salva em formato vertical **9:16** (ideal para Shorts/Reels/TikTok).

---

## Estrutura do Projeto

```
canal-corte/
├── src/
│   ├── index.js                # Ponto de entrada (orquestrador)
│   ├── platforms/
│   │   ├── youtube.js          # Extração de heatmap via yt-dlp
│   │   └── twitch.js           # Top clip via Twitch Helix API
│   ├── processor/
│   │   └── ffmpeg.js           # Download, corte e crop 9:16
│   └── utils/
│       ├── logger.js           # Logger colorido
│       └── helpers.js          # Funções auxiliares
├── output/                     # Clipes gerados (criado automaticamente)
├── .env                        # Suas credenciais (NÃO commitar)
├── .env.example                # Template de variáveis
├── package.json
└── README.md
```

---

## Pré-requisitos

### 1. Node.js ≥ 18
Baixe em [nodejs.org](https://nodejs.org/).

### 2. FFmpeg
1. Acesse [ffmpeg.org/download.html](https://ffmpeg.org/download.html) → Windows builds
2. Extraia para `C:\ffmpeg\`
3. **Opção A (recomendada):** Adicione `C:\ffmpeg\bin` ao **PATH** do sistema:
   - Abra "Variáveis de Ambiente" no Windows → edite a variável `Path` do sistema → adicione `C:\ffmpeg\bin`
4. **Opção B:** Preencha `FFMPEG_PATH` e `FFPROBE_PATH` no `.env`

Verifique: `ffmpeg -version`

### 3. yt-dlp
1. Baixe o executável: [github.com/yt-dlp/yt-dlp/releases](https://github.com/yt-dlp/yt-dlp/releases) → `yt-dlp.exe`
2. **Opção A (recomendada):** Mova para uma pasta no PATH (ex: `C:\ffmpeg\bin\`)
3. **Opção B:** Preencha `YTDLP_PATH` no `.env`

Verifique: `yt-dlp --version`

---

## Configuração

### 1. Instalar dependências
```bash
cd "canal corte"
npm install
```

### 2. Criar o arquivo `.env`
Copie o template:
```bash
copy .env.example .env
```

Edite o `.env` conforme necessário:
```env
# Apenas necessário para vídeos da Twitch:
TWITCH_CLIENT_ID=seu_client_id
TWITCH_CLIENT_SECRET=seu_client_secret

# Preencha apenas se ffmpeg/yt-dlp NÃO estiverem no PATH:
FFMPEG_PATH=
FFPROBE_PATH=
YTDLP_PATH=

# Configurações de saída:
OUTPUT_DIR=./output
CLIP_BUFFER_SECONDS=30
```

### 3. Credenciais da Twitch (apenas para VODs Twitch)
1. Acesse [dev.twitch.tv/console/apps](https://dev.twitch.tv/console/apps)
2. Crie um novo aplicativo (pode ser qualquer nome, ex: "canal-corte-local")
3. Tipo: **Other**, Redirect URI: `http://localhost`
4. Copie o **Client ID** e gere um **Client Secret**
5. Cole no `.env`

> **YouTube não requer nenhuma chave de API.** O yt-dlp acessa os metadados públicos diretamente.

---

## Uso

```bash
# YouTube
node src/index.js "https://www.youtube.com/watch?v=VIDEO_ID"

# Twitch
node src/index.js "https://www.twitch.tv/videos/VOD_ID"
```

O clipe será salvo automaticamente em `./output/`.

### Exemplo de saída no terminal
```
══════════════════════════════════════════════════
  🎬  CANAL CORTE — Automação de Clipes
══════════════════════════════════════════════════

[02:35:10] ▶ PASSO  1/3 — Identificando plataforma...
[02:35:10] ✔ OK     Plataforma detectada: YOUTUBE
[02:35:10] ▶ PASSO  2/3 — Mapeando pico de audiência...
[02:35:12] ℹ INFO   Buscando metadados via yt-dlp...
[02:35:18] ✔ OK     Pico em 4521.0s (intensidade: 98.3%) — "Nome da Live"
[02:35:18] ▶ PASSO  3/3 — Processando corte com FFmpeg...
[02:35:19] ℹ INFO   Intervalo: 1h 14m 51s → 1h 15m 51s (buffer de 30s)
  ⏳ Progresso: 87.4%

══════════════════════════════════════════════════
  ✅  Clipe finalizado!
  📁  C:\Users\...\canal corte\output\Nome_da_Live__pico-4521s__2026-03-03T02-59.mp4
══════════════════════════════════════════════════
```

---

## Como Funciona

### YouTube — Heatmap / Most Replayed
- Executa `yt-dlp --dump-json` para baixar os metadados sem baixar o vídeo
- Analisa o campo `heatmap` do JSON (array de segmentos com valor de 0–1)
- Encontra o segmento com maior `value` (= ponto mais repetido pelos espectadores)
- O pico é o ponto médio desse segmento

### Twitch — Top Clips do VOD
- Autentica na Helix API com Client Credentials (App Token)
- Busca os clipes com `video_id=VOD_ID` ordenados por views
- Extrai o `vod_offset` (posição do clipe dentro do VOD original)

### FFmpeg — Corte e Crop 9:16
- `yt-dlp --get-url` obtém a URL do stream sem baixar o arquivo inteiro
- FFmpeg recebe essa URL e extrai apenas o segmento necessário (`-ss` / `-t`)
- Filtro de crop: `crop=ih*9/16:ih:(iw-ih*9/16)/2:0` — corta o centro do frame
- Codec: H.264 (libx264) + AAC 192k, com `-movflags +faststart` para preview rápido

---

## Variáveis de Ambiente

| Variável | Obrigatório | Padrão | Descrição |
|---|---|---|---|
| `TWITCH_CLIENT_ID` | ✅ (Twitch) | — | Client ID do app Twitch |
| `TWITCH_CLIENT_SECRET` | ✅ (Twitch) | — | Client Secret do app Twitch |
| `FFMPEG_PATH` | ❌ | `ffmpeg` (PATH) | Caminho completo do executável ffmpeg |
| `FFPROBE_PATH` | ❌ | `ffprobe` (PATH) | Caminho completo do executável ffprobe |
| `YTDLP_PATH` | ❌ | `yt-dlp` (PATH) | Caminho completo do executável yt-dlp |
| `OUTPUT_DIR` | ❌ | `./output` | Pasta de destino dos clipes |
| `CLIP_BUFFER_SECONDS` | ❌ | `30` | Buffer em segundos antes/depois do pico |

---

## Solução de Problemas

**`yt-dlp: command not found`**
→ Verifique se o executável está no PATH ou preencha `YTDLP_PATH` no `.env`

**`FFmpeg: command not found`**
→ Verifique se o FFmpeg está no PATH ou preencha `FFMPEG_PATH` no `.env`

**`Nenhum dado de heatmap encontrado`**
→ O YouTube só exibe "Most Replayed" em vídeos com muitas visualizações. Tente com um vídeo mais popular.

**`Nenhum clipe encontrado` (Twitch)**
→ O VOD pode não ter clipes criados pela comunidade, ou pode ser privado.

**`Não foi possível extrair o ID do VOD Twitch`**
→ Use o formato: `https://www.twitch.tv/videos/123456789`
