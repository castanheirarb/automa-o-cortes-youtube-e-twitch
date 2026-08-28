"""
script_engine.py — Motor de Roteiro Brain Rot (sem Remotion)

Pipeline de assets:
  1. Groq      → roteiro JSON com narração + 5 prompts de imagem
  2. Pexels    → vídeo satisfatório vertical (≥60s)
  3. Pollinations.ai → 5 imagens do personagem em diferentes poses
  4. edge-tts  → narração em PT-BR, duração medida com mutagen
  5. SRT       → arquivo de legendas temporizado
  6. metadata.json → todos os caminhos para o FFmpeg
"""

import os
import sys
import json
import asyncio
import requests
import time
import random
import subprocess
import re
import urllib.parse
from pathlib import Path
from dotenv import load_dotenv
from rich.console import Console
from rich.progress import Progress, BarColumn, TextColumn, TimeElapsedColumn
from groq import Groq
import trending

if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

load_dotenv()
console = Console()

GROQ_API_KEY   = os.getenv("GROQ_API_KEY")
PEXELS_API_KEY = os.getenv("PEXELS_API_KEY")

ASSETS_DIR      = Path("assets")
CHAR_DIR        = ASSETS_DIR / "character_images"
ASSETS_DIR.mkdir(exist_ok=True)
CHAR_DIR.mkdir(exist_ok=True)

NUM_IMAGENS = 5  # imagens do personagem por vídeo

QUERIES_SATISFATORIOS = [
    # B-roll de OBJETOS/textura — termos genéricos como "oddly satisfying" ou
    # "asmr" trazem muita gente falando para a câmera no Pexels, o que não
    # combina com canal infantil. Estes são focados em coisas, não em pessoas.
    "colorful slime close up",
    "kinetic sand texture",
    "paint mixing swirl",
    "falling dominoes",
    "colored water drops macro",
    "glitter liquid motion",
    "bubbles underwater",
    "clay shapes rotating",
    "candy colorful background",
    "abstract fluid art",
]


# ─────────────────────────────────────────────────────────────────────────
# PASSO 1 — ROTEIRO VIA GROQ
# ─────────────────────────────────────────────────────────────────────────
def gerar_roteiro(tema: str) -> dict:
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY não encontrada no .env!")

    client = Groq(api_key=GROQ_API_KEY)
    console.print("[bold cyan][GROQ][/bold cyan] Gerando roteiro (llama-3.3-70b-versatile)...")

    prompt = f"""Você é um roteirista de conteúdo infantil para YouTube Shorts.

Crie uma história curta e cativante sobre: "{tema}".

REGRAS:
- Tom: animado, fofo, engraçado, com suspense leve e final feliz
- Público: crianças de 3-10 anos
- A narração deve ter entre 120 e 150 palavras em português brasileiro
  (isso equivale a aproximadamente 45-55 segundos de áudio TTS)
- Estrutura: começo (personagem descobre o problema), meio (tenta resolver,
  quase desiste), fim (encontra a solução e comemora)

Retorne SOMENTE um JSON válido neste formato (sem markdown, sem explicações):
{{
  "personagem": "descrição curta e fofa do personagem (ex: 'um esquilinho laranja chamado Pipoca')",
  "problema": "{tema}",
  "solucao": "como o personagem resolve o problema (1 frase clara)",
  "titulo": "Título com emoji para YouTube Shorts (máx 60 chars)",
  "descricao": "Descrição SEO de 120-150 palavras. Inclua #Shorts ao final.",
  "tags": ["tag1", "tag2", "tag3", "tag4", "tag5", "tag6", "tag7", "tag8"],
  "narracao": "Narração COMPLETA de 120-150 palavras. Tom animado com exclamações!",
  "personagem_prompt_base": "Prompt em inglês para IA de imagem: 'Cute [animal] with [features], simple cartoon style, white background, vibrant colors'",
  "prompts_imagem": [
    "Cena 1 — personagem descobrindo o problema: prompt em inglês detalhado",
    "Cena 2 — primeira tentativa fracassada: prompt em inglês detalhado",
    "Cena 3 — personagem pensativo, quase desistindo: prompt em inglês detalhado",
    "Cena 4 — personagem encontra e executa a solução: prompt em inglês detalhado",
    "Cena 5 — personagem comemorando vitorioso: prompt em inglês detalhado"
  ]
}}"""

    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.88,
        max_tokens=2000,
    )

    raw = resp.choices[0].message.content.strip()
    # Remove possível markdown fence
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip()
    if raw.endswith("```"):
        raw = raw[:-3].strip()

    data = json.loads(raw)
    console.print(f"[bold green][GROQ][/bold green] Roteiro: [yellow]{data['titulo']}[/yellow]")
    console.print(f"[dim]  Personagem: {data['personagem']}[/dim]")
    return data


