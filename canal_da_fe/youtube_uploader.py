"""
youtube_uploader.py — Upload via YouTube Data API v3 com OAuth 2.0 + Refresh Token
Substitui o youtube_studio_uploader.py (que usava Playwright/browser automation).

Fluxo:
  1ª execução: abre o browser para login manual → salva token.json
  Execuções seguintes: usa o refresh token automaticamente, sem interação humana.
"""

import os
import json
import time
from pathlib import Path
from typing import Optional

from rich.console import Console
from googleapiclient.discovery import build
from googleapiclient.errors import HttpError
from googleapiclient.http import MediaFileUpload
from google_auth_oauthlib.flow import InstalledAppFlow
from google.auth.transport.requests import Request
from google.oauth2.credentials import Credentials

console = Console()

# ── Caminhos dos arquivos de credenciais ──────────────────────────────────────
BASE_DIR = Path(__file__).parent
CLIENT_SECRETS_FILE = BASE_DIR / "client_secrets.json"
TOKEN_FILE = BASE_DIR / "token.json"

# Escopos necessários para upload de vídeo
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]

# Categoria "Pessoas e Blogs" = 22  |  "Entretenimento" = 24  |  "Educação" = 27
YOUTUBE_CATEGORY_PEOPLE_BLOGS = "22"


# ─────────────────────────────────────────────────────────────────────────────
# AUTENTICAÇÃO
# ─────────────────────────────────────────────────────────────────────────────

def get_credentials() -> Credentials:
    """
    Retorna credenciais válidas do YouTube.
    - Se token.json existir e for válido, usa o refresh token silenciosamente.
    - Se não existir ou estiver expirado sem refresh, abre o browser para login.
    """
    creds: Optional[Credentials] = None

    if TOKEN_FILE.exists():
        creds = Credentials.from_authorized_user_file(str(TOKEN_FILE), SCOPES)

    # Token expirado mas com refresh token disponível → renova silenciosamente
    if creds and creds.expired and creds.refresh_token:
        console.print("[dim][YOUTUBE] Renovando access token via refresh token...[/dim]")
        creds.refresh(Request())
        _save_token(creds)
        return creds

    # Credenciais válidas → usa direto
    if creds and creds.valid:
        return creds

    # Nenhuma credencial válida → fluxo de login inicial (abre o browser UMA vez)
    if not CLIENT_SECRETS_FILE.exists():
        raise FileNotFoundError(
            f"Arquivo '{CLIENT_SECRETS_FILE}' não encontrado!\n"
            "Baixe o client_secrets.json no Google Cloud Console e coloque na pasta do projeto."
        )

    console.print(
        "[bold yellow][YOUTUBE] Primeira autenticação necessária.[/bold yellow]\n"
        "[dim]O browser será aberto para você fazer login. Isso só acontece uma vez.[/dim]"
    )
    flow = InstalledAppFlow.from_client_secrets_file(str(CLIENT_SECRETS_FILE), SCOPES)
    creds = flow.run_local_server(port=0)
    _save_token(creds)

    console.print("[bold green][YOUTUBE] Login realizado! token.json salvo. Próximos uploads serão automáticos.[/bold green]")
    return creds


def _save_token(creds: Credentials) -> None:
    """Persiste as credenciais (incluindo o refresh token) em token.json."""
    token_data = {
        "token": creds.token,
        "refresh_token": creds.refresh_token,
        "token_uri": creds.token_uri,
        "client_id": creds.client_id,
        "client_secret": creds.client_secret,
        "scopes": list(creds.scopes),
    }
    TOKEN_FILE.write_text(json.dumps(token_data, indent=2), encoding="utf-8")


# ─────────────────────────────────────────────────────────────────────────────
# UPLOAD
# ─────────────────────────────────────────────────────────────────────────────

