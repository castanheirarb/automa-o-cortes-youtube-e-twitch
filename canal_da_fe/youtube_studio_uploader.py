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
        page.wait_for_event("close", timeout=300000)
    console.print("[bold green]Setup concluído! Perfil de navegador salvo.[/bold green]")

def upload(video_path: str, metadata: dict, thumbnail_path: str | None = None) -> str | None:
    titulo = metadata.get("titulo", "Mensagem de Fé")
    descricao = metadata.get("descricao", "") + "\n\n#Fé #Deus #Jesus #Shorts"
    video_path = str(Path(video_path).absolute())
    if thumbnail_path:
        thumbnail_path = str(Path(thumbnail_path).absolute())

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
                page.locator("input[type='file']").dispatch_event("click")
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

            if thumbnail_path:
                console.print("[bold blue][YOUTUBE][/bold blue] Enviando thumbnail personalizada...")
                with page.expect_file_chooser() as fc_thumb:
                    page.locator("button[aria-label='Fazer upload de miniatura']").click()
                fc_thumb.value.set_files(thumbnail_path)
                human_delay(2, 3)

            console.print("[bold blue][YOUTUBE][/bold blue] Configurando para 'Não é conteúdo para crianças'...")
            page.locator("tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_NOT_MFK']").click()
            human_delay(1, 1.5)

            for i in range(3):
                human_delay(1, 2)
                page.locator("#next-button").click()

            console.print("[bold blue][YOUTUBE][/bold blue] Configurando visibilidade para 'Público'...")
            page.locator("tp-yt-paper-radio-button[name='PUBLIC']").click()
            human_delay(1, 2)

            console.print("[bold blue][YOUTUBE][/bold blue] Aguardando upload e processamento...")
            page.wait_for_selector("span.progress-label:has-text('Verificações concluídas')", timeout=600000)
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