# ─────────────────────────────────────────────────────────────────────────
# PASSO 2 — VÍDEO SATISFATÓRIO VIA PEXELS VIDEOS
# ─────────────────────────────────────────────────────────────────────────
STOPWORDS_TEMA = {
    "um", "uma", "uns", "umas", "o", "a", "os", "as", "de", "do", "da", "dos", "das",
    "que", "com", "sem", "para", "por", "no", "na", "nos", "nas", "em", "e", "ou",
    "seu", "sua", "seus", "suas", "seu", "como", "porque", "seu", "seus", "seu",
    "nao", "não", "seu", "muito", "mais", "seu", "ao", "aos", "à", "às", "pelo", "pela",
    "seu", "seus", "seu", "seu", "consegue", "tentando", "seu",
}

def _queries_do_tema(tema: str) -> list[str]:
    """Palavras-chave do tema viram queries de busca no Pexels.

    Sem isto o fundo era sempre B-roll aleatório: um vídeo sobre abelhas podia
    vir com uma pessoa gravando skincare, sem nenhuma relação com a narração.
    """
    if not tema:
        return []
    limpo = re.sub(r"[^\w\sÀ-ÿ]", " ", tema.lower())
    palavras = [p for p in limpo.split() if len(p) > 3 and p not in STOPWORDS_TEMA]
    if not palavras:
        return []
    queries = []
    if len(palavras) >= 2:
        queries.append(" ".join(palavras[:2]))
    queries.extend(palavras[:3])
    return queries


# Palavras que denunciam presença de pessoas no slug da URL do Pexels.
# O acervo é dominado por gente; num canal infantil, cenas com adultos
# (ex.: um casal na cama comendo pipoca) são inadequadas mesmo quando o
# assunto casa com o tema.
PALAVRAS_PESSOAS = [
    "woman", "women", "man", "men", "person", "people", "couple", "girl", "boy",
    "lady", "guy", "male", "female", "family", "portrait", "model", "selfie",
    "teenager", "adult", "human", "face", "hands-of", "businessman", "businesswoman",
    "mulher", "homem", "pessoa", "casal", "menina", "menino", "familia", "família",
]


def _tem_pessoas(video: dict) -> bool:
    """True se o slug do vídeo indicar presença de pessoas."""
    slug = (video.get("url") or "").lower()
    return any(p in slug for p in PALAVRAS_PESSOAS)


# Paletas suaves para o fundo gerado (tons pastéis, sem branco estourado)
PALETAS_FUNDO = [
    ("#7ec8e3", "#f9d371"),  # céu + sol
    ("#a8e6cf", "#ffd3b6"),  # menta + pêssego
    ("#c3aed6", "#ffe3a3"),  # lavanda + creme
    ("#8ecae6", "#ffb4a2"),  # azul + coral
    ("#b8e0d2", "#f6dfeb"),  # verde água + rosa
]


