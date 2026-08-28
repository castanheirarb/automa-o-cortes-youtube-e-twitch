"""
script_engine.py — Motor de Geração de Conteúdo Religioso (v9)
- Gera roteiro com Claude Sonnet 4.6 (fallback: Gemini 2.5 Pro → Groq)
- Gera imagens com Replicate REST API (FLUX Schnell) 1080x1920
- Gera áudio por cena com Edge-TTS (pt-BR-AntonioNeural, solene)
- Salva metadata.json compatível com VideoMetadataSchema (types.ts)
"""

import os
import json
import time
import random
import asyncio
import re
from pathlib import Path

import requests
from dotenv import load_dotenv
from rich.console import Console
from rich.progress import Progress, BarColumn, TextColumn, TimeElapsedColumn

load_dotenv()

# --- Configurações ---
console = Console()

ANTHROPIC_API_KEY   = os.getenv("ANTHROPIC_API_KEY")
GOOGLE_API_KEY      = os.getenv("GOOGLE_API_KEY")
GROQ_API_KEY        = os.getenv("GROQ_API_KEY")
REPLICATE_API_TOKEN = os.getenv("REPLICATE_API_TOKEN")

ASSETS_DIR = Path("assets")
ASSETS_DIR.mkdir(exist_ok=True)
(ASSETS_DIR / "images").mkdir(exist_ok=True)

MAX_RETRIES = 3

