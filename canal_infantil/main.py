"""
main.py — Orquestrador Principal do Pipeline Brain Rot Infantil v3
Loop contínuo: gera assets → compõe vídeo com FFmpeg → posta no YouTube → aguarda 4h.
Sem dependência do Remotion/Node.js. Usa FFmpeg para composição.

LEGENDAS: usa drawtext + textfile (funciona em QUALQUER build do FFmpeg).
NÃO usa filtro 'subtitles' nem 'ass' (requer libass, ausente em muitas builds Windows).
"""

import sys
import os
import json
import time
import random
import subprocess
import argparse
import shutil
from pathlib import Path
from datetime import datetime, timedelta

from rich.console import Console
from rich.panel import Panel
from rich.table import Table
from rich.progress import Progress, BarColumn, TextColumn, TimeRemainingColumn, SpinnerColumn
from rich import box

import script_engine
import youtube_studio_uploader

# Fix Windows terminal encoding
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Configurações ──────────────────────────────────────────────────────
console = Console()

OUTPUT_DIR = Path("output")
ASSETS_DIR = Path("assets")
OUTPUT_DIR.mkdir(exist_ok=True)

INTERVAL_HOURS = 4
INTERVAL_SECONDS = INTERVAL_HOURS * 3600
JITTER_SECONDS = 8 * 60  # ±8 minutos


# ═══════════════════════════════════════════════════════════════════════
# VERIFICAÇÃO DO FFMPEG
# ═══════════════════════════════════════════════════════════════════════
def verificar_ffmpeg() -> bool:
    """Verifica se o FFmpeg está instalado e acessível."""
    try:
        result = subprocess.run(
            ["ffmpeg", "-version"],
            capture_output=True,
            text=True,
            timeout=10,
        )
        if result.returncode == 0:
            versao = result.stdout.split("\n")[0]
            console.print(f"[bold green][FFMPEG][/bold green] {versao}")
            return True
    except FileNotFoundError:
        pass
    except Exception:
        pass

    console.print(
        "[bold red][FFMPEG] FFmpeg não encontrado![/bold red]\n"
        "  Instale com: sudo apt install ffmpeg (Linux)\n"
        "  Ou baixe de: https://www.gyan.dev/ffmpeg/builds/ (Windows)"
    )
    return False


# ═══════════════════════════════════════════════════════════════════════
# BANNER E LOGS
# ═══════════════════════════════════════════════════════════════════════
def banner(ciclo: int):
    hora = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    console.print()
    console.print(
        Panel(
            f"[bold yellow]  YouTube Shorts — Pipeline Brain Rot Infantil[/bold yellow]\n"
            f"[dim]Groq · Pexels · Pollinations.ai · FFmpeg · Playwright[/dim]\n\n"
            f"[bold]CICLO #{ciclo}[/bold]  |  [cyan]{hora}[/cyan]",
            border_style="bright_blue",
            box=box.DOUBLE_EDGE,
            expand=False,
        )
    )


def log_passo(num: int, total: int, titulo: str, emoji: str = "==>"):
    console.print()
    console.rule(
        f"[bold white] {emoji}  PASSO {num}/{total}: {titulo} [/bold white]",
        style="bright_blue",
    )


# ═══════════════════════════════════════════════════════════════════════
# COMPOSIÇÃO DE VÍDEO COM FFMPEG
# ═══════════════════════════════════════════════════════════════════════
def _escape_ffmpeg_path(path: str) -> str:
    """
    Escapa um caminho de arquivo para uso dentro do filter_complex do FFmpeg.
    No Windows: C:\\Users\\... → C\\:/Users/...
    """
    p = path.replace("\\", "/")
    p = p.replace(":", "\\:")
    return p


def _encontrar_fonte() -> str | None:
    """Tenta encontrar uma fonte bold no sistema."""
    candidatas = [
        "C:/Windows/Fonts/ariblk.ttf",
        "C:/Windows/Fonts/arialbd.ttf",
        "C:/Windows/Fonts/arial.ttf",
        "C:/Windows/Fonts/impact.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Bold.ttf",
    ]
    for f in candidatas:
        if Path(f).exists():
            console.print(f"[bold green][FFMPEG][/bold green] Fonte encontrada: {f}")
            return f
    console.print("[yellow][FFMPEG] Nenhuma fonte encontrada — logo será omitido[/yellow]")
    return None


