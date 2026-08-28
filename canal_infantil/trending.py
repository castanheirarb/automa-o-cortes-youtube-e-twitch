"""
trending.py — Busca temas em alta e adapta para conteúdo infantil

Fluxo:
  1. pytrends  → trending searches Brasil (Google Trends, sem chave)
  2. Groq      → filtra/adapta os tópicos para conteúdo infantil educativo
  3. Fallback  → lista hardcoded se tudo falhar
"""

import os
import json
import random
from dotenv import load_dotenv
from rich.console import Console

load_dotenv()
console = Console()

GROQ_API_KEY = os.getenv("GROQ_API_KEY")

# ── Fallback caso todas as APIs falhem ───────────────────────────────────────
# ── Banco curado de temas educativos (fonte PRIMÁRIA) ────────────────────────
# Antes o tema saía do Google Trends Brasil "adaptado" pela IA para o público
# infantil. Tendências do Brasil são dominadas por política, crime, tragédia e
# celebridades — material péssimo (e arriscado) para um canal infantil, ainda
# mais sob as regras de conteúdo "feito para crianças" do YouTube. Agora a
# fonte primária é este banco curado; tendências só entram se passarem no
# filtro de segurança abaixo.
TEMAS_EDUCATIVOS = [
    # Animais
    "por que os camaleões mudam de cor",
    "como as abelhas fabricam o mel",
    "por que os gatos ronronam",
    "como os golfinhos conversam entre si",
    "por que os flamingos são cor-de-rosa",
    "como as formigas carregam coisas tão pesadas",
    "por que os elefantes têm tromba",
    "como os pinguins não sentem frio",
    "por que as girafas têm pescoço comprido",
    "como as aranhas fazem suas teias",
    "por que os cachorros abanam o rabo",
    "como as tartarugas encontram o caminho de casa",
    # Natureza e planeta
    "por que o céu é azul",
    "como se forma o arco-íris",
    "de onde vem a chuva",
    "por que os vulcões entram em erupção",
    "como as plantas comem a luz do sol",
    "por que as folhas mudam de cor no outono",
    "como se formam as nuvens",
    "por que o mar é salgado",
    # Espaço
    "por que a lua muda de forma",
    "como os astronautas dormem no espaço",
    "por que Saturno tem anéis",
    "o que são as estrelas cadentes",
    "por que o sol é tão quente",
    "quantos planetas existem no sistema solar",
    # Corpo humano
    "por que a gente espirra",
    "por que a gente boceja",
    "como o coração bombeia sangue",
    "por que ficamos com a pele enrugada na água",
    "para que servem os sonhos",
    "por que a gente tem soluço",
    # Dinossauros e história
    "como os dinossauros desapareceram",
    "qual era o maior dinossauro de todos",
    "como eram construídas as pirâmides do Egito",
    "como as pessoas viviam nas cavernas",
    # Invenções e curiosidades
    "quem inventou o sorvete",
    "como funciona um avião",
    "como a pipoca estoura",
    "por que o sabão faz bolhas",
    "como a internet leva vídeos até a sua casa",
]

# Retrocompatível: código antigo ainda referencia FALLBACK_TEMAS
FALLBACK_TEMAS = TEMAS_EDUCATIVOS

# ── Filtro de segurança para temas vindos de tendências ──────────────────────
# Qualquer tema que encoste nestes assuntos é descartado, por mais que a IA
# tenha tentado "adaptar" para criança.
TERMOS_BLOQUEADOS = [
    "morte", "morre", "morreu", "morto", "matou", "assassin", "crime", "homicid",
    "tiro", "arma", "violen", "guerra", "atentado", "acidente", "tragédia", "tragedia",
    "estupro", "abuso", "sequestr", "droga", "traficante", "prisão", "prisao", "preso",
    "político", "politico", "eleição", "eleicao", "presidente", "governo", "ministro",
    "sexo", "sexual", "nudez", "pelado", "aposta", "bet", "cassino", "álcool", "alcool",
    "cigarro", "suicíd", "suicid", "doença grave", "câncer", "cancer", "covid",
    "processo", "justiça", "polícia", "policia", "briga", "agressão", "agressao",
    "terror", "assombr", "fantasma", "demônio", "demonio", "satan",
]


def _tema_seguro(tema: str) -> bool:
    """True se o tema não encostar em nenhum assunto impróprio para crianças."""
    t = (tema or "").lower()
    return not any(bloq in t for bloq in TERMOS_BLOQUEADOS)


# ── PASSO 1: Google Trends Brasil via pytrends ───────────────────────────────
def _buscar_trending_google(n: int = 30) -> list[str]:
    """Retorna os n primeiros trending searches do Brasil."""
    try:
        from pytrends.request import TrendReq
        console.print("[bold blue][TRENDS][/bold blue] Buscando tendências no Google Brasil...")
        pytrends = TrendReq(hl="pt-BR", tz=180, timeout=(10, 25), retries=2, backoff_factor=0.5)
        df = pytrends.trending_searches(pn="brazil")
        termos = df[0].tolist()[:n]
        console.print(f"[bold green][TRENDS][/bold green] {len(termos)} termos em alta encontrados.")
        return termos
    except ImportError:
        console.print("[yellow][TRENDS] pytrends não instalado — rode: pip install pytrends[/yellow]")
        return []
    except Exception as e:
        console.print(f"[yellow][TRENDS] Google Trends falhou: {e}[/yellow]")
        return []


