"""
youtube_uploader.py — Upload via YouTube Data API v3 com OAuth 2.0
"""

import os
import json
import time
from pathlib import Path
from rich.console import Console
from rich.progress import Progress, BarColumn, TextColumn, FileSizeColumn, TransferSpeedColumn

console = Console()

TOKEN_FILE = "token.json"
SCOPES = ["https://www.googleapis.com/auth/youtube.upload"]


def get_authenticated_service():
    """Autentica e retorna o serviço YouTube."""
    from google.auth.transport.requests import Request
    from google.oauth2.credentials import Credentials
    from google_auth_oauthlib.flow import InstalledAppFlow
    from googleapiclient.discovery import build

    creds = None

    if Path(TOKEN_FILE).exists():
        creds = Credentials.from_authorized_user_file(TOKEN_FILE, SCOPES)

    if not creds or not creds.valid:
        if creds and creds.expired and creds.refresh_token:
            console.print("[bold blue][YOUTUBE][/bold blue] Renovando token de acesso...")
            creds.refresh(Request())
        else:
            if not Path("client_secrets.json").exists():
                raise FileNotFoundError(
                    "❌ client_secrets.json não encontrado!\n"
                    "Baixe em: Google Cloud Console → APIs → Credenciais → OAuth 2.0 Client IDs"
                )
            flow = InstalledAppFlow.from_client_secrets_file("client_secrets.json", SCOPES)
            console.print("[bold yellow][YOUTUBE][/bold yellow] Abrindo navegador para autenticação OAuth...")
            creds = flow.run_local_server(port=0)

        Path(TOKEN_FILE).write_text(creds.to_json())
        console.print("[bold green][YOUTUBE][/bold green] Token salvo em token.json")

    return build("youtube", "v3", credentials=creds)


def upload(video_path: str, metadata: dict) -> str | None:
    """Faz upload do vídeo para o YouTube com metadados completos."""
    from googleapiclient.http import MediaFileUpload
    from googleapiclient.errors import HttpError

    if not Path("client_secrets.json").exists():
        console.print("[bold red][YOUTUBE][/bold red] ⚠️  client_secrets.json ausente — upload pulado (dry-run)")
        return None

    console.print("[bold blue][YOUTUBE][/bold blue] Iniciando upload para YouTube...")

    youtube = get_authenticated_service()

    descricao = metadata.get("descricao", "") + "\n\n#Shorts #Infantil #Educativo"
    tags = metadata.get("tags", []) + ["Shorts", "infantil", "educativo", "crianças"]

    body = {
        "snippet": {
            "title": metadata.get("titulo", "Vídeo Infantil Incrível! 🌟"),
            "description": descricao,
            "tags": tags,
            "categoryId": "24",  # Entertainment
            "defaultLanguage": "pt",
            "defaultAudioLanguage": "pt",
        },
        "status": {
            "privacyStatus": "public",
            "selfDeclaredMadeForKids": True,
        },
    }

    media = MediaFileUpload(video_path, chunksize=1024 * 1024, resumable=True, mimetype="video/mp4")

    request = youtube.videos().insert(part=",".join(body.keys()), body=body, media_body=media)

    video_id = None
    with Progress(
        TextColumn("[bold blue][YOUTUBE][/bold blue] Enviando"),
        BarColumn(),
        TextColumn("[progress.percentage]{task.percentage:>3.0f}%"),
        FileSizeColumn(),
        TransferSpeedColumn(),
        console=console,
    ) as progress:
        task = progress.add_task("upload", total=100)
        response = None
        while response is None:
            status, response = request.next_chunk()
            if status:
                pct = int(status.progress() * 100)
                progress.update(task, completed=pct)

    video_id = response.get("id")
    url = f"https://www.youtube.com/shorts/{video_id}"
    console.print(f"[bold green][YOUTUBE][/bold green] ✅ Upload concluído! URL: [link={url}]{url}[/link]")
    return url