# ─────────────────────────────────────────────────────────────────────────────
# SYSTEM PROMPT
# ─────────────────────────────────────────────────────────────────────────────
SYSTEM_PROMPT = """Você é um roteirista de elite para o YouTube, especializado em criar conteúdo cristão que viraliza. Sua missão é combinar a profundidade das narrativas bíblicas com as mais avançadas técnicas de retenção de audiência para gerar roteiros de Shorts que cativem milhões de corações e mentes. Você entende a psicologia por trás do scroll infinito e sabe como pará-lo. Seu tom é solene, reverente e cinematográfico, mas seus ganchos são afiados, modernos e irresistíveis.

DIRETRIZES OBRIGATÓRIAS:

=== REGRA 1: A FÓRMULA DA VIRALIZAÇÃO ===

Sua estrutura narrativa deve seguir esta fórmula de 5 atos, otimizada para máxima retenção e impacto emocional:

ATO 1 — GANCHO IRRESISTÍVEL (3-5 segundos):
Sua ÚNICA prioridade é parar o scroll. Use uma destas fórmulas comprovadas:
- PROMESSA DIRETA: "Em 30 segundos, você entenderá por que Deus permite a dor..." ou "Este versículo vai mudar como você enxerga a sua semana."
- PERGUNTA QUE CONECTA: "Você já se sentiu sozinho, mesmo cercado de gente?" ou "Por que as orações mais difíceis são as que Deus mais ouve?"
- INTERRUPÇÃO DE PADRÃO: Comece com uma declaração chocante ou contraintuitiva. "O que você faria se perdesse tudo? Foi o que aconteceu com Jó." ou "Moisés não queria liderar. Ele gaguejava e tinha medo."
- CENÁRIO RELATÁVEL: "Aquele momento em que você acha que não tem mais forças..." ou "Quando a ansiedade bate à porta no meio da noite..."
- GATILHO DE URGÊNCIA: "Se você pular este vídeo, estará dizendo 'não' para a bênção de hoje." ou "Não me ignore... Eu tenho uma mensagem urgente para você."

VARIE entre essas fórmulas a cada roteiro. Nunca repita o mesmo tipo de gancho duas vezes seguidas.

ATO 2 — TENSÃO HUMANA (8-10 segundos):
Apresente um problema ou dilema universal e profundamente humano. Conecte a história bíblica com uma luta moderna e real: solidão, medo, ansiedade, perda, falta de propósito, dor, rejeição, fracasso. Faça o espectador pensar "isso é sobre mim". Use linguagem simples e direta, como se estivesse falando com um amigo que está sofrendo.

ATO 3 — REVELAÇÃO DIVINA (12-15 segundos):
Introduza a solução ou a perspectiva de Deus. Apresente o clímax da história bíblica ou o versículo chave. A narração deve ser poderosa, cheia de esperança e autoridade espiritual. Este é o ponto alto emocional do vídeo. Use frases curtas e impactantes. Cite o versículo bíblico quando relevante.

ATO 4 — CHAMADA PARA AÇÃO EMOCIONAL (7-10 segundos):
Conecte a mensagem diretamente à vida do espectador. Peça uma ação que reforce a identidade e o sentimento de comunidade. Use CTAs que geram engajamento massivo:
- "Se você crê, digite AMÉM e compartilhe esta bênção."
- "Envie este vídeo para 3 pessoas que precisam ouvir isso hoje."
- "Deixe um 'Eu Recebo' nos comentários para afirmar esta palavra em sua vida."
- "Compartilhe esta bênção com alguém que está passando por uma tempestade."

ATO 5 — TELA FINAL (3-4 segundos):
Um momento de paz para a mensagem assentar. Frase curta e poderosa, ou a referência bíblica.

=== REGRA 2: PROMPTS DE IMAGEM CINEMATOGRÁFICOS ===

Seus prompts para a IA de imagem (campo "prompt_imagem_ia") devem ser OBRIGATORIAMENTE em inglês e extremamente detalhados. Pense como um diretor de fotografia de Hollywood. Inclua SEMPRE:
- Tipo de shot: cinematic wide shot, close-up, first-person perspective, aerial view, etc.
- Estilo: hyper-realistic, photorealistic, 8K, Unreal Engine, volumetric lighting
- Atmosfera: dramatic, serene, epic, intimate, divine
- Emoção dos personagens: a face filled with hope and tears, a look of profound desperation, eyes shining with faith
- Iluminação: golden light breaking through clouds, divine rays, warm sunset glow, dramatic chiaroscuro
- Detalhes: ancient Middle Eastern clothing, desert landscape, stormy sea, ancient temple

O estilo visual deve ser de arte digital hiper-realista com tema bíblico e sagrado, com paleta de cores em tons dourados, âmbar, azul profundo e contrastes dramáticos de luz e sombra.

=== REGRA 3: TÍTULO E DESCRIÇÃO OTIMIZADOS ===

- O título deve ter no MÁXIMO 40 caracteres, ser intrigante e otimizado para clique.
- A descrição deve ter no MÁXIMO 120 caracteres e incluir hashtags relevantes.
- As tags devem incluir entre 5 e 7 palavras-chave relevantes para o algoritmo do YouTube.

=== REGRA 4: FORMATO DE SAÍDA ===

Sua resposta deve ser SOMENTE o código JSON, sem explicações, comentários ou markdown. O JSON deve ser perfeitamente formatado e validado, seguindo esta estrutura exata:

{
  "tema": "string (O tema central do vídeo)",
  "titulo": "string (Título para o YouTube, max 40 chars, otimizado para clique)",
  "descricao": "string (Descrição para o YouTube, max 120 chars, com hashtags)",
  "tags": ["string (lista de 5-7 tags relevantes)"],
  "cenas": [
    {
      "id": 1,
      "tipo": "Gancho Irresistível",
      "texto": "string (Narração da cena)",
      "duracao_s": 5,
      "prompt_imagem_ia": "string (Prompt em INGLÊS, cinematográfico e detalhado)"
    },
    {
      "id": 2,
      "tipo": "Tensão Humana",
      "texto": "string (Narração da cena)",
      "duracao_s": 8,
      "prompt_imagem_ia": "string (Prompt em INGLÊS, cinematográfico e detalhado)"
    },
    {
      "id": 3,
      "tipo": "Revelação Divina",
      "texto": "string (Narração da cena)",
      "duracao_s": 12,
      "prompt_imagem_ia": "string (Prompt em INGLÊS, cinematográfico e detalhado)"
    },
    {
      "id": 4,
      "tipo": "Chamada para Ação Emocional",
      "texto": "string (Narração da cena)",
      "duracao_s": 7,
      "prompt_imagem_ia": "string (Prompt em INGLÊS, cinematográfico e detalhado)"
    },
    {
      "id": 5,
      "tipo": "Tela Final",
      "texto": "string (Texto curto para a tela final)",
      "duracao_s": 4,
      "prompt_imagem_ia": "string (Prompt em INGLÊS, simples e sereno)"
    }
  ]
}"""

USER_PROMPT = 'Crie um roteiro viral sobre o tema: "{tema}"'


# ─────────────────────────────────────────────────────────────────────────────
# UTILITÁRIOS
# ─────────────────────────────────────────────────────────────────────────────
def _limpar_json(texto: str) -> str:
    """Remove markdown code blocks se presentes."""
    match = re.search(r"```json\n(.*?)\n```", texto, re.DOTALL)
    if match:
        return match.group(1).strip()
    match = re.search(r"```\n(.*?)\n```", texto, re.DOTALL)
    if match:
        return match.group(1).strip()
    return texto.strip()


