# Canal Infantil — Automação de Shorts Educativos com IA (v2)

Este é um projeto completo para automatizar a criação e publicação de vídeos curtos (Shorts) para um canal infantil educativo no YouTube. O sistema utiliza IA para gerar roteiros, busca imagens e gera narração, compilando tudo em um vídeo de alta qualidade que é publicado automaticamente.

## Arquitetura

O projeto é dividido em 3 componentes principais:

1.  **Motor de Roteiro (`script_engine.py`):** Um script Python que usa uma LLM (**Gemini 2.5 Pro** com fallback para **Groq**) para criar o roteiro, a API do **Pexels** para buscar imagens e vídeos de alta qualidade e o Edge-TTS para a narração.
2.  **Motor de Vídeo (`/video`):** Um projeto [Remotion](https://remotion.dev) (React/TypeScript) que renderiza as imagens e o áudio em um vídeo MP4 com legendas e animações profissionais.
3.  **Orquestrador e Uploader (`main.py`, `youtube_studio_uploader.py`):** Scripts Python que gerenciam o pipeline, chamam os outros motores e usam o Playwright para fazer o upload do vídeo final de forma "humana" no YouTube Studio.

## Guia de Setup e Instalação

Siga estes passos para configurar e rodar o projeto.

### Pré-requisitos

-   Python 3.9+
-   Node.js 18+
-   Navegador Google Chrome

### Passo 1: Criar Estrutura de Arquivos

Crie a seguinte estrutura de pastas e arquivos em sua máquina. O conteúdo de cada arquivo está detalhado mais abaixo neste documento.

```
canal_infantil/
├── assets/
│   └── (vazio, será preenchido automaticamente)
├── output/
│   └── (vazio, será preenchido automaticamente)
├── video/
│   ├── public/
│   │   └── (vazio, será preenchido automaticamente)
│   ├── src/
│   │   ├── Root.tsx
│   │   ├── ShortsVideo.tsx
│   │   ├── index.tsx
│   │   └── types.ts
│   ├── package.json
│   └── tsconfig.json
├── .env
├── main.py
├── requirements.txt
├── script_engine.py
└── youtube_studio_uploader.py
```

### Passo 2: Configurar Variáveis de Ambiente

Crie o arquivo `.env` na raiz do projeto (`canal_infantil/.env`) e adicione suas chaves de API.

```ini
# .env
# Obtenha sua chave Google em: https://aistudio.google.com/apikey
GOOGLE_API_KEY="sua_chave_google_aqui"

# Obtenha sua chave Groq em: https://console.groq.com/keys
GROQ_API_KEY="sua_chave_groq_aqui"

# Obtenha sua chave Pexels em: https://www.pexels.com/api/
PEXELS_API_KEY="sua_chave_pexels_aqui"
```

### Passo 3: Instalar Dependências

1.  **Dependências Python:**

    ```bash
    # Navegue até a pasta raiz do projeto
    cd canal_infantil

    # Crie e ative um ambiente virtual (recomendado)
    python -m venv venv
    source venv/bin/activate  # No Windows: venv\Scripts\activate

    # Instale as bibliotecas
    pip install -r requirements.txt

    # Instale o Playwright e seus navegadores
    playwright install
    ```

2.  **Dependências Node.js (Remotion):**

    ```bash
    # Navegue até a pasta de vídeo
    cd video

    # Instale os pacotes npm
    npm install
    ```

### Passo 4: Login Inicial no YouTube

O sistema usa um perfil de navegador persistente para não precisar fazer login a cada vez. Na primeira execução, você precisará logar manualmente.

1.  Execute o uploader em modo de "setup":

    ```bash
    # Na pasta raiz (canal_infantil)
    python youtube_studio_uploader.py --setup
    ```

2.  Uma janela do navegador Chrome abrirá. Faça login na sua conta do Google/YouTube que você usará para o canal.
3.  Após o login, feche o navegador. Suas credenciais estarão salvas na pasta `browser_profile`.

### Passo 5: Rodar o Pipeline!

Agora você está pronto para rodar a automação completa.

```bash
# Na pasta raiz (canal_infantil)

# Para rodar um único ciclo (gerar 1 vídeo e parar):
python main.py --once

# Para rodar em loop contínuo (gera 1 vídeo a cada 6 horas):
python main.py
```

---

## Código-Fonte dos Arquivos

Copie e cole o conteúdo abaixo em seus respectivos arquivos.

### 1. Arquivos Python




**Arquivo: `canal_infantil/requirements.txt`**
```txt
groq
edge-tts
requests
python-dotenv
rich
playwright
mutagen
Pillow
google-generativeai
```




**Arquivo: `canal_infantil/main.py`**
```python
"""
main.py — Orquestrador Principal do Pipeline de Shorts Infantis
Loop contínuo: gera roteiro → renderiza → posta → aguarda.
"""
import sys
import time
import random
import shutil
import subprocess
import argparse
from pathlib import Path
from datetime import datetime, timedelta

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.progress import Progress, BarColumn, TextColumn, TimeRemainingColumn, SpinnerColumn
from rich import box

import script_engine
import youtube_studio_uploader

# --- Configurações ---
console = Console()

OUTPUT_DIR = Path("output")
ASSETS_DIR = Path("assets")
VIDEO_DIR = Path("video")
PUBLIC_DIR = VIDEO_DIR / "public"

OUTPUT_DIR.mkdir(exist_ok=True)
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
(PUBLIC_DIR / "images").mkdir(exist_ok=True)

INTERVAL_HOURS = 6
INTERVAL_SECONDS = INTERVAL_HOURS * 3600
JITTER_SECONDS = 15 * 60

def banner(ciclo: int):
    hora = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    console.print()
    console.print(Panel(
        f"[bold yellow]  Canal Infantil — Pipeline de Shorts Educativos (v2)[/bold yellow]\n"
        f"[dim]Gemini 2.5 Pro · Pexels · Remotion · Edge TTS[/dim]\n\n"
        f"[bold]CICLO #{ciclo}[/bold]  |  [cyan]{hora}[/cyan]",
        border_style="bright_blue",
        box=box.DOUBLE_EDGE,
        expand=False,
    ))

def log_passo(num: int, total: int, titulo: str, emoji: str = "🚀"):
    console.print()
    console.rule(f"[bold white] {emoji} PASSO {num}/{total}: {titulo} [/bold white]", style="bright_blue")

def copiar_assets():
    console.print("[bold magenta][ASSETS][/bold magenta] Copiando para video/public/...")
    shutil.copy(ASSETS_DIR / "metadata.json", PUBLIC_DIR / "metadata.json")
    images_public = PUBLIC_DIR / "images"
    images_public.mkdir(exist_ok=True)
    for img in (ASSETS_DIR / "images").glob("*.jpg"):
        shutil.copy(img, images_public / img.name)
    audio_src = ASSETS_DIR / "audio.mp3"
    if audio_src.exists():
        shutil.copy(audio_src, PUBLIC_DIR / "audio.mp3")
    console.print("[bold green][ASSETS][/bold green] Assets prontos para renderização.")

def render_remotion() -> str:
    output_path = str((OUTPUT_DIR / f"short_infantil_{int(time.time())}.mp4").absolute())
    console.print(f"[bold magenta][REMOTION][/bold magenta] Iniciando render 1080x1920 @ 30fps...")
    cmd = ["npx", "remotion", "render", "src/index.tsx", "ShortsVideo", output_path, "--log=info"]
    process = subprocess.Popen(cmd, cwd=str(VIDEO_DIR), stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, encoding="utf-8", errors="replace")
    for line in process.stdout:
        low = line.lower().strip()
        if "error" in low:
            console.print(f"[red][REMOTION] {line.strip()}[/red]")
        elif "rendered" in low and "/" in line:
            console.print(f"[magenta][RENDER][/magenta] {line.strip()}", end="\r")
        elif low:
            console.print(f"[dim][REMOTION] {low}[/dim]")
    process.wait()
    if process.returncode != 0:
        raise RuntimeError(f"Remotion render falhou (exit {process.returncode})")
    size_mb = Path(output_path).stat().st_size / 1024 / 1024
    console.print(f"\n[bold green][REMOTION][/bold green] Vídeo renderizado: {size_mb:.1f} MB")
    return output_path

def fazer_upload_youtube(video_path: str, metadata: dict) -> str | None:
    console.print("[bold red][YOUTUBE][/bold red] Abrindo YouTube Studio no Chromium...")
    with console.status("[bold red]Aguardando Playwright...[/bold red]", spinner="dots"):
        url = youtube_studio_uploader.upload(video_path, metadata)
    return url

def countdown(segundos: int, proximo_horario: datetime):
    console.print()
    console.print(Panel(
        f"[bold green]Ciclo concluído com sucesso![/bold green]\n\n"
        f"Próximo vídeo: [bold cyan]{proximo_horario.strftime('%d/%m %H:%M:%S')}[/bold cyan]\n"
        f"(em [yellow]{segundos // 3600}h {(segundos % 3600) // 60}min[/yellow])",
        title="[bold] AGUARDANDO PRÓXIMO CICLO [/bold]",
        border_style="green",
        box=box.ROUNDED,
    ))
    with Progress(SpinnerColumn(), TextColumn("[bold green]Próximo vídeo em[/bold green]"), BarColumn(bar_width=40), TextColumn("[bold cyan]{task.description}[/bold cyan]"), TimeRemainingColumn(), console=console) as progress:
        task = progress.add_task("", total=segundos)
        for restante in range(segundos, 0, -1):
            h, m, s = restante // 3600, (restante % 3600) // 60, restante % 60
            progress.update(task, completed=segundos - restante, description=f"{h:02d}:{m:02d}:{s:02d}")
            time.sleep(1)

def resumo_ciclo(ciclo: int, metadata: dict, video_url: str | None, duracao_total: float):
    console.print()
    tabela = Table(title=f"[bold]RESUMO DO CICLO #{ciclo}[/bold]", box=box.HEAVY_HEAD, border_style="bright_blue")
    tabela.add_column("Item", style="cyan")
    tabela.add_column("Valor", style="white")
    tabela.add_row("Tema", metadata["tema"])
    tabela.add_row("Título", metadata["titulo"])
    tabela.add_row("Duração", f"{duracao_total:.1f}s")
    tabela.add_row("URL", f"[link={video_url}]{video_url}[/link]" if video_url else "[red]Falha no upload[/red]")
    console.print(tabela)

def main():
    parser = argparse.ArgumentParser(description="Pipeline de automação de Shorts infantis.")
    parser.add_argument("--once", action="store_true", help="Roda o pipeline apenas uma vez.")
    args = parser.parse_args()

    ciclo = 1
    while True:
        banner(ciclo)
        try:
            log_passo(1, 4, "GERANDO ROTEIRO, IMAGENS E ÁUDIO")
            metadata = script_engine.generate()

            log_passo(2, 4, "RENDERIZANDO VÍDEO COM REMOTION")
            copiar_assets()
            video_path = render_remotion()

            log_passo(3, 4, "FAZENDO UPLOAD PARA O YOUTUBE")
            video_url = fazer_upload_youtube(video_path, metadata)

            log_passo(4, 4, "CICLO CONCLUÍDO", emoji="✅")
            resumo_ciclo(ciclo, metadata, video_url, metadata.get("duracao_total_real_s", 0))

        except Exception as e:
            console.print(f"[bold red]ERRO CRÍTICO NO PIPELINE:[/bold red] {e}")
            console.print_exception(show_locals=True)

        if args.once:
            console.print("\n[bold yellow]--once flag detectada. Finalizando após um ciclo.[/bold yellow]")
            break

        jitter = random.randint(-JITTER_SECONDS, JITTER_SECONDS)
        tempo_espera = INTERVAL_SECONDS + jitter
        proximo_horario = datetime.now() + timedelta(seconds=tempo_espera)
        countdown(tempo_espera, proximo_horario)
        ciclo += 1

if __name__ == "__main__":
    main()
```




**Arquivo: `canal_infantil/script_engine.py`**
```python
"""
script_engine.py — Motor de Geração de Conteúdo
- Gera roteiro com Gemini 2.5 Pro (fallback Groq)
- Busca imagens no Pexels
- Gera áudio com Edge-TTS
"""
import os
import json
import time
import random
import asyncio
import re
from pathlib import Path

import requests
from groq import Groq
import google.generativeai as genai
from dotenv import load_dotenv
from rich.console import Console
from rich.progress import Progress, BarColumn, TextColumn

load_dotenv()

# --- Configurações ---
console = Console()

GOOGLE_API_KEY = os.getenv("GOOGLE_API_KEY")
GROQ_API_KEY = os.getenv("GROQ_API_KEY")
PEXELS_API_KEY = os.getenv("PEXELS_API_KEY")

ASSETS_DIR = Path("assets")
ASSETS_DIR.mkdir(exist_ok=True)
(ASSETS_DIR / "images").mkdir(exist_ok=True)

# --- Constantes ---
TEMAS_INFANTIS = [
    "curiosidades sobre animais marinhos para crianças",
    "como as borboletas se transformam em crisálida",
    "a história dos dinossauros para crianças",
    "por que o céu é azul explicado para crianças",
    "como as abelhas fazem mel",
    "curiosidades sobre o sistema solar para crianças",
    "como funcionam os vulcões de forma simples",
    "a vida secreta das formigas",
    "por que temos sonhos curiosidades infantis",
    "animais que brilham no escuro bioluminescência",
]

PROMPT_LLM = """
Você é um roteirista criativo especialista em conteúdo infantil educativo para YouTube Shorts. Crie um roteiro COMPLETO sobre: "{tema}". O roteiro deve ter EXATAMENTE 7 cenas curtas, cada uma com 6-8 segundos de narração. O tom deve ser animado, divertido e educativo para crianças de 4 a 10 anos. Use linguagem simples, exclamações e palavras que chamam atenção.

Retorne SOMENTE um JSON válido neste formato exato (sem markdown, sem explicações):

{
  "tema": "string",
  "titulo": "string (max 40 chars)",
  "descricao": "string (max 120 chars)",
  "tags": ["string"],
  "query_imagens": "string (termo de busca para Pexels, ex: 'cute cat')",
  "cenas": [
    {
      "id": 1,
      "texto": "string (narração da cena)",
      "duracao_s": 7
    }
  ]
}
"""

def _limpar_json(texto: str) -> str:
    match = re.search(r"```json\n(.*?)\n```", texto, re.DOTALL)
    if match:
        return match.group(1).strip()
    return texto.strip()

def gerar_roteiro_gemini(tema: str) -> dict:
    if not GOOGLE_API_KEY:
        raise ValueError("GOOGLE_API_KEY não encontrada no .env!")
    genai.configure(api_key=GOOGLE_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-pro")
    console.print(f"[bold blue][LLM][/bold blue] Gerando roteiro com Gemini 2.5 Pro para o tema: \"{tema}\"")
    response = model.generate_content(PROMPT_LLM.format(tema=tema))
    response_text = _limpar_json(response.text)
    data = json.loads(response_text)
    console.print("[bold green][LLM][/bold green] Roteiro JSON recebido do Gemini com sucesso.")
    return data

def gerar_roteiro_groq(tema: str) -> dict:
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY não encontrada no .env!")
    client = Groq(api_key=GROQ_API_KEY)
    console.print(f"[bold blue][LLM-Fallback][/bold blue] Gerando roteiro com Groq (llama-3.3-70b-versatile) para o tema: \"{tema}\"")
    chat_completion = client.chat.completions.create(
        messages=[
            {
                "role": "user",
                "content": PROMPT_LLM.format(tema=tema),
            }
        ],
        model="llama-3.3-70b-versatile",
        temperature=0.8,
        max_tokens=2048,
    )
    response_text = _limpar_json(chat_completion.choices[0].message.content)
    data = json.loads(response_text)
    console.print("[bold green][LLM-Fallback][/bold green] Roteiro JSON recebido do Groq com sucesso.")
    return data

def gerar_roteiro(tema: str) -> dict:
    try:
        return gerar_roteiro_gemini(tema)
    except Exception as e_gemini:
        console.print(f"[bold yellow]AVISO: Gemini falhou ({e_gemini}). Tentando fallback com Groq...[/bold yellow]")
        try:
            return gerar_roteiro_groq(tema)
        except Exception as e_groq:
            console.print(f"[bold red]ERRO CRÍTICO: Fallback com Groq também falhou ({e_groq}).[/bold red]")
            raise

def baixar_imagens(query: str, quantidade: int = 7) -> list:
    if not PEXELS_API_KEY:
        raise ValueError("PEXELS_API_KEY não encontrada no .env!")

    console.print(f'\n[bold blue][PEXELS][/bold blue] Buscando imagens para: \'[cyan]{query}[/cyan]\'')
    headers = {"Authorization": PEXELS_API_KEY}
    url = f"https://api.pexels.com/v1/search?query={query}&per_page={quantidade}&orientation=portrait"
    response = requests.get(url, headers=headers)
    response.raise_for_status()
    photos = response.json()["photos"]

    image_paths = []
    with Progress(TextColumn("[bold blue][PEXELS][/bold blue]"), BarColumn(), TextColumn("{task.description}"), console=console) as progress:
        task = progress.add_task("Baixando", total=len(photos))
        for i, photo in enumerate(photos):
            img_url = photo["src"]["portrait"]
            output_path = ASSETS_DIR / "images" / f"img_{i+1:02d}.jpg"
            img_data = requests.get(img_url).content
            output_path.write_bytes(img_data)
            image_paths.append(f"img_{i+1:02d}.jpg")
            progress.update(task, description=f"Imagem {i+1}/{len(photos)}...")
            progress.advance(task)

    console.print(f"[bold green][PEXELS][/bold green] {len(image_paths)} imagens baixadas.")
    return image_paths

async def gerar_audio_async(texto: str, caminho_saida: str):
    import edge_tts
    communicate = edge_tts.Communicate(texto, voice="pt-BR-FranciscaNeural")
    await communicate.save(caminho_saida)

def gerar_audio(data: dict) -> tuple:
    from mutagen.mp3 import MP3 as MutagenMP3
    console.print("\n[bold magenta][TTS][/bold magenta] Gerando áudio por cena com Edge-TTS...")
    cenas = data["cenas"]
    duracoes_reais = []
    partes = []
    with Progress(TextColumn("[bold magenta][TTS][/bold magenta]"), BarColumn(), TimeElapsedColumn(), console=console) as progress:
        task = progress.add_task("Cenas", total=len(cenas))
        for i, cena in enumerate(cenas):
            if not cena["texto"].strip():
                progress.advance(task)
                continue
            caminho_cena = str(ASSETS_DIR / f"audio_cena_{i+1:02d}.mp3")
            asyncio.run(gerar_audio_async(cena["texto"], caminho_cena))
            info = MutagenMP3(caminho_cena).info
            duracoes_reais.append(round(info.length, 3))
            partes.append(caminho_cena)
            progress.advance(task)
    caminho_final = str(ASSETS_DIR / "audio.mp3")
    with open(caminho_final, "wb") as saida:
        for parte in partes:
            with open(parte, "rb") as entrada:
                saida.write(entrada.read())
    total = round(sum(duracoes_reais), 2)
    console.print(f"[bold green][TTS][/bold green] Áudio final gerado: {total}s")
    return caminho_final, duracoes_reais

def salvar_metadata(data: dict, duracoes_reais: list, image_paths: list):
    cenas_com_timing = []
    duracao_idx = 0
    for i, cena in enumerate(data["cenas"]):
        duracao_real = 0
        if cena["texto"].strip():
            if duracao_idx < len(duracoes_reais):
                duracao_real = duracoes_reais[duracao_idx]
                duracao_idx += 1
        cenas_com_timing.append({
            **cena,
            "duracao_real_s": duracao_real,
        })
    payload = {
        **data,
        "cenas": cenas_com_timing,
        "imagens": image_paths,
        "audio": "audio.mp3",
        "duracao_total_s": sum(c["duracao_s"] for c in data["cenas"]),
        "duracao_total_real_s": round(sum(duracoes_reais), 2),
    }
    caminho = ASSETS_DIR / "metadata.json"
    caminho.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    console.print(f"\n[bold green][META][/bold green] metadata.json salvo com timings reais.")

def generate() -> dict:
    console.rule("[bold cyan]MOTOR DE ROTEIRO INICIADO[/bold cyan]")
    tema = random.choice(TEMAS_INFANTIS)
    data = gerar_roteiro(tema)
    image_paths = baixar_imagens(data["query_imagens"], len(data["cenas"]))
    _, duracoes_reais = gerar_audio(data)
    salvar_metadata(data, duracoes_reais, image_paths)
    console.rule("[bold green]MOTOR DE ROTEIRO CONCLUÍDO[/bold green]")
    return json.loads((ASSETS_DIR / "metadata.json").read_text(encoding="utf-8"))

if __name__ == "__main__":
    generate()
```




**Arquivo: `canal_infantil/youtube_studio_uploader.py`**
```python
"""
youtube_studio_uploader.py — Upload humano via Playwright no YouTube Studio
"""
import time
import random
import argparse
from pathlib import Path
from rich.console import Console
from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

console = Console()
PROFILE_DIR = str(Path("browser_profile").absolute())

def human_delay(min_s: float = 0.8, max_s: float = 2.2):
    time.sleep(random.uniform(min_s, max_s))

def setup_profile():
    console.print("[bold yellow]Modo de Setup: Faça login na sua conta do Google.[/bold yellow]")
    console.print("A janela do navegador será aberta. Após o login, pode fechá-la.")
    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(PROFILE_DIR, headless=False, args=["--start-maximized"], no_viewport=True)
        page = browser.new_page()
        page.goto("https://studio.youtube.com")
        console.print("[bold green]Aguardando você fechar o navegador...[/bold green]")
        page.wait_for_event("close", timeout=300000) # 5 minutos para logar
    console.print("[bold green]Setup concluído! Perfil de navegador salvo.[/bold green]")

def upload(video_path: str, metadata: dict) -> str | None:
    titulo = metadata.get("titulo", "Curiosidades para Crianças")
    descricao = metadata.get("descricao", "") + "\n\n#Shorts #Infantil #Educativo #Criancas"
    video_path = str(Path(video_path).absolute())

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(PROFILE_DIR, headless=False, args=["--start-maximized"], no_viewport=True, slow_mo=100)
        page = browser.new_page()
        try:
            console.print("[bold blue][YOUTUBE][/bold blue] Abrindo YouTube Studio...")
            page.goto("https://studio.youtube.com", wait_until="domcontentloaded", timeout=60000)
            human_delay(2, 4)
            if "accounts.google.com" in page.url:
                console.print("[bold red]ERRO: Login não encontrado. Rode com '--setup' primeiro.[/bold red]")
                return None

            page.locator("#create-icon").click()
            human_delay(1, 2)
            page.get_by_text("Enviar vídeos").click()
            human_delay(1.5, 2.5)

            console.print("[bold blue][YOUTUBE][/bold blue] Selecionando arquivo de vídeo...")
            with page.expect_file_chooser() as fc_info:
                page.locator('input[type="file"]').dispatch_event('click')
            fc_info.value.set_files(video_path)
            human_delay(4, 7)

            console.print("[bold blue][YOUTUBE][/bold blue] Preenchendo título e descrição...")
            title_box = page.locator("#textbox").first
            title_box.click()
            title_box.press("Control+A")
            title_box.press("Backspace")
            title_box.press_sequentially(titulo, delay=random.randint(80, 150))
            human_delay(1, 2)

            desc_box = page.locator("#description-textarea #textbox")
            desc_box.click()
            desc_box.press_sequentially(descricao, delay=random.randint(40, 90))
            human_delay(1, 2)

            console.print("[bold blue][YOUTUBE][/bold blue] Configurando para 'Sim, é conteúdo para crianças'...")
            page.locator("tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_MFK']").click()
            human_delay(1, 1.5)

            for i in range(3):
                human_delay(1, 2)
                page.locator("#next-button").click()

            console.print("[bold blue][YOUTUBE][/bold blue] Configurando visibilidade para 'Público'...")
            page.locator("tp-yt-paper-radio-button[name='PUBLIC']").click()
            human_delay(1, 2)

            console.print("[bold blue][YOUTUBE][/bold blue] Aguardando upload e processamento...")
            page.wait_for_selector("span.progress-label:has-text('Verificações concluídas')", timeout=600000) # 10 min timeout
            human_delay(1, 2)

            page.locator("#done-button").click()
            human_delay(4, 8)

            video_url = page.locator("a.ytcp-video-info").first.get_attribute("href")
            console.print(f"[bold green][YOUTUBE] Publicado! URL: {video_url}[/bold green]")
            page.locator("#close-button").click()
            return video_url
        except Exception as e:
            console.print(f"[bold red][YOUTUBE] Erro no upload: {e}[/bold red]")
            page.screenshot(path=f"error_upload_{int(time.time())}.png")
            return None
        finally:
            human_delay(5, 8)
            browser.close()

if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--setup", action="store_true", help="Roda o modo de setup para login inicial.")
    args = parser.parse_args()
    if args.setup:
        setup_profile()
```

### 2. Arquivos Remotion (TypeScript)




**Arquivo: `canal_infantil/video/package.json`**
```json
{
  "name": "canal-infantil-video",
  "version": "1.0.0",
  "description": "Motor de renderização de vídeo para o Canal Infantil",
  "scripts": {
    "start": "remotion preview src/index.tsx",
    "render": "remotion render src/index.tsx ShortsVideo ../output/video.mp4",
    "upgrade": "remotion upgrade"
  },
  "dependencies": {
    "@remotion/cli": "^4.0.0",
    "@remotion/media-utils": "^4.0.0",
    "react": "^18.2.0",
    "react-dom": "^18.2.0",
    "remotion": "^4.0.0",
    "zod": "^4.3.6"
  },
  "devDependencies": {
    "@types/react": "^18.2.0",
    "@types/react-dom": "^18.2.0",
    "typescript": "^5.0.0"
  }
}
```




**Arquivo: `canal_infantil/video/tsconfig.json`**
```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "CommonJS",
    "jsx": "react-jsx",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true
  },
  "include": ["src"]
}
```




**Arquivo: `canal_infantil/video/src/types.ts`**
```typescript
import { z } from "zod";

export const CenaSchema = z.object({
    id: z.number(),
    texto: z.string(),
    duracao_s: z.number(),
    duracao_real_s: z.number().optional(),
});

export const VideoMetadataSchema = z.object({
    tema: z.string(),
    titulo: z.string(),
    descricao: z.string(),
    tags: z.array(z.string()),
    query_imagens: z.string(),
    imagens: z.array(z.string()),
    audio: z.string(),
    duracao_total_s: z.number(),
    duracao_total_real_s: z.number().optional(),
    cenas: z.array(CenaSchema),
});

export type Cena = z.infer<typeof CenaSchema>;
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;
```




**Arquivo: `canal_infantil/video/src/index.tsx`**
```typescript
import { registerRoot } from "remotion";
import { Root } from "./Root";

registerRoot(Root);
```




**Arquivo: `canal_infantil/video/src/Root.tsx`**
```typescript
import { Composition, staticFile } from "remotion";
import { ShortsVideo } from "./ShortsVideo";
import { VideoMetadata } from "./types";

const FPS = 30;

export const Root: React.FC = () => {
    return (
        <>
            <Composition
                id="ShortsVideo"
                component={ShortsVideo}
                calculateMetadata={async () => {
                    const response = await fetch(staticFile("metadata.json"));
                    const meta: VideoMetadata = await response.json();
                    const totalSeconds = meta.duracao_total_real_s ?? meta.duracao_total_s ?? 49;
                    const durationInFrames = Math.ceil((totalSeconds + 1) * FPS);

                    return {
                        durationInFrames,
                        fps: FPS,
                        width: 1080,
                        height: 1920,
                        props: {},
                    };
                }}
                // Fallback, será sobrescrito pelo calculateMetadata
                durationInFrames={FPS * 50}
                fps={FPS}
                width={1080}
                height={1920}
            />
        </>
    );
};
```




**Arquivo: `canal_infantil/video/src/ShortsVideo.tsx`**
```typescript
import React, {useEffect, useState} from 'react';
import {
    AbsoluteFill,
    Sequence,
    Audio,
    staticFile,
    useCurrentFrame,
    useVideoConfig,
    interpolate,
    spring,
    Img,
} from 'remotion';
import {Cena, VideoMetadata} from './types';

const SUBTITLE_COLORS = ["#FFD700", "#00FFFF", "#ADFF2F", "#FF69B4", "#FF8C00", "#E0E0FF", "#7FFF00"];
const TEXT_OUTLINE = `
  -3px -3px 0 #000,
   3px -3px 0 #000,
  -3px  3px 0 #000,
   3px  3px 0 #000,
   0px  0px 20px rgba(0,0,0,0.8)
`;

const SceneComponent: React.FC<{cena: Cena; imageSrc: string; colorIndex: number; fps: number; sceneDurationFrames: number;}> = ({cena, imageSrc, colorIndex, fps, sceneDurationFrames}) => {
    const frame = useCurrentFrame();
    const color = SUBTITLE_COLORS[colorIndex % SUBTITLE_COLORS.length];

    // Efeitos
    const scale = interpolate(frame, [0, sceneDurationFrames], [1.0, 1.08], { extrapolateRight: "clamp" });
    const imageOpacity = interpolate(frame, [0, 12, sceneDurationFrames - 12, sceneDurationFrames], [0, 1, 1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
    const textScale = spring({ frame, fps, config: { damping: 14, mass: 0.7, stiffness: 140 }, from: 0.6, to: 1, durationInFrames: 18 });

    // Karaoke
    const words = cena.texto.split(' ');
    const syncableFrames = sceneDurationFrames * 0.95;
    const framesPerWord = syncableFrames / words.length;
    const currentWordIndex = Math.min(Math.floor(frame / framesPerWord), words.length - 1);

    return (
        <AbsoluteFill style={{backgroundColor: '#000'}}>
                <Img
                    src={imageSrc}
                    style={{
                        width: '100%',
                        height: '100%',
                        objectFit: 'cover',
                        opacity: imageOpacity,
                        transform: `scale(${scale})`,
                        transformOrigin: "center center",
                    }}
                />

                <div style={{ position: 'absolute', bottom: 100, width: '100%', padding: '0 40px' }}>
                    <h1 style={{
                        fontFamily: "'Arial Black', 'Impact', 'Arial', sans-serif",
                        fontSize: 72,
                        fontWeight: 900,
                        lineHeight: 1.15,
                        textAlign: 'center',
                        textShadow: TEXT_OUTLINE,
                        transform: `scale(${textScale})`,
                    }}>
                        {words.map((word, i) => {
                            const isHighlighted = i === currentWordIndex;
                            const isPast = i < currentWordIndex;

                            return (
                                <span
                                    key={i}
                                    style={{
                                        color: isHighlighted ? color : isPast ? "#bbbbbb" : "#ffffff",
                                        fontSize: isHighlighted ? 86 : 72,
                                        letterSpacing: "-1px",
                                        transition: "font-size 0.05s, color 0.05s",
                                    }}>
                                    {word}{' '}
                                </span>
                            );
                        })}
                    </h1>
                </div>
            </AbsoluteFill>
        );
};

export const ShortsVideo: React.FC = () => {
    const { fps, durationInFrames } = useVideoConfig();
    const [meta, setMeta] = useState<VideoMetadata | null>(null);

    useEffect(() => {
        const fetchMeta = async () => {
            const response = await fetch(staticFile("metadata.json"));
            const data = await response.json();
            setMeta(data);
        };
        fetchMeta();
    }, []);

    if (!meta) return null;

    let fromFrame = 0;
    return (
        <AbsoluteFill style={{backgroundColor: '#0a0a0a'}}>
                {meta.audio && <Audio src={staticFile("audio.mp3")} volume={1} />}
                {meta.cenas.map((cena, i) => {
                    const sceneDurationFrames = Math.max(1, Math.round((cena.duracao_real_s ?? cena.duracao_s) * fps));
                    const imageSrc = staticFile(`images/${meta.imagens[i % meta.imagens.length]}`);
                    const sequence = (
                        <Sequence key={i} from={fromFrame} durationInFrames={sceneDurationFrames}>
                            <SceneComponent cena={cena} imageSrc={imageSrc} colorIndex={i} fps={fps} sceneDurationFrames={sceneDurationFrames} />
                        </Sequence>
                    );
                    fromFrame += sceneDurationFrames;
                    return sequence;
                })}
            </AbsoluteFill>
        );
};
```