def gerar_fundo_local(duracao: int = 90) -> str:
    """Cria um fundo animado 1080×1920 com FFmpeg — sem banco de imagens.

    Bancos genéricos (Pexels) são dominados por gente e cenas aleatórias: num
    canal infantil isso vira adulto em cena e fundo sem relação com o assunto.
    Um gradiente suave em movimento mantém o mascote como protagonista e nunca
    traz conteúdo inesperado.
    """
    ffmpeg = os.getenv("FFMPEG_PATH", "ffmpeg")
    caminho = ASSETS_DIR / "background_video.mp4"
    c1, c2 = random.choice(PALETAS_FUNDO)

    console.print(f"[bold magenta][FUNDO][/bold magenta] Gerando gradiente animado {c1} → {c2}...")

    # gradients: gradiente animado; noise leve evita banding em telas grandes
    filtro = (
        f"gradients=s=1080x1920:c0={c1}:c1={c2}:x0=0:y0=0:x1=1080:y1=1920:"
        f"speed=0.02:d={duracao},format=yuv420p,noise=alls=6:allf=t"
    )
    cmd = [
        ffmpeg, "-v", "error", "-y",
        "-f", "lavfi", "-i", filtro,
        "-t", str(duracao), "-r", "30",
        "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
        str(caminho),
    ]
    subprocess.run(cmd, check=True, timeout=300)
    console.print(f"[bold green][FUNDO][/bold green] Fundo gerado: {caminho.name}")
    return str(caminho)


def obter_fundo(tema: str = None) -> str:
    """Escolhe a fonte do fundo: 'gerado' (padrão) ou 'pexels'.

    Trocar para o Pexels: INFANTIL_BACKGROUND=pexels no .env.
    """
    fonte = os.getenv("INFANTIL_BACKGROUND", "gerado").strip().lower()
    if fonte == "pexels":
        try:
            return baixar_video_satisfatorio(tema)
        except Exception as e:
            console.print(f"[yellow][FUNDO] Pexels falhou ({e}) — caindo para fundo gerado.[/yellow]")
    return gerar_fundo_local()


def baixar_video_satisfatorio(tema: str = None) -> str:
    if not PEXELS_API_KEY:
        raise ValueError("PEXELS_API_KEY não encontrada no .env!")

    console.print("[bold magenta][PEXELS][/bold magenta] Buscando vídeo de fundo vertical...")

    headers = {"Authorization": PEXELS_API_KEY}
    # 1º as palavras do tema (fundo coerente com a narração);
    # 2º B-roll de textura como rede de segurança.
    do_tema = _queries_do_tema(tema)
    if do_tema:
        console.print(f"[dim][PEXELS] Queries do tema: {do_tema}[/dim]")
    queries = do_tema + random.sample(QUERIES_SATISFATORIOS, len(QUERIES_SATISFATORIOS))

    for query in queries:
        console.print(f"[dim][PEXELS] Query: '{query}'[/dim]")
        try:
            resp = requests.get(
                "https://api.pexels.com/videos/search",
                headers=headers,
                params={"query": query, "orientation": "portrait", "per_page": 15, "min_duration": 60},
                timeout=15,
            )
            if not resp.ok:
                console.print(f"[yellow][PEXELS] HTTP {resp.status_code}[/yellow]")
                continue

            videos = resp.json().get("videos", [])
            random.shuffle(videos)

            for video in videos:
                if _tem_pessoas(video):
                    console.print(f"[dim][PEXELS] Pulando (tem pessoas): {video.get('url','')[:70]}[/dim]")
                    continue

                # Ordena os arquivos: portrait primeiro, depois maior resolução.
                # A lógica antiga aceitava o primeiro arquivo da lista e podia
                # terminar com um landscape mesmo havendo portrait disponível.
                arquivos = video.get("video_files", [])
                if not arquivos:
                    continue
                arquivos.sort(
                    key=lambda vf: (
                        0 if vf.get("height", 0) > vf.get("width", 1) else 1,
                        -(vf.get("height", 0) * vf.get("width", 0)),
                    )
                )
                melhor = arquivos[0]

                url = melhor["link"]
                caminho = ASSETS_DIR / "background_video.mp4"
                w, h, dur = melhor.get("width", 0), melhor.get("height", 0), video.get("duration", 0)
                console.print(f"[bold magenta][PEXELS][/bold magenta] Baixando {w}×{h} ({dur}s) — '{query}'...")

                r = requests.get(url, timeout=180, stream=True)
                r.raise_for_status()
                total = int(r.headers.get("content-length", 0))
                baixado = 0

                with open(caminho, "wb") as f:
                    for chunk in r.iter_content(chunk_size=65536):
                        f.write(chunk)
                        baixado += len(chunk)
                        if total:
                            pct = baixado / total * 100
                            console.print(f"[dim][PEXELS] {pct:.0f}% ({baixado // 1024 // 1024:.1f}MB)[/dim]", end="\r")

                console.print(f"\n[bold green][PEXELS][/bold green] Vídeo salvo ({baixado // 1024 // 1024:.1f}MB): {caminho}")
                return str(caminho)

        except Exception as e:
            console.print(f"[yellow][PEXELS] Query '{query}' falhou: {e}[/yellow]")

    raise RuntimeError("Nenhum vídeo encontrado no Pexels. Verifique PEXELS_API_KEY e conexão.")


