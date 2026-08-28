"""
tiktok_uploader.py — Upload para TikTok via biblioteca tiktok-uploader (cookies de sessão)

Como funciona:
  1. Você faz login normal no TikTok no seu Chrome/Firefox
  2. Exporta os cookies com a extensão "Cookie-Editor" (formato Netscape/JSON)
  3. Salva como cookies_tiktok.txt na pasta do projeto
  4. Este script usa esses cookies para autenticar e fazer upload — sem login automatizado

Instalação:
  pip install tiktok-uploader
"""

import json
from pathlib import Path
from typing import Optional

from rich.console import Console

console = Console()

BASE_DIR = Path(__file__).parent
COOKIES_FILE = BASE_DIR / "cookies_tiktok.txt"


# ─────────────────────────────────────────────────────────────────────────────
# VERIFICAÇÃO DE COOKIES
# ─────────────────────────────────────────────────────────────────────────────

def _check_cookies() -> None:
    """Verifica se o arquivo de cookies existe e instrui o usuário caso não exista."""
    if not COOKIES_FILE.exists():
        raise FileNotFoundError(
            f"Arquivo de cookies não encontrado: '{COOKIES_FILE}'\n\n"
            "INSTRUÇÕES PARA EXPORTAR COOKIES DO TIKTOK:\n"
            "  1. Abra o Chrome e faça login na sua conta TikTok (tiktok.com)\n"
            "  2. Instale a extensão 'Cookie-Editor' (disponível na Chrome Web Store)\n"
            "  3. Clique no ícone da extensão enquanto estiver no tiktok.com\n"
            "  4. Clique em 'Export' → 'Export as Netscape HTTP Cookie File'\n"
            "  5. Salve o arquivo como 'cookies_tiktok.txt' na pasta do projeto\n"
            "  6. IMPORTANTE: Não faça logout do TikTok no navegador — isso invalida os cookies\n"
            "  7. Renove os cookies a cada 30-60 dias (quando o script parar de funcionar)"
        )


# ─────────────────────────────────────────────────────────────────────────────
# UPLOAD
# ─────────────────────────────────────────────────────────────────────────────

def upload(
    video_path: str,
    caption: str,
    hashtags: Optional[list[str]] = None,
    schedule_time: Optional[int] = None,
) -> bool:
    """
    Faz upload de um vídeo para o TikTok.

    Args:
        video_path: Caminho do arquivo .mp4
        caption: Legenda do vídeo (sem hashtags — elas são adicionadas separadamente)
        hashtags: Lista de hashtags sem '#' (ex: ['Fe', 'Deus', 'Jesus'])
        schedule_time: Unix timestamp para agendamento (None = postar agora)

    Returns:
        True se o upload for bem-sucedido, False caso contrário.
    """
    try:
        from tiktok_uploader.upload import upload_video
        from tiktok_uploader.auth import AuthBackend
    except ImportError:
        console.print(
            "[bold red][TIKTOK] Biblioteca não instalada![/bold red]\n"
            "[yellow]Execute: pip install tiktok-uploader[/yellow]"
        )
        return False

    _check_cookies()

    video_path = str(Path(video_path).absolute())
    tags = hashtags or ["Fe", "Deus", "Jesus", "Shorts", "Reflexao", "Biblia"]

    # Monta a legenda completa com hashtags
    hashtags_str = " ".join(f"#{tag}" for tag in tags)
    full_caption = f"{caption}\n\n{hashtags_str}"

    # Limita a 2200 caracteres (limite do TikTok)
    if len(full_caption) > 2200:
        full_caption = full_caption[:2197] + "..."

    console.print(f"[bold blue][TIKTOK][/bold blue] Iniciando upload...")
    console.print(f"[dim]  Arquivo : {video_path}[/dim]")
    console.print(f"[dim]  Legenda : {full_caption[:80]}...[/dim]")

    try:
        auth = AuthBackend(cookies=str(COOKIES_FILE))

        results = upload_video(
            filename=video_path,
            description=full_caption,
            auth=auth,
            schedule=schedule_time,
            headless=True,  # Roda sem abrir janela de browser
        )

        if results:
            console.print("[bold green][TIKTOK] Upload concluído com sucesso![/bold green]")
            return True
        else:
            console.print("[bold red][TIKTOK] Upload falhou — sem resposta da API.[/bold red]")
            return False

    except Exception as e:
        error_str = str(e).lower()

        if "cookie" in error_str or "auth" in error_str or "login" in error_str:
            console.print(
                f"[bold red][TIKTOK] Erro de autenticação: {e}[/bold red]\n"
                "[yellow]Seus cookies podem ter expirado. Reexporte-os do navegador.[/yellow]"
            )
        elif "timeout" in error_str:
            console.print(
                f"[bold red][TIKTOK] Timeout no upload: {e}[/bold red]\n"
                "[yellow]Verifique sua conexão e tente novamente.[/yellow]"
            )
        else:
            console.print(f"[bold red][TIKTOK] Erro inesperado: {e}[/bold red]")

        return False


# ─────────────────────────────────────────────────────────────────────────────
# TESTE RÁPIDO
# ─────────────────────────────────────────────────────────────────────────────

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Teste de upload para TikTok")
    parser.add_argument("video", help="Caminho do arquivo de vídeo")
    parser.add_argument("--caption", default="Mensagem de fé para você!", help="Legenda")
    parser.add_argument("--tags", nargs="+", default=["Fe", "Deus", "Jesus", "Shorts"])
    args = parser.parse_args()

    sucesso = upload(args.video, args.caption, args.tags)
    if sucesso:
        console.print("[bold green]Teste concluído com sucesso![/bold green]")
    else:
        console.print("[bold red]Teste falhou.[/bold red]")
