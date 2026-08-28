"""
test_video.py — Geração de vídeo de teste (sem upload)

Uso:
    python test_video.py                          # tema aleatório
    python test_video.py --tema "como as abelhas fazem mel"
    python test_video.py --abrir                  # abre o vídeo ao final
    python test_video.py --tema "dinossauros" --abrir
"""
import sys
import time
import argparse
import subprocess
from pathlib import Path
from datetime import datetime

from rich.console import Console
from rich.panel import Panel
from rich import box

import script_engine
from main import compor_video_ffmpeg, verificar_ffmpeg

console = Console()


def main():
    parser = argparse.ArgumentParser(description="Gera um vídeo de teste sem fazer upload.")
    parser.add_argument("--tema", type=str, default=None, help="Tema do vídeo (opcional, usa aleatório se omitido)")
    parser.add_argument("--abrir", action="store_true", help="Abre o vídeo ao final com o player padrão")
    args = parser.parse_args()

    if not verificar_ffmpeg():
        sys.exit(1)

    console.print()
    console.print(Panel(
        "[bold yellow]  MODO DE TESTE — Sem Upload[/bold yellow]\n"
        "[dim]Gera roteiro + assets + vídeo FFmpeg e para.[/dim]",
        border_style="yellow",
        box=box.ROUNDED,
        expand=False,
    ))

    t_inicio = time.time()

    # PASSO 1: Gerar assets
    console.print()
    console.rule("[bold cyan] PASSO 1/2 — Gerando Roteiro, Imagens e Áudio [/bold cyan]", style="cyan")
    metadata = script_engine.generate(tema=args.tema)

    # PASSO 2: Compor vídeo
    console.print()
    console.rule("[bold magenta] PASSO 2/2 — Compondo Vídeo com FFmpeg [/bold magenta]", style="magenta")
    video_path = compor_video_ffmpeg(metadata)

    duracao = time.time() - t_inicio
    size_mb = Path(video_path).stat().st_size / (1024 * 1024)

    console.print()
    console.print(Panel(
        f"[bold green]Vídeo de teste gerado com sucesso![/bold green]\n\n"
        f"[bold]Arquivo:[/bold]  [cyan]{video_path}[/cyan]\n"
        f"[bold]Tamanho:[/bold]  {size_mb:.1f} MB\n"
        f"[bold]Tema:[/bold]     {metadata.get('titulo', '-')}\n"
        f"[bold]Duração:[/bold]  {metadata.get('duracao_audio_s', 0):.1f}s de áudio\n"
        f"[bold]Tempo total:[/bold] {duracao:.1f}s",
        title="[bold] TESTE CONCLUÍDO [/bold]",
        border_style="green",
        box=box.ROUNDED,
    ))

    if args.abrir:
        console.print(f"\n[bold yellow]Abrindo vídeo...[/bold yellow]")
        subprocess.Popen(["start", "", video_path], shell=True)


if __name__ == "__main__":
    main()