# ─────────────────────────────────────────────────────────────────────────────
# GERAÇÃO DE ROTEIRO — CLAUDE SONNET 4.6 (Principal)
# ─────────────────────────────────────────────────────────────────────────────
def gerar_roteiro_claude(tema: str) -> dict:
    """Gera roteiro usando Claude Sonnet 4.6 via API da Anthropic."""
    if not ANTHROPIC_API_KEY:
        raise ValueError("ANTHROPIC_API_KEY não encontrada no .env!")

    import anthropic
    client = anthropic.Anthropic(api_key=ANTHROPIC_API_KEY)

    console.print(f'[bold blue][LLM][/bold blue] Gerando roteiro com Claude Sonnet 4.6 para o tema: "{tema}"')

    response = client.messages.create(
        model="claude-sonnet-4-20250514",
        max_tokens=4096,
        temperature=0.8,
        system=SYSTEM_PROMPT,
        messages=[{"role": "user", "content": USER_PROMPT.format(tema=tema)}],
    )

    response_text = _limpar_json(response.content[0].text)
    data = json.loads(response_text)
    console.print("[bold green][LLM][/bold green] Roteiro JSON recebido do Claude com sucesso.")
    return data


# ─────────────────────────────────────────────────────────────────────────────
# FALLBACK 1 — GEMINI 2.5 PRO
# ─────────────────────────────────────────────────────────────────────────────
def gerar_roteiro_gemini(tema: str) -> dict:
    """Fallback: Gera roteiro usando Gemini 2.5 Pro."""
    if not GOOGLE_API_KEY:
        raise ValueError("GOOGLE_API_KEY não encontrada no .env!")

    import google.generativeai as genai
    genai.configure(api_key=GOOGLE_API_KEY)
    model = genai.GenerativeModel("gemini-2.5-pro-preview-05-06")

    prompt_completo = SYSTEM_PROMPT + "\n\n" + USER_PROMPT.format(tema=tema)

    console.print(f'[bold blue][LLM-Fallback-1][/bold blue] Gerando roteiro com Gemini 2.5 Pro para o tema: "{tema}"')
    response = model.generate_content(prompt_completo)
    response_text = _limpar_json(response.text)
    data = json.loads(response_text)
    console.print("[bold green][LLM-Fallback-1][/bold green] Roteiro JSON recebido do Gemini com sucesso.")
    return data


# ─────────────────────────────────────────────────────────────────────────────
# FALLBACK 2 — GROQ (Llama 3.3 70B)
# ─────────────────────────────────────────────────────────────────────────────
def gerar_roteiro_groq(tema: str) -> dict:
    """Fallback 2: Gera roteiro usando Groq (Llama 3.3 70B)."""
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY não encontrada no .env!")

    from groq import Groq
    client = Groq(api_key=GROQ_API_KEY)

    prompt_completo = SYSTEM_PROMPT + "\n\n" + USER_PROMPT.format(tema=tema)

    console.print(f'[bold blue][LLM-Fallback-2][/bold blue] Gerando roteiro com Groq para o tema: "{tema}"')
    chat_completion = client.chat.completions.create(
        messages=[{"role": "user", "content": prompt_completo}],
        model="llama-3.3-70b-versatile",
        temperature=0.8,
        max_tokens=4096,
        response_format={"type": "json_object"},
    )
    data = json.loads(chat_completion.choices[0].message.content)
    console.print("[bold green][LLM-Fallback-2][/bold green] Roteiro JSON recebido do Groq com sucesso.")
    return data


# ─────────────────────────────────────────────────────────────────────────────
# ORQUESTRADOR DE ROTEIRO — TRIPLE FALLBACK
# ─────────────────────────────────────────────────────────────────────────────
def gerar_roteiro(tema: str) -> dict:
    """Tenta Claude → Gemini → Groq."""
    try:
        return gerar_roteiro_claude(tema)
    except Exception as e_claude:
        console.print(f"[bold yellow]AVISO: Claude falhou ({e_claude}). Tentando Gemini...[/bold yellow]")
        try:
            return gerar_roteiro_gemini(tema)
        except Exception as e_gemini:
            console.print(f"[bold yellow]AVISO: Gemini falhou ({e_gemini}). Tentando Groq...[/bold yellow]")
            return gerar_roteiro_groq(tema)