# ── PASSO 2: Groq filtra e adapta para conteúdo infantil ────────────────────
def _adaptar_com_groq(trending_terms: list[str]) -> list[str]:
    """
    Usa Groq para escolher os termos com mais potencial infantil/educativo
    e reescrevê-los como temas de história (ex: 'animais' → 'um urso tentando...').
    """
    if not GROQ_API_KEY:
        raise ValueError("GROQ_API_KEY não encontrada no .env!")

    from groq import Groq
    client = Groq(api_key=GROQ_API_KEY)

    lista_str = "\n".join(f"- {t}" for t in trending_terms)

    prompt = f"""Você é especialista em conteúdo infantil educativo para YouTube Shorts no Brasil.

Abaixo estão os assuntos mais pesquisados no Google Brasil agora:
{lista_str}

Sua tarefa:
1. Selecione os 5 assuntos com MAIOR potencial para virar uma história curta e fofa para crianças de 3-10 anos.
   Prefira temas relacionados a: animais, natureza, ciência simples, aventura, curiosidades.
   Evite: política, violência, celebridades adultas, esportes profissionais, notícias negativas.
2. Para cada assunto selecionado, reescreva como um TEMA DE HISTÓRIA no formato:
   "um [animal fofo] que [problema simples relacionado ao assunto]"

Retorne SOMENTE um JSON válido sem markdown:
{{
  "temas": [
    "tema 1 aqui",
    "tema 2 aqui",
    "tema 3 aqui",
    "tema 4 aqui",
    "tema 5 aqui"
  ]
}}"""

    console.print("[bold blue][GROQ][/bold blue] Adaptando tópicos em alta para conteúdo infantil...")
    resp = client.chat.completions.create(
        model="llama-3.3-70b-versatile",
        messages=[{"role": "user", "content": prompt}],
        temperature=0.7,
        max_tokens=512,
    )
    raw = resp.choices[0].message.content.strip()
    if raw.startswith("```"):
        raw = raw.split("```")[1]
        if raw.startswith("json"):
            raw = raw[4:]
        raw = raw.strip().rstrip("```").strip()

    data = json.loads(raw)
    temas = data["temas"]
    console.print(f"[bold green][GROQ][/bold green] {len(temas)} temas adaptados:")
    for t in temas:
        console.print(f"  [cyan]→[/cyan] {t}")
    return temas


# ── API PÚBLICA: YouTube RSS de tendências (sem chave) ──────────────────────
def _buscar_trending_youtube_rss() -> list[str]:
    """
    Lê o feed RSS público do YouTube Brasil (vídeos em alta) e extrai títulos.
    Não requer API key.
    """
    try:
        import xml.etree.ElementTree as ET
        import requests

        # Feed Atom público de tendências BR (Education + Entertainment)
        urls = [
            "https://www.youtube.com/feeds/videos.xml?chart=mostpopular&regionCode=BR&videoCategoryId=27",  # Education
            "https://www.youtube.com/feeds/videos.xml?chart=mostpopular&regionCode=BR&videoCategoryId=24",  # Entertainment
        ]
        titulos = []
        ns = {"atom": "http://www.w3.org/2005/Atom"}

        for url in urls:
            try:
                r = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
                if not r.ok:
                    continue
                root = ET.fromstring(r.content)
                for entry in root.findall("atom:entry", ns):
                    title_el = entry.find("atom:title", ns)
                    if title_el is not None and title_el.text:
                        titulos.append(title_el.text.strip())
            except Exception:
                continue

        if titulos:
            console.print(f"[bold green][YT-RSS][/bold green] {len(titulos)} títulos de tendências do YouTube.")
        return titulos[:20]
    except Exception as e:
        console.print(f"[yellow][YT-RSS] Falhou: {e}[/yellow]")
        return []


# ── PONTO DE ENTRADA ─────────────────────────────────────────────────────────
def get_tema() -> str:
    """
    Retorna um tema em alta adaptado para conteúdo infantil.
    Tenta: Google Trends + YouTube RSS → Groq adapta → fallback hardcoded.
    """
    console.rule("[bold cyan] ESCOLHENDO TEMA EDUCATIVO [/bold cyan]")

    # Fonte primária: banco curado. Tendências entram só na fração definida por
    # TRENDING_RATIO (padrão 0 = desligado) e ainda passam pelo filtro de segurança.
    ratio = float(os.getenv("INFANTIL_TRENDING_RATIO", "0"))
    if random.random() >= ratio:
        tema = random.choice(TEMAS_EDUCATIVOS)
        console.print(f"[bold green][TEMA][/bold green] Banco educativo: [yellow]{tema}[/yellow]")
        return tema

    # 1. Coletar termos de fontes externas
    termos = _buscar_trending_google(30)
    titulos_yt = _buscar_trending_youtube_rss()
    termos = termos + titulos_yt

    if not termos:
        console.print("[yellow][TRENDING] Nenhuma fonte externa funcionou — usando fallback.[/yellow]")
        return random.choice(FALLBACK_TEMAS)

    # Remove duplicatas e limita
    termos = list(dict.fromkeys(termos))[:40]

    # 2. Groq adapta para conteúdo infantil
    try:
        temas_adaptados = _adaptar_com_groq(termos)
        seguros = [t for t in (temas_adaptados or []) if _tema_seguro(t)]
        descartados = len(temas_adaptados or []) - len(seguros)
        if descartados:
            console.print(f"[yellow][TEMA] {descartados} tema(s) de tendência descartado(s) pelo filtro infantil.[/yellow]")
        if seguros:
            tema = random.choice(seguros)
            console.print(f"[bold green][TRENDING][/bold green] Tema escolhido: [yellow]{tema}[/yellow]")
            return tema
    except Exception as e:
        console.print(f"[yellow][TRENDING] Groq falhou: {e} — usando fallback.[/yellow]")

    return random.choice(FALLBACK_TEMAS)


if __name__ == "__main__":
    tema = get_tema()
    print(f"\nTema final: {tema}")