# ─────────────────────────────────────────────────────────────────────────
# PASSO 3 — IMAGENS DO PERSONAGEM VIA POLLINATIONS.AI (gratuito, sem token)
# ─────────────────────────────────────────────────────────────────────────
# Seed única por execução — garante o mesmo personagem em todas as cenas
SEED_PERSONAGEM = random.randint(1, 999999)


def _pollinations(prompt: str, caminho: Path) -> bool:
    """Tenta gerar imagem via Pollinations.ai (flux → turbo → sem model)."""
    prompt_enc = urllib.parse.quote(prompt[:350])
    # Seed fixa por execução: sem isto cada cena sorteava uma seed diferente e
    # o "mesmo" personagem saía com aparência distinta a cada imagem.
    seed = SEED_PERSONAGEM
    base = f"https://image.pollinations.ai/prompt/{prompt_enc}?width=512&height=512&nologo=true&seed={seed}"

    for modelo in ["flux", "turbo", ""]:
        url = base + (f"&model={modelo}" if modelo else "")
        try:
            console.print(
                f"[dim][POLLINATIONS] model={modelo or 'default'}...[/dim]",
                end="\r",
            )
            r = requests.get(url, timeout=15)
            if r.status_code in (429, 500, 503):
                espera = 10 if r.status_code == 429 else 2
                console.print(
                    f"[yellow][POLLINATIONS] HTTP {r.status_code} — aguardando {espera}s...[/yellow]"
                )
                time.sleep(espera)
                continue
            r.raise_for_status()
            if len(r.content) < 2000:
                raise ValueError(f"Resposta suspeita ({len(r.content)}B)")
            caminho.write_bytes(r.content)
            return True
        except Exception as e:
            console.print(f"[yellow][POLLINATIONS] {str(e)[:70]}[/yellow]")

    return False


def _pexels_imagem_fallback(query: str, caminho: Path) -> bool:
    """Fallback: baixa imagem temática portrait do Pexels quando Pollinations falha."""
    if not PEXELS_API_KEY:
        return False
    try:
        headers = {"Authorization": PEXELS_API_KEY}
        r = requests.get(
            "https://api.pexels.com/v1/search",
            headers=headers,
            params={"query": query, "per_page": 10, "orientation": "portrait"},
            timeout=15,
        )
        r.raise_for_status()
        fotos = r.json().get("photos", [])
        if not fotos:
            return False
        foto = random.choice(fotos[:5])
        url = foto["src"].get("large", foto["src"]["original"])
        img_r = requests.get(url, timeout=30)
        img_r.raise_for_status()
        caminho.write_bytes(img_r.content)
        console.print(f"[dim][PEXELS IMG] Fallback OK: {caminho.name}[/dim]")
        return True
    except Exception as e:
        console.print(f"[yellow][PEXELS IMG] Fallback falhou: {e}[/yellow]")
        return False


def _gerar_uma_imagem(prompt: str, caminho: Path, query_fallback: str = "cute animal cartoon") -> bool:
    """
    Gera a imagem do personagem via Pollinations.ai, com nova tentativa.

    O fallback para FOTO do Pexels foi desativado por padrão: ele trocava o
    mascote ilustrado por um animal real (um "esquilinho laranja" virava foto de
    coelho cinza), quebrando a identidade do personagem. Reative com
    INFANTIL_FOTO_FALLBACK=true se algum dia fizer sentido.
    """
    if _pollinations(prompt, caminho):
        return True

    console.print("[yellow][IMG] Pollinations falhou — tentando mais uma vez...[/yellow]")
    time.sleep(4)
    if _pollinations(prompt, caminho):
        return True

    if os.getenv("INFANTIL_FOTO_FALLBACK", "false").strip().lower() == "true":
        console.print(f"[yellow][IMG] Fallback de foto ativado → Pexels ('{query_fallback}')[/yellow]")
        return _pexels_imagem_fallback(query_fallback, caminho)

    return False