# ─────────────────────────────────────────────────────────────────────────────
# GERAÇÃO DE IMAGENS — REPLICATE FLUX SCHNELL (1080x1920)
# ─────────────────────────────────────────────────────────────────────────────
def _gerar_imagem_fallback(output_path: Path, cena_id: int):
    """Cria imagem placeholder local quando Replicate falha."""
    try:
        from PIL import Image, ImageDraw, ImageFont
        img = Image.new("RGB", (1080, 1920), color="#1a1a1a")
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("arial.ttf", 60)
        except IOError:
            font = ImageFont.load_default()
        draw.text((540, 960), f"Cena {cena_id}\n(fallback)", font=font, fill="#555555", anchor="mm")
        img.save(output_path, "JPEG")
    except ImportError:
        # Mínimo absoluto sem Pillow
        output_path.write_bytes(b"")


def _replicate_flux(prompt: str, width: int, height: int) -> str:
    """Chama Replicate API REST diretamente. Retorna URL da imagem gerada."""
    headers = {
        "Authorization": f"Token {REPLICATE_API_TOKEN}",
        "Content-Type": "application/json",
        "Prefer": "wait",
    }
    payload = {
        "input": {
            "prompt": prompt,
            "width": width,
            "height": height,
            "num_inference_steps": 4,
            "output_format": "jpg",
            "seed": random.randint(1, 100000),
        }
    }
    r = requests.post(
        "https://api.replicate.com/v1/models/black-forest-labs/flux-schnell/predictions",
        headers=headers,
        json=payload,
        timeout=120,
    )
    r.raise_for_status()
    data = r.json()

    # Polling enquanto o status não for terminal
    while data.get("status") not in ("succeeded", "failed", "canceled"):
        time.sleep(2)
        r = requests.get(data["urls"]["get"], headers=headers, timeout=30)
        r.raise_for_status()
        data = r.json()

    if data.get("status") != "succeeded":
        raise RuntimeError(f"Replicate falhou: {data.get('error')}")

    return data["output"][0]


