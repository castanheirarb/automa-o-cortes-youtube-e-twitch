"""
main.py — Orquestrador Principal do Pipeline de Shorts Religiosos (v9)
Loop contínuo: gera roteiro → copia assets → renderiza (Remotion) → posta → aguarda.
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
import youtube_uploader        # API oficial v3 (substitui youtube_studio_uploader)
import tiktok_uploader         # Upload TikTok via cookies de sessão
import trending

# Fix Windows terminal encoding
if sys.stdout.encoding != "utf-8":
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# ── Configurações ──────────────────────────────────────────────────────────
console = Console()

OUTPUT_DIR = Path("output")
ASSETS_DIR = Path("assets")
VIDEO_DIR  = Path("video")
PUBLIC_DIR = VIDEO_DIR / "public"

OUTPUT_DIR.mkdir(exist_ok=True)
PUBLIC_DIR.mkdir(parents=True, exist_ok=True)
(PUBLIC_DIR / "images").mkdir(exist_ok=True)

INTERVAL_HOURS   = 6
INTERVAL_SECONDS = INTERVAL_HOURS * 3600
JITTER_SECONDS   = 15 * 60  # ±15 minutos


# ─────────────────────────────────────────────────────────────────────────────
# BANNER E LOGS
# ─────────────────────────────────────────────────────────────────────────────
def banner(ciclo: int):
    hora = datetime.now().strftime("%d/%m/%Y %H:%M:%S")
    console.print()
    console.print(
        Panel(
            f"[bold yellow] Canal da Fé — Pipeline de Shorts Religiosos (v9)[/bold yellow]\n"
            f"[dim]Claude Sonnet 4.6 · Replicate (FLUX) · Remotion · Edge TTS[/dim]\n\n"
            f"[bold]CICLO #{ciclo}[/bold]  |  [cyan]{hora}[/cyan]",
            border_style="bright_blue",
            box=box.DOUBLE_EDGE,
            expand=False,
        )
    )


def log_passo(num: int, total: int, titulo: str, emoji: str = "🙏"):
    console.print()
    console.rule(
        f"[bold white] {emoji} PASSO {num}/{total}: {titulo} [/bold white]",
        style="bright_blue",
    )


# ─────────────────────────────────────────────────────────────────────────────
# CÓPIA DE ASSETS PARA video/public/
# ─────────────────────────────────────────────────────────────────────────────
def copiar_assets():
    """
    Move metadata.json, audio.mp3 e imagens de assets/ para video/public/
    para que o Remotion possa acessá-los via staticFile().
    """
    console.print("[bold magenta][ASSETS][/bold magenta] Copiando assets para video/public/...")

    # metadata.json
    shutil.copy(ASSETS_DIR / "metadata.json", PUBLIC_DIR / "metadata.json")

    # audio.mp3
    audio_src = ASSETS_DIR / "audio.mp3"
    if audio_src.exists():
        shutil.copy(audio_src, PUBLIC_DIR / "audio.mp3")
    else:
        console.print("[yellow][ASSETS] audio.mp3 não encontrado em assets/ — pulando.[/yellow]")

    # imagens
    images_public = PUBLIC_DIR / "images"
    images_public.mkdir(exist_ok=True)
    count = 0
    for img in (ASSETS_DIR / "images").glob("*.jpg"):
        shutil.copy(img, images_public / img.name)
        count += 1

    console.print(
        f"[bold green][ASSETS][/bold green] Pronto — metadata.json + audio.mp3 + {count} imagens copiados."
    )


# ─────────────────────────────────────────────────────────────────────────────
# RENDERIZAÇÃO COM REMOTION
# ─────────────────────────────────────────────────────────────────────────────
def render_remotion() -> str:
    """Chama Remotion para renderizar o vídeo 1080x1920 @ 30fps."""
    timestamp = int(time.time())
    output_path = str((OUTPUT_DIR / f"short_religioso_{timestamp}.mp4").absolute())

    console.print(f"[bold magenta][REMOTION][/bold magenta] Iniciando render 1080x1920 @ 30fps...")
    console.print(f"[dim]  Saída: {output_path}[/dim]")

    cmd = (
        f'npx remotion render src/index.tsx ShortsReligioso "{output_path}" --log=info'
    )

    process = subprocess.Popen(
        cmd,
        cwd=str(VIDEO_DIR),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
        shell=True,
    )

    for line in process.stdout:
        stripped = line.strip()
        if not stripped:
            continue
        low = stripped.lower()
        if "error" in low:
            console.print(f"[red][REMOTION] {stripped}[/red]")
        elif "rendered" in low and "/" in stripped:
            console.print(f"[magenta][RENDER][/magenta] {stripped}", end="\r")
        else:
            console.print(f"[dim][REMOTION] {stripped}[/dim]")

    process.wait()

    if process.returncode != 0:
        raise RuntimeError(f"Remotion render falhou (exit {process.returncode})")

    size_mb = Path(output_path).stat().st_size / (1024 * 1024)
    console.print(f"\n[bold green][REMOTION][/bold green] Vídeo renderizado: {size_mb:.1f} MB")
    return output_path


# ─────────────────────────────────────────────────────────────────────────────
# UPLOAD YOUTUBE (API oficial v3 — sem browser automation)
# ─────────────────────────────────────────────────────────────────────────────
def fazer_upload_youtube(video_path: str, metadata: dict) -> str | None:
    console.print("[bold red][YOUTUBE][/bold red] Iniciando upload via YouTube Data API v3...")
    return youtube_uploader.upload(video_path, metadata)


# ─────────────────────────────────────────────────────────────────────────────
# UPLOAD TIKTOK (via cookies de sessão)
# ─────────────────────────────────────────────────────────────────────────────
def fazer_upload_tiktok(video_path: str, metadata: dict) -> bool:
    console.print("[bold blue][TIKTOK][/bold blue] Iniciando upload para TikTok...")
    caption = metadata.get("titulo", "Mensagem de Fé")
    tags = metadata.get("tags", ["Fe", "Deus", "Jesus", "Shorts", "Reflexao"])
    return tiktok_uploader.upload(video_path, caption, tags)


# ─────────────────────────────────────────────────────────────────────────────
# CONTAGEM REGRESSIVA
# ─────────────────────────────────────────────────────────────────────────────
def countdown(segundos: int, proximo_horario: datetime):
    console.print()
    console.print(
        Panel(
            f"[bold green]Ciclo concluído com sucesso![/bold green]\n\n"
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


# ─────────────────────────────────────────────────────────────────────────────
# RESUMO DO CICLO
# ─────────────────────────────────────────────────────────────────────────────
def resumo_ciclo(ciclo: int, metadata: dict, video_url: str | None, duracao_total: float):
    console.print()
    tabela = Table(
        title=f"[bold]RESUMO DO CICLO #{ciclo}[/bold]",
        box=box.HEAVY_HEAD,
        border_style="bright_blue",
    )
    tabela.add_column("Item", style="cyan", min_width=18)
    tabela.add_column("Valor", style="white")
    tabela.add_row("Tema",    metadata.get("tema", "-"))
    tabela.add_row("Título",  metadata.get("titulo", "-"))
    tabela.add_row("Áudio",   f"{metadata.get('duracao_total_real_s', 0):.1f}s")
    tabela.add_row("Cenas",   str(len(metadata.get("cenas", []))))
    tabela.add_row("URL", f"[link={video_url}]{video_url}[/link]" if video_url else "[red]Falha no upload[/red]")
    tabela.add_row("Horário", datetime.now().strftime("%d/%m/%Y %H:%M:%S"))
    console.print(tabela)


# ─────────────────────────────────────────────────────────────────────────────
# MAIN
# ─────────────────────────────────────────────────────────────────────────────
def main():
    parser = argparse.ArgumentParser(
        description="Pipeline de automação de Shorts religiosos (v9)."
    )
    parser.add_argument(
        "--once", action="store_true", help="Roda o pipeline apenas uma vez."
    )
    parser.add_argument(
        "--no-upload", action="store_true", help="Pula todos os uploads."
    )
    parser.add_argument(
        "--tiktok", action="store_true", help="Também faz upload para o TikTok."
    )
    args = parser.parse_args()

    console.print(
        Panel(
            "[bold green]Pipeline v9 de Shorts Religiosos iniciado![/bold green]\n"
            f"[dim]Cada ciclo: gera assets → Remotion → YouTube → aguarda {INTERVAL_HOURS}h[/dim]\n"
            "Pressione [bold red]Ctrl+C[/bold red] para parar.",
            border_style="bright_green",
            expand=False,
        )
    )

    ciclo = 0
    try:
        while True:
            ciclo += 1
            banner(ciclo)

            try:
                # PASSO 1 — Roteiro, imagens e áudio
                log_passo(1, 4, "GERANDO ROTEIRO, IMAGENS E ÁUDIO")
                tema_do_dia = trending.get_tema()
                metadata = script_engine.generate(tema=tema_do_dia)

                # PASSO 2 — Copiar assets para video/public/
                log_passo(2, 4, "COPIANDO ASSETS PARA REMOTION")
                copiar_assets()

                # PASSO 3 — Renderizar com Remotion
                log_passo(3, 4, "RENDERIZANDO VÍDEO COM REMOTION")
                video_path = render_remotion()

                # PASSO 4 — Upload YouTube + TikTok
                total_passos = 5 if args.tiktok else 4
                log_passo(4, total_passos, "FAZENDO UPLOAD PARA O YOUTUBE", emoji="📤")
                if args.no_upload:
                    console.print("[yellow]  Upload pulado (--no-upload). Vídeo em output/[/yellow]")
                    video_url = None
                else:
                    video_url = fazer_upload_youtube(video_path, metadata)

                if args.tiktok and not args.no_upload:
                    log_passo(5, total_passos, "FAZENDO UPLOAD PARA O TIKTOK", emoji="🎵")
                    fazer_upload_tiktok(video_path, metadata)

                resumo_ciclo(ciclo, metadata, video_url, metadata.get("duracao_total_real_s", 0))

            except Exception as e:
                console.print(f"\n[bold red]ERRO CRÍTICO NO PIPELINE:[/bold red] {e}")
                console.print_exception(show_locals=False)

            if args.once:
                console.print("\n[bold yellow]--once flag detectada. Finalizando após um ciclo.[/bold yellow]")
                break

            jitter = random.randint(-JITTER_SECONDS, JITTER_SECONDS)
            tempo_espera = INTERVAL_SECONDS + jitter
            proximo_horario = datetime.now() + timedelta(seconds=tempo_espera)
            console.print(
                f"\n[dim]Jitter: {jitter:+d}s — próximo ciclo em "
                f"{tempo_espera // 3600}h {(tempo_espera % 3600) // 60}min[/dim]"
            )
            countdown(tempo_espera, proximo_horario)

    except KeyboardInterrupt:
        console.print("\n[bold red]Pipeline interrompido pelo usuário (Ctrl+C).[/bold red]")
        sys.exit(0)


if __name__ == "__main__":
    main()