# Limiares do recorte de fundo (claro + dessaturado = fundo)
LUM_FUNDO = int(os.getenv("INFANTIL_RECORTE_LUM", "175"))
SAT_FUNDO = int(os.getenv("INFANTIL_RECORTE_SAT", "65"))


def _recortar_fundo(caminho: Path) -> bool:
    """Deixa transparente o fundo claro da imagem do personagem.

    Sem isto, cada cena aparecia dentro de um retângulo branco visível sobre o
    gradiente do vídeo. A remoção considera claro+dessaturado como fundo, mas
    só apaga a região CONECTADA ÀS BORDAS — assim brilhos brancos dentro do
    personagem (olhos, dentes) continuam opacos.
    """
    try:
        from PIL import Image, ImageFilter

        img = Image.open(caminho).convert("RGBA")
        w, h = img.size
        px = img.load()

        def eh_fundo(x, y):
            r, g, b, _ = px[x, y]
            return (r + g + b) / 3 > LUM_FUNDO and (max(r, g, b) - min(r, g, b)) < SAT_FUNDO

        # BFS a partir das bordas: só o fundo conectado vira transparente
        marcado = bytearray(w * h)
        fila = []
        for x in range(w):
            for y in (0, h - 1):
                if eh_fundo(x, y) and not marcado[y * w + x]:
                    marcado[y * w + x] = 1
                    fila.append((x, y))
        for y in range(h):
            for x in (0, w - 1):
                if eh_fundo(x, y) and not marcado[y * w + x]:
                    marcado[y * w + x] = 1
                    fila.append((x, y))

        while fila:
            x, y = fila.pop()
            for dx, dy in ((1, 0), (-1, 0), (0, 1), (0, -1)):
                nx, ny = x + dx, y + dy
                if 0 <= nx < w and 0 <= ny < h and not marcado[ny * w + nx] and eh_fundo(nx, ny):
                    marcado[ny * w + nx] = 1
                    fila.append((nx, ny))

        mascara = Image.new("L", (w, h), 255)
        mp = mascara.load()
        for i, m in enumerate(marcado):
            if m:
                mp[i % w, i // w] = 0
        mascara = mascara.filter(ImageFilter.GaussianBlur(1.2))  # borda suave
        img.putalpha(mascara)
        img.save(caminho, "PNG")
        return True
    except Exception as e:
        console.print(f"[yellow][IMG] Recorte de fundo falhou ({str(e)[:60]}) — mantendo original.[/yellow]")
        return False


def _criar_placeholder_colorido(caminho: Path, indice: int):
    """Cria uma imagem placeholder colorida quando Pollinations falha."""
    cores = [
        (255, 107, 107), (78, 205, 196), (69, 183, 209),
        (150, 206, 180), (255, 234, 167),
    ]
    try:
        from PIL import Image, ImageDraw
        cor = cores[indice % len(cores)]
        img = Image.new("RGB", (512, 512), cor)
        draw = ImageDraw.Draw(img)
        draw.ellipse([106, 106, 406, 406], fill=(255, 255, 255), outline=(50, 50, 50), width=8)
        img.save(str(caminho), "PNG")
    except ImportError:
        # Fallback mínimo: PNG 1×1 branco
        import struct, zlib

        def _chunk(ct, data):
            c = ct + data
            return struct.pack(">I", len(data)) + c + struct.pack(">I", zlib.crc32(c) & 0xFFFFFFFF)

        with open(caminho, "wb") as f:
            f.write(b"\x89PNG\r\n\x1a\n")
            f.write(_chunk(b"IHDR", struct.pack(">IIBBBBB", 1, 1, 8, 2, 0, 0, 0)))
            f.write(_chunk(b"IDAT", zlib.compress(b"\x00\xff\xff\xff")))
            f.write(_chunk(b"IEND", b""))


def gerar_imagens_personagem(prompts: list, prompt_base: str, personagem: str = "") -> list:
    """
    Gera imagens do personagem. Tenta Pollinations.ai; fallback automático para Pexels.
    """
    console.print(f"[bold blue][IMG][/bold blue] Gerando {len(prompts)} imagens do personagem...")

    # Monta query de fallback para Pexels com base no tipo de animal
    animais_map = {
        "gat": "cute cat", "cach": "cute dog", "coelh": "cute bunny rabbit",
        "urso": "cute bear", "panda": "cute panda", "pingu": "cute penguin",
        "raposa": "cute fox", "esquil": "cute squirrel", "hamster": "cute hamster",
        "tartaruga": "cute turtle", "patinho": "cute duck", "elefant": "cute elephant",
        "passarin": "cute bird",
    }
    query_fallback = "cute cartoon animal"
    for chave, valor in animais_map.items():
        if chave in personagem.lower():
            query_fallback = valor
            break

    caminhos = []
    with Progress(
        TextColumn("[bold blue][IMG][/bold blue]"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        TextColumn("• {task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("Iniciando...", total=len(prompts))

        for i, prompt in enumerate(prompts):
            progress.update(task, description=f"Imagem {i + 1}/{len(prompts)}")
            caminho = CHAR_DIR / f"char_{i:02d}.png"

            # A descrição-base entra em toda cena: o modelo não "esquece" quem é
            # o personagem entre uma imagem e outra.
            prompt_completo = (
                f"{prompt_base}, {prompt}, children book illustration, "
                f"cute cartoon style, vibrant colors, plain white background, "
                f"same character in every image, full body"
            )
            sucesso = _gerar_uma_imagem(prompt_completo, caminho, query_fallback)

            if sucesso:
                _recortar_fundo(caminho)
            else:
                console.print(f"[red][IMG] Imagem {i + 1} falhou — usando placeholder[/red]")
                _criar_placeholder_colorido(caminho, i)

            caminhos.append(str(caminho))
            progress.advance(task)

            if i < len(prompts) - 1:
                time.sleep(2)

    console.print(f"[bold green][IMG][/bold green] {len(caminhos)} imagens prontas em assets/character_images/")
    return caminhos


# ─────────────────────────────────────────────────────────────────────────
# PASSO 4 — ÁUDIO TTS VIA EDGE-TTS
# ─────────────────────────────────────────────────────────────────────────
async def _tts_async(texto: str, caminho: str):
    import edge_tts
    communicate = edge_tts.Communicate(texto, voice="pt-BR-FranciscaNeural")
    await communicate.save(caminho)


def gerar_audio_tts(narracao: str) -> tuple:
    """Gera narração TTS e retorna (caminho_mp3, duracao_em_segundos)."""
    from mutagen.mp3 import MP3 as MutagenMP3

    console.print("[bold magenta][TTS][/bold magenta] Gerando narração (pt-BR-FranciscaNeural)...")

    caminho = str(ASSETS_DIR / "audio.mp3")
    with console.status("[bold magenta]Processando TTS...[/bold magenta]", spinner="dots"):
        asyncio.run(_tts_async(narracao, caminho))

    duracao = round(MutagenMP3(caminho).info.length, 3)
    console.print(f"[bold green][TTS][/bold green] Áudio gerado: {duracao}s → {caminho}")
    return caminho, duracao


# ─────────────────────────────────────────────────────────────────────────
# PASSO 5 — ARQUIVO DE LEGENDAS SRT
# ─────────────────────────────────────────────────────────────────────────
def _seg_para_srt(s: float) -> str:
    """Converte segundos para formato SRT: HH:MM:SS,mmm"""
    h = int(s // 3600)
    m = int((s % 3600) // 60)
    sec = s % 60
    return f"{h:02d}:{m:02d}:{sec:06.3f}".replace(".", ",")


def gerar_srt(narracao: str, duracao_s: float) -> str:
    """Gera arquivo SRT com grupos de palavras distribuídos pela duração."""
    words = narracao.split()
    group_size = 5
    groups = [words[i: i + group_size] for i in range(0, len(words), group_size)]
    if not groups:
        return str(ASSETS_DIR / "subtitles.srt")

    time_per_group = duracao_s / len(groups)
    caminho = ASSETS_DIR / "subtitles.srt"
    linhas = []

    for i, group in enumerate(groups):
        start = i * time_per_group
        end = min((i + 1) * time_per_group, duracao_s)
        linhas.append(str(i + 1))
        linhas.append(f"{_seg_para_srt(start)} --> {_seg_para_srt(end)}")
        linhas.append(" ".join(group))
        linhas.append("")

    caminho.write_text("\n".join(linhas), encoding="utf-8")
    console.print(f"[bold green][SRT][/bold green] {len(groups)} legendas geradas → {caminho}")
    return str(caminho)


# ─────────────────────────────────────────────────────────────────────────
# PASSO 6 — SALVAR METADATA.JSON
# ─────────────────────────────────────────────────────────────────────────
def _gerar_legendas_lista(narracao: str, duracao_s: float) -> list:
    """Gera lista de legendas {inicio, fim, texto} a partir da narração."""
    words = narracao.split()
    group_size = 5
    groups = [words[i: i + group_size] for i in range(0, len(words), group_size)]
    if not groups:
        return []
    time_per = duracao_s / len(groups)
    return [
        {
            "inicio": round(i * time_per, 3),
            "fim":    round(min((i + 1) * time_per, duracao_s), 3),
            "texto":  " ".join(group),
        }
        for i, group in enumerate(groups)
    ]


def salvar_metadata(
    roteiro: dict,
    caminho_video_bg: str,
    caminhos_personagem: list,
    caminho_audio: str,
    caminho_srt: str,
    duracao_audio_s: float,
) -> dict:
    legendas = _gerar_legendas_lista(roteiro["narracao"], duracao_audio_s)
    payload = {
        "personagem":          roteiro["personagem"],
        "problema":            roteiro["problema"],
        "solucao":             roteiro["solucao"],
        "titulo":              roteiro["titulo"],
        "descricao":           roteiro["descricao"],
        "tags":                roteiro["tags"],
        "narracao":            roteiro["narracao"],
        "personagem_prompt_base": roteiro["personagem_prompt_base"],
        "caminho_video_bg":    caminho_video_bg,
        "caminhos_personagem": caminhos_personagem,
        "caminho_audio":       caminho_audio,
        "caminho_srt":         caminho_srt,
        "duracao_audio_s":     duracao_audio_s,
        "legendas":            legendas,
    }
    caminho = ASSETS_DIR / "metadata.json"
    caminho.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    console.print(
        f"[bold green][META][/bold green] metadata.json salvo — "
        f"{duracao_audio_s:.1f}s de áudio, {len(caminhos_personagem)} imagens"
    )
    return payload


# ─────────────────────────────────────────────────────────────────────────
# PONTO DE ENTRADA PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────
def generate(tema: str = None) -> dict:
    if not tema:
        tema = trending.get_tema()

    console.rule("[bold cyan]MOTOR DE ROTEIRO BRAIN ROT — INICIADO[/bold cyan]")
    console.print(f"[dim]Tema: {tema}[/dim]")

    # 1. Roteiro via Groq
    roteiro = gerar_roteiro(tema)

    # 2. Vídeo satisfatório via Pexels
    caminho_video_bg = obter_fundo(tema)

    # 3. Imagens do personagem (Pollinations → fallback Pexels)
    caminhos_personagem = gerar_imagens_personagem(
        roteiro["prompts_imagem"],
        roteiro["personagem_prompt_base"],
        roteiro["personagem"],
    )

    # 4. Narração TTS
    caminho_audio, duracao_audio_s = gerar_audio_tts(roteiro["narracao"])

    # 5. Legendas SRT
    caminho_srt = gerar_srt(roteiro["narracao"], duracao_audio_s)

    # 6. Metadata.json
    metadata = salvar_metadata(
        roteiro,
        caminho_video_bg,
        caminhos_personagem,
        caminho_audio,
        caminho_srt,
        duracao_audio_s,
    )

    console.rule("[bold green]MOTOR DE ROTEIRO BRAIN ROT — CONCLUÍDO[/bold green]")
    return metadata


if __name__ == "__main__":
    generate()