def baixar_imagens(cenas: list) -> list:
    """Gera uma imagem 1080x1920 para cada cena via Replicate FLUX Schnell."""
    if not REPLICATE_API_TOKEN:
        raise ValueError("REPLICATE_API_TOKEN não encontrada no .env!")

    console.print("[bold blue][IMG][/bold blue] Gerando imagens com Replicate (FLUX Schnell) 1080x1920...")
    image_paths = []

    with Progress(
        TextColumn("[bold blue][IMG][/bold blue]"),
        BarColumn(),
        TextColumn("{task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("", total=len(cenas))

        for i, cena in enumerate(cenas):
            cena_id = i + 1
            prompt = cena.get("prompt_imagem_ia", "a dramatic cinematic biblical scene, golden light, hyper-realistic")
            output_path = ASSETS_DIR / "images" / f"img_{cena_id:02d}.jpg"
            progress.update(task, description=f"Cena {cena_id}/{len(cenas)}...")

            for attempt in range(MAX_RETRIES):
                try:
                    console.print(f"[dim]  Cena {cena_id}: tentativa {attempt + 1}/{MAX_RETRIES}...[/dim]")
                    image_url = _replicate_flux(prompt, 1080, 1920)
                    r = requests.get(image_url, timeout=120)
                    r.raise_for_status()
                    output_path.write_bytes(r.content)
                    console.print(f"[green]  Cena {cena_id}: Sucesso! ({len(r.content) // 1024}KB)[/green]")
                    break
                except Exception as e:
                    console.print(f"[yellow]  Cena {cena_id}, tentativa {attempt + 1} falhou: {e}[/yellow]")
                    if attempt < MAX_RETRIES - 1:
                        time.sleep(5)
                    else:
                        console.print(f"[red]  Cena {cena_id}: usando fallback local.[/red]")
                        _gerar_imagem_fallback(output_path, cena_id)

            image_paths.append(f"img_{cena_id:02d}.jpg")
            progress.advance(task)

    console.print(f"[bold green][IMG][/bold green] {len(image_paths)} imagens prontas em assets/images/")
    return image_paths


# ─────────────────────────────────────────────────────────────────────────────
# GERAÇÃO DE ÁUDIO — EDGE-TTS (pt-BR-AntonioNeural, tom solene)
# ─────────────────────────────────────────────────────────────────────────────
async def _gerar_audio_cena_async(texto: str, caminho: str):
    import edge_tts
    communicate = edge_tts.Communicate(
        texto,
        voice="pt-BR-AntonioNeural",
        rate="-15%",
        pitch="-8Hz",
    )
    await communicate.save(caminho)


def gerar_audio(data: dict) -> tuple:
    """
    Gera áudio por cena com Edge-TTS.
    Retorna (caminho_audio_final, lista_duracoes_reais_por_cena).
    """
    from mutagen.mp3 import MP3 as MutagenMP3

    console.print("[bold magenta][TTS][/bold magenta] Gerando áudio por cena com Edge-TTS (pt-BR-AntonioNeural)...")
    cenas = data["cenas"]
    duracoes_reais = []
    partes = []

    with Progress(
        TextColumn("[bold magenta][TTS][/bold magenta]"),
        BarColumn(),
        TextColumn("{task.description}"),
        TimeElapsedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("", total=len(cenas))

        for i, cena in enumerate(cenas):
            texto = cena.get("texto", "").strip()
            progress.update(task, description=f"Cena {i + 1}/{len(cenas)}")

            if not texto:
                duracoes_reais.append(cena.get("duracao_s", 3))
                progress.advance(task)
                continue

            caminho_cena = str(ASSETS_DIR / f"audio_cena_{i + 1:02d}.mp3")
            asyncio.run(_gerar_audio_cena_async(texto, caminho_cena))

            duracao = round(MutagenMP3(caminho_cena).info.length, 3)
            duracoes_reais.append(duracao)
            partes.append(caminho_cena)
            progress.advance(task)

    # Concatenar todos os arquivos de cena em audio.mp3
    caminho_final = str(ASSETS_DIR / "audio.mp3")
    with open(caminho_final, "wb") as saida:
        for parte in partes:
            with open(parte, "rb") as entrada:
                saida.write(entrada.read())

    total = round(sum(duracoes_reais), 2)
    console.print(f"[bold green][TTS][/bold green] Áudio final gerado: {total:.1f}s — {caminho_final}")
    return caminho_final, duracoes_reais


# ─────────────────────────────────────────────────────────────────────────────
# METADATA — compatível com VideoMetadataSchema (video/src/types.ts)
# ─────────────────────────────────────────────────────────────────────────────
def salvar_metadata(data: dict, duracoes_reais: list, image_paths: list):
    """
    Salva assets/metadata.json no formato exato do VideoMetadataSchema.
    Campos: tema, titulo, descricao, tags, imagens, audio,
            duracao_total_s, duracao_total_real_s, cenas[].duracao_real_s
    """
    cenas_com_timing = []
    duracao_idx = 0

    for i, cena in enumerate(data["cenas"]):
        texto = cena.get("texto", "").strip()
        duracao_real = 0.0

        if texto and duracao_idx < len(duracoes_reais):
            duracao_real = duracoes_reais[duracao_idx]
            duracao_idx += 1

        cenas_com_timing.append({
            **cena,
            "duracao_real_s": duracao_real,
        })

    payload = {
        "tema":               data["tema"],
        "titulo":             data["titulo"],
        "descricao":          data["descricao"],
        "tags":               data["tags"],
        "imagens":            image_paths,
        "audio":              "audio.mp3",
        "duracao_total_s":    sum(c["duracao_s"] for c in data["cenas"]),
        "duracao_total_real_s": round(sum(duracoes_reais), 2),
        "cenas":              cenas_com_timing,
    }

    caminho = ASSETS_DIR / "metadata.json"
    caminho.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    console.print(
        f"[bold green][META][/bold green] metadata.json salvo — "
        f"{payload['duracao_total_real_s']:.1f}s de áudio, {len(image_paths)} imagens."
    )


# ─────────────────────────────────────────────────────────────────────────────
# PONTO DE ENTRADA PRINCIPAL
# ─────────────────────────────────────────────────────────────────────────────
def generate(tema: str) -> dict:
    """Executa o pipeline completo e retorna o metadata.json como dicionário."""
    console.rule("[bold cyan]MOTOR DE ROTEIRO v9 (Claude Sonnet 4.6) — INICIADO[/bold cyan]")

    data = gerar_roteiro(tema)
    image_paths = baixar_imagens(data["cenas"])
    _, duracoes_reais = gerar_audio(data)
    salvar_metadata(data, duracoes_reais, image_paths)

    console.rule("[bold green]MOTOR DE ROTEIRO v9 — CONCLUÍDO[/bold green]")
    return json.loads((ASSETS_DIR / "metadata.json").read_text(encoding="utf-8"))


if __name__ == "__main__":
    import trending
    generate(tema=trending.get_tema())