def _criar_arquivos_legenda(legendas: list, legendas_dir: Path):
    """
    Cria um arquivo .txt para cada legenda.
    O drawtext do FFmpeg lê o texto via textfile= em vez de text=,
    eliminando 100% dos problemas de escape com acentos, vírgulas, etc.
    """
    legendas_dir.mkdir(parents=True, exist_ok=True)

    # Limpa arquivos antigos
    for old in legendas_dir.glob("leg_*.txt"):
        old.unlink()

    for i, leg in enumerate(legendas):
        texto = leg.get("texto", "").replace("\n", " ").replace("\r", "").strip()
        arquivo = legendas_dir / f"leg_{i:02d}.txt"
        arquivo.write_text(texto, encoding="utf-8")

    console.print(
        f"[bold green][LEGENDAS][/bold green] {len(legendas)} arquivos .txt criados em {legendas_dir}/"
    )


def compor_video_ffmpeg(metadata: dict) -> str:
    """
    Compõe o vídeo final com FFmpeg.
    Layout: vídeo satisfatório (fundo) + personagem (overlay inferior) + legendas + logo.

    LEGENDAS: cada legenda é um drawtext separado com textfile= e enable=between().
    NÃO usa filtro 'subtitles' nem 'ass' (incompatível com muitas builds Windows).

    REGRAS DO filter_complex:
      - Ponto-e-vírgula (;) = separa CADEIAS (streams diferentes)
      - Vírgula (,) = separa FILTROS na mesma cadeia (mesmo stream)
    """
    console.print("[bold magenta][FFMPEG][/bold magenta] Iniciando composição do vídeo...")

    bg_video = ASSETS_DIR / "background_video.mp4"
    audio_file = ASSETS_DIR / "audio.mp3"
    char_dir = ASSETS_DIR / "character_images"
    legendas_dir = ASSETS_DIR / "legendas"
    output = OUTPUT_DIR / "video_final.mp4"

    char_imgs = sorted(char_dir.glob("char_*.png"))
    if not bg_video.exists():
        raise FileNotFoundError(f"Vídeo de fundo não encontrado: {bg_video}")
    if not audio_file.exists():
        raise FileNotFoundError(f"Áudio não encontrado: {audio_file}")
    if not char_imgs:
        raise FileNotFoundError(f"Nenhuma imagem em {char_dir}")

    duracao = metadata.get("duracao_audio_s", 30)
    legendas = metadata.get("legendas", [])
    num_imgs = len(char_imgs)
    dur_img = duracao / num_imgs if num_imgs else duracao

    # 1. Criar arquivos de texto para cada legenda
    _criar_arquivos_legenda(legendas, legendas_dir)

    # 2. Encontrar fonte para logo e legendas
    fonte = _encontrar_fonte()
    if not fonte:
        console.print("[bold red][FFMPEG] Sem fonte — vídeo será gerado sem texto[/bold red]")

    # ──────────────────────────────────────────────────────────
    # 3. CONSTRUIR O FILTER_COMPLEX
    # ──────────────────────────────────────────────────────────
    chains = []

    # Cadeia 1: Escalar vídeo de fundo para 1080x1920
    chains.append(
        "[0:v]scale=1080:1920:force_original_aspect_ratio=increase,"
        "crop=1080:1920,setsar=1[bg]"
    )

    # Cadeias 2..N+1: Escalar imagens do personagem.
    # O mascote é o protagonista do canal — a 40% ele ficava como uma miniatura
    # perdida no rodapé, com o vídeo de fundo dominando a tela.
    char_scale = float(os.getenv("INFANTIL_CHAR_SCALE", "0.68"))
    char_w = int(1080 * char_scale)
    for i in range(num_imgs):
        chains.append(f"[{i + 1}:v]scale={char_w}:-1:flags=lanczos[ch{i}]")

    # Cadeias de overlay: sobrepor personagem no fundo com enable temporal
    prev = "bg"
    for i in range(num_imgs):
        t_start = round(i * dur_img, 3)
        t_end = round((i + 1) * dur_img, 3)
        tag_out = f"v{i}"
        chains.append(
            f"[{prev}][ch{i}]overlay="
            f"x=(W-w)/2:"
            f"y=(H-h)/2{os.getenv('INFANTIL_CHAR_OFFSET', '-80')}:"
            f"enable='between(t\\,{t_start}\\,{t_end})'"
            f"[{tag_out}]"
        )
        prev = tag_out

    # ── CADEIA FINAL: logo + legendas (tudo com drawtext, separado por VÍRGULA) ──
    # Todos os filtros abaixo operam no MESMO stream → vírgula entre eles
    final_filters = []

    # Logo "INFANTIIL" (texto fixo, sem caracteres especiais)
    if fonte:
        font_escaped = _escape_ffmpeg_path(fonte)
        final_filters.append(
            f"drawtext="
            f"fontfile='{font_escaped}':"
            f"text='INFANTIL':"
            f"fontsize=52:"
            f"fontcolor=0xFFD700@1:"
            f"borderw=5:"
            f"bordercolor=black@1:"
            f"x=48:y=55"
        )

    # Cores alternadas para legendas (hex FFmpeg)
    CORES_LEGENDA = [
        "0xFFFFFF",  # branco
        "0xFFD700",  # dourado
        "0x00FFFF",  # ciano
        "0x7FFF2F",  # verde
        "0xFF69B4",  # rosa
    ]

    # Cada legenda é um drawtext separado com textfile= e enable=between()
    if fonte and legendas:
        for i, leg in enumerate(legendas):
            t_ini = leg.get("inicio", 0)
            t_fim = leg.get("fim", duracao)
            cor = CORES_LEGENDA[i % len(CORES_LEGENDA)]

            # Caminho absoluto do arquivo de texto da legenda
            leg_file = (legendas_dir / f"leg_{i:02d}.txt").resolve()
            leg_path_escaped = _escape_ffmpeg_path(str(leg_file))

            final_filters.append(
                f"drawtext="
                f"fontfile='{font_escaped}':"
                f"textfile='{leg_path_escaped}':"
                f"fontsize=54:"
                f"fontcolor={cor}@1:"
                f"borderw=4:"
                f"bordercolor=black@1:"
                f"x=(w-text_w)/2:"
                f"y=h*{os.getenv('INFANTIL_LEGENDA_Y', '0.76')}:"
                f"enable='between(t\\,{t_ini}\\,{t_fim})'"
            )

    # Junta todos os filtros finais com VÍRGULA (mesma cadeia!)
    if final_filters:
        chains.append(f"[{prev}]{','.join(final_filters)}[vout]")
    else:
        chains.append(f"[{prev}]null[vout]")

    # Junta TODAS as cadeias com PONTO-E-VÍRGULA (cadeias diferentes)
    filter_complex = ";".join(chains)

    # ──────────────────────────────────────────────────────────
    # 4. MONTAR O COMANDO FFMPEG
    # ──────────────────────────────────────────────────────────
    audio_idx = num_imgs + 1

    cmd = ["ffmpeg", "-y"]
    cmd += ["-stream_loop", "-1", "-i", str(bg_video)]
    for img in char_imgs:
        cmd += ["-i", str(img)]
    cmd += ["-i", str(audio_file)]
    cmd += ["-filter_complex", filter_complex]
    cmd += ["-map", "[vout]", "-map", f"{audio_idx}:a"]
    cmd += [
        "-c:v", "libx264",
        "-preset", "medium",
        "-crf", "20",
        "-c:a", "aac",
        "-b:a", "192k",
        "-ar", "44100",
        "-pix_fmt", "yuv420p",
        "-t", str(round(duracao, 2)),
        "-movflags", "+faststart",
        str(output),
    ]

    console.print(f"[bold magenta][FFMPEG][/bold magenta] Iniciando composição 1080x1920 @ 30fps...")
    console.print(f"  Saída: {output.resolve()}")
    console.print(f"  Duração: {duracao}s | Imagens: {num_imgs} | Dur/imagem: {dur_img:.1f}s")
    console.print(f"  Legendas: {len(legendas)} (via drawtext+textfile)")

    # ──────────────────────────────────────────────────────────
    # 5. EXECUTAR FFMPEG
    # ──────────────────────────────────────────────────────────
    processo = subprocess.Popen(
        cmd,
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    ultima_linha = ""
    linhas_erro = []

    with console.status(
        "[bold magenta]Renderizando com FFmpeg...[/bold magenta]", spinner="earth"
    ):
        for line in processo.stdout:
            stripped = line.strip()
            if not stripped:
                continue
            ultima_linha = stripped

            if "frame=" in stripped:
                console.print(f"  [dim]{stripped}[/dim]", end="\r")
            elif "Error" in stripped or "error" in stripped:
                console.print(f"  [bold red][FFMPEG] {stripped}[/bold red]")
                linhas_erro.append(stripped)
            elif "Warning" in stripped or "warning" in stripped:
                console.print(f"  [dim yellow][FFMPEG] {stripped}[/dim yellow]")

    processo.wait()

    if processo.returncode != 0:
        console.print(f"\n[bold red][FFMPEG] Falhou (exit {processo.returncode})[/bold red]")
        if linhas_erro:
            console.print("[bold red]Erros encontrados:[/bold red]")
            for err in linhas_erro[-5:]:
                console.print(f"  [red]{err}[/red]")
        console.print(f"[dim]Última linha: {ultima_linha}[/dim]")

        # Debug: salva o filter_complex para inspeção
        debug_path = ASSETS_DIR / "debug_filter_complex.txt"
        debug_path.write_text(filter_complex, encoding="utf-8")
        console.print(f"[dim]Filter complex salvo em: {debug_path}[/dim]")

        raise RuntimeError(
            f"FFmpeg falhou (exit {processo.returncode}). Verifique logs acima."
        )

    size_mb = output.stat().st_size / (1024 * 1024)
    console.print(
        f"\n[bold green][FFMPEG][/bold green] Vídeo pronto: {size_mb:.1f} MB → {output}"
    )
    return str(output)


# ═══════════════════════════════════════════════════════════════════════
# UPLOAD YOUTUBE
# ═══════════════════════════════════════════════════════════════════════
def fazer_upload(video_path: str, metadata: dict) -> str | None:
    """Chama o uploader Playwright."""
    console.print("[bold blue][UPLOAD][/bold blue] Abrindo YouTube Studio no Chromium...")
    with console.status("[bold blue]Aguardando Playwright...[/bold blue]", spinner="dots"):
        url = youtube_studio_uploader.upload(video_path, metadata)
    return url


# ═══════════════════════════════════════════════════════════════════════
# CONTAGEM REGRESSIVA
# ═══════════════════════════════════════════════════════════════════════
def countdown(segundos: int, proximo_horario: datetime):
    """Exibe contagem regressiva no terminal."""
    console.print()
    console.print(
        Panel(
            f"[bold green]Ciclo concluído![/bold green]\n\n"
            f"Próximo vídeo: [bold cyan]{proximo_horario.strftime('%d/%m %H:%M:%S')}[/bold cyan]\n"
            f"(em [yellow]{segundos // 3600}h {(segundos % 3600) // 60}min[/yellow])\n\n"
            f"[dim]Pressione Ctrl+C para interromper[/dim]",
            title="[bold] AGUARDANDO PRÓXIMO CICLO [/bold]",
            border_style="green",
            box=box.ROUNDED,
            expand=False,
        )
    )

    with Progress(
        SpinnerColumn(),
        TextColumn("[bold green]Próximo vídeo em[/bold green]"),
        BarColumn(bar_width=40),
        TextColumn("[bold cyan]{task.description}[/bold cyan]"),
        TimeRemainingColumn(),
        console=console,
        refresh_per_second=1,
    ) as progress:
        task = progress.add_task("", total=segundos)
        for restante in range(segundos, 0, -1):
            h = restante // 3600
            m = (restante % 3600) // 60
            s = restante % 60
            progress.update(
                task,
                completed=segundos - restante,
                description=f"{h:02d}:{m:02d}:{s:02d}",
            )
            time.sleep(1)


# ═══════════════════════════════════════════════════════════════════════
# RESUMO DO CICLO
# ═══════════════════════════════════════════════════════════════════════
def resumo_ciclo(
    ciclo: int, metadata: dict, video_url: str | None, duracao_ciclo_s: float
):
    table = Table(
        title=f"RESUMO DO CICLO #{ciclo}",
        box=box.ROUNDED,
        border_style="cyan",
        show_lines=True,
    )
    table.add_column("Campo", style="bold white", min_width=16)
    table.add_column("Valor", style="cyan")

    titulo = metadata.get("titulo", "-")
    tema = metadata.get("tema", "-")
    titulo_safe = titulo.encode("ascii", "replace").decode("ascii")
    tema_safe = tema.encode("ascii", "replace").decode("ascii")

    table.add_row("Tema", tema_safe)
    table.add_row("Título", titulo_safe)
    table.add_row("Personagem", metadata.get("personagem_nome", "-"))
    table.add_row("Duração áudio", f"{metadata.get('duracao_audio_s', 0):.1f}s")
    table.add_row("Legendas", str(len(metadata.get("legendas", []))))
    table.add_row("Tags", ", ".join(metadata.get("tags", [])[:4]))
    table.add_row("URL YouTube", video_url or "[yellow]não capturada[/yellow]")
    table.add_row("Duração ciclo", f"{duracao_ciclo_s / 60:.1f} min")
    table.add_row("Horário", datetime.now().strftime("%d/%m/%Y %H:%M:%S"))

    console.print()
    console.print(table)


# ═══════════════════════════════════════════════════════════════════════
# PIPELINE — UM CICLO COMPLETO
# ═══════════════════════════════════════════════════════════════════════
def run_pipeline(ciclo: int, no_upload: bool = False) -> dict:
    t_inicio = time.time()
    banner(ciclo)

    # PASSO 1: Gerar todos os assets
    log_passo(1, 3, "Gerando Roteiro, Vídeo de Fundo, Imagens e Áudio")
    metadata = script_engine.generate()

    # PASSO 2: Compor vídeo com FFmpeg
    log_passo(2, 3, "Compondo Vídeo com FFmpeg (sem Remotion)")
    video_path = compor_video_ffmpeg(metadata)

    # PASSO 3: Upload para YouTube
    video_url = None
    if no_upload:
        log_passo(3, 3, "Upload DESABILITADO (--no-upload)")
        console.print("[yellow]  Upload pulado. Vídeo salvo em output/video_final.mp4[/yellow]")
    else:
        log_passo(3, 3, "Publicando no YouTube Studio via Playwright")
        video_url = fazer_upload(video_path, metadata)

    duracao = time.time() - t_inicio
    resumo_ciclo(ciclo, metadata, video_url, duracao)
    return metadata


# ═══════════════════════════════════════════════════════════════════════
# MAIN
# ═══════════════════════════════════════════════════════════════════════
def main():
    parser = argparse.ArgumentParser(
        description="Pipeline automatizado de YouTube Shorts Brain Rot Infantil v3"
    )
    parser.add_argument(
        "--once", action="store_true", help="Roda apenas 1 ciclo e encerra"
    )
    parser.add_argument(
        "--no-upload", action="store_true", help="Pula o upload para YouTube"
    )
    args = parser.parse_args()

    # Verificação inicial
    if not verificar_ffmpeg():
        sys.exit(1)

    console.print(
        Panel(
            "[bold green]Pipeline iniciado![/bold green]\n"
            f"[dim]Cada ciclo: gera assets → FFmpeg → posta → aguarda {INTERVAL_HOURS}h[/dim]\n"
            "Pressione [bold red]Ctrl+C[/bold red] para parar.",
            border_style="bright_green",
            expand=False,
        )
    )

    ciclo = 0
    try:
        while True:
            ciclo += 1
            run_pipeline(ciclo, no_upload=args.no_upload)

            if args.once:
                console.print(
                    "\n[bold green]Modo --once: encerrando após 1 ciclo.[/bold green]"
                )
                break

            jitter = random.randint(-JITTER_SECONDS, JITTER_SECONDS)
            espera_total = INTERVAL_SECONDS + jitter
            proximo = datetime.now() + timedelta(seconds=espera_total)

            console.print(
                f"\n[dim]Jitter: {jitter:+d}s — próximo ciclo em "
                f"{espera_total // 3600}h {(espera_total % 3600) // 60}min[/dim]"
            )
            countdown(espera_total, proximo)

    except KeyboardInterrupt:
        console.print("\n[bold red]Pipeline interrompido pelo usuário (Ctrl+C).[/bold red]")
        sys.exit(0)
    except Exception as e:
        console.print(f"\n[bold red]ERRO FATAL: {e}[/bold red]")
        console.print_exception(show_locals=True)
        sys.exit(1)


if __name__ == "__main__":
    main()