def upload(video_path: str, metadata: dict, thumbnail_path: Optional[str] = None) -> Optional[str]:
    """
    Faz upload de um vídeo para o YouTube via API oficial.

    Args:
        video_path: Caminho absoluto do arquivo .mp4
        metadata: Dict com 'titulo', 'descricao', 'tags' (lista), etc.
        thumbnail_path: (opcional) Caminho da thumbnail .jpg/.png

    Returns:
        URL pública do vídeo ou None em caso de falha.
    """
    titulo = metadata.get("titulo", "Mensagem de Fé")
    descricao = (
        metadata.get("descricao", "")
        + "\n\n#Fé #Deus #Jesus #Shorts #Reflexão #Bíblia"
    )
    tags = metadata.get("tags", ["Fé", "Deus", "Jesus", "Shorts", "Reflexão", "Bíblia"])

    video_path = str(Path(video_path).absolute())

    console.print(f"[bold red][YOUTUBE][/bold red] Iniciando upload via API v3...")
    console.print(f"[dim]  Arquivo : {video_path}[/dim]")
    console.print(f"[dim]  Título  : {titulo}[/dim]")

    try:
        creds = get_credentials()
        youtube = build("youtube", "v3", credentials=creds)

        body = {
            "snippet": {
                "title": titulo,
                "description": descricao,
                "tags": tags,
                "categoryId": YOUTUBE_CATEGORY_PEOPLE_BLOGS,
                # defaultLanguage define o idioma dos metadados
                "defaultLanguage": "pt",
                "defaultAudioLanguage": "pt",
            },
            "status": {
                "privacyStatus": "public",
                "selfDeclaredMadeForKids": False,
                # "madeForKids": False,  # alternativa se selfDeclared não funcionar
            },
        }

        # MediaFileUpload com resumable=True garante uploads estáveis
        # mesmo em conexões lentas ou arquivos grandes
        media = MediaFileUpload(
            video_path,
            mimetype="video/mp4",
            resumable=True,
            chunksize=10 * 1024 * 1024,  # chunks de 10 MB
        )

        request = youtube.videos().insert(
            part=",".join(body.keys()),
            body=body,
            media_body=media,
        )

        # Loop de upload com barra de progresso
        response = None
        console.print("[bold red][YOUTUBE][/bold red] Enviando arquivo...")
        while response is None:
            status, response = request.next_chunk()
            if status:
                pct = int(status.progress() * 100)
                console.print(f"[dim]  Upload: {pct}%[/dim]", end="\r")

        video_id = response["id"]
        video_url = f"https://www.youtube.com/shorts/{video_id}"
        console.print(f"\n[bold green][YOUTUBE] Upload concluído! URL: {video_url}[/bold green]")

        # Upload de thumbnail (requer escopo adicional se conta não for verificada)
        if thumbnail_path and Path(thumbnail_path).exists():
            _upload_thumbnail(youtube, video_id, thumbnail_path)

        return video_url

    except HttpError as e:
        _handle_http_error(e)
        return None
    except Exception as e:
        console.print(f"[bold red][YOUTUBE] Erro inesperado: {e}[/bold red]")
        return None


def _upload_thumbnail(youtube, video_id: str, thumbnail_path: str) -> None:
    """Faz upload da thumbnail para o vídeo já publicado."""
    try:
        console.print("[bold red][YOUTUBE][/bold red] Enviando thumbnail...")
        youtube.thumbnails().set(
            videoId=video_id,
            media_body=MediaFileUpload(thumbnail_path),
        ).execute()
        console.print("[bold green][YOUTUBE] Thumbnail enviada![/bold green]")
    except HttpError as e:
        # Thumbnail upload pode falhar se a conta não for verificada — não é fatal
        console.print(f"[yellow][YOUTUBE] Thumbnail falhou (não crítico): {e.reason}[/yellow]")


def _handle_http_error(e: HttpError) -> None:
    """Trata erros HTTP comuns da API do YouTube."""
    error_content = json.loads(e.content.decode("utf-8"))
    errors = error_content.get("error", {}).get("errors", [{}])
    reason = errors[0].get("reason", "unknown")
    message = errors[0].get("message", str(e))

    if reason == "quotaExceeded":
        console.print(
            "[bold red][YOUTUBE] COTA DIÁRIA EXCEDIDA![/bold red]\n"
            "[yellow]A YouTube Data API tem limite de 10.000 unidades/dia.\n"
            "Upload custa 1.600 unidades. Limite diário ≈ 6 uploads.\n"
            "Aguarde o reset da cota (meia-noite horário do Pacífico).[/yellow]"
        )
    elif reason in ("forbidden", "insufficientPermissions"):
        console.print(
            f"[bold red][YOUTUBE] Permissão negada: {message}[/bold red]\n"
            "[yellow]Verifique os escopos OAuth e se o email está na lista de usuários de teste.[/yellow]"
        )
    elif reason == "uploadLimitExceeded":
        console.print("[bold red][YOUTUBE] Limite de uploads diários da conta atingido.[/bold red]")
    else:
        console.print(f"[bold red][YOUTUBE] Erro HTTP {e.resp.status}: {reason} — {message}[/bold red]")
