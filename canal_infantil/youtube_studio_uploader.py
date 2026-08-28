"""
youtube_studio_uploader.py — Upload humano via Playwright no YouTube Studio
Comportamento humano: delays aleatórios, digitação gradual, movimentos suaves.
"""

import time
import random
from pathlib import Path
from rich.console import Console

console = Console()

PROFILE_DIR = str(Path("browser_profile").absolute())

# ── Velocidades de digitação (mais humanas / mais lentas) ─────────────
TYPING_DELAY_TITLE_MS = (100, 200)   # Título: 100–200ms por char
TYPING_DELAY_DESC_MS  = (60, 130)    # Descrição: 60–130ms por char


def human_delay(min_s: float = 0.8, max_s: float = 2.2):
    """Pausa aleatória que simula tempo de reação humana."""
    time.sleep(random.uniform(min_s, max_s))


def slow_type(locator, text: str, delay_range: tuple = (100, 200)):
    """Digita texto caractere por caractere com velocidade humana."""
    locator.click()
    human_delay(0.4, 0.8)
    locator.press_sequentially(
        text,
        delay=random.randint(*delay_range)
    )


def wait_for_publish_button(page, timeout_s: int = 300) -> bool:
    """
    Aguarda o botão 'Publicar' ficar habilitado (upload concluido no YouTube).
    Faz polling a cada 3s instead of depender de selectors frageis.
    """
    console.print("[bold blue][YOUTUBE][/bold blue] Aguardando upload concluir no YouTube...")
    start = time.time()
    tentativa = 0

    while time.time() - start < timeout_s:
        tentativa += 1
        try:
            # Estratégia 1: botão Publicar/Publish habilitado
            btn = page.locator(
                "ytcp-button#done-button:not([disabled]), "
                "button:has-text('Publicar'):not([disabled]), "
                "button:has-text('Publish'):not([disabled]), "
                "ytcp-button:has-text('Publicar')"
            ).first

            if btn.is_visible(timeout=2000) and btn.is_enabled(timeout=2000):
                console.print(f"[bold green][YOUTUBE][/bold green] Botao Publicar disponivel! (tentativa {tentativa})")
                return True
        except Exception:
            pass

        # Mostra progresso a cada 10 tentativas (~30s)
        elapsed = int(time.time() - start)
        if tentativa % 10 == 0:
            console.print(f"[dim][YOUTUBE] Aguardando... {elapsed}s decorridos[/dim]")

        time.sleep(3)

    console.print("[yellow][YOUTUBE] Timeout aguardando upload — tentando publicar mesmo assim[/yellow]")
    return False


def set_visibility_public(page) -> bool:
    """
    Define visibilidade como PUBLICO com múltiplas estratégias de fallback.
    Retorna True se bem sucedido.
    """
    console.print("[bold blue][YOUTUBE][/bold blue] Configurando visibilidade: PUBLICO...")

    strategies = [
        # Estratégia 1: radio button por name=PUBLIC
        lambda: page.locator("tp-yt-paper-radio-button[name='PUBLIC']").first.click(timeout=5000),
        # Estratégia 2: radio button por test-id
        lambda: page.locator("[test-id='PUBLIC']").first.click(timeout=5000),
        # Estratégia 3: por texto visível "Público"
        lambda: page.get_by_text("Público", exact=True).first.click(timeout=5000),
        lambda: page.get_by_text("Public", exact=True).first.click(timeout=5000),
        # Estratégia 4: label que contém "ú" (Público) dentro de radio group
        lambda: page.locator("ytcp-video-visibility-select tp-yt-paper-radio-button").nth(2).click(timeout=5000),
        # Estratégia 5: genérica — terceiro radio button na tela de visibilidade
        lambda: page.locator("tp-yt-paper-radio-button").nth(2).click(timeout=5000),
    ]

    for i, strategy in enumerate(strategies):
        try:
            strategy()
            human_delay(0.8, 1.5)
            console.print(f"[bold green][YOUTUBE][/bold green] Visibilidade PUBLICO definida (estrategia {i+1})")
            return True
        except Exception as e:
            console.print(f"[dim][YOUTUBE] Estrategia {i+1} falhou: {str(e)[:60]}[/dim]")

    console.print("[bold red][YOUTUBE] Nao foi possivel definir visibilidade PUBLICO automaticamente[/bold red]")
    return False


def click_publish(page) -> bool:
    """Clica no botão Publicar com múltiplas estratégias."""
    console.print("[bold blue][YOUTUBE][/bold blue] Clicando em Publicar...")

    strategies = [
        lambda: page.locator("ytcp-button#done-button").first.click(timeout=5000),
        lambda: page.get_by_role("button", name="Publicar").first.click(timeout=5000),
        lambda: page.get_by_role("button", name="Publish").first.click(timeout=5000),
        lambda: page.locator("ytcp-button:has-text('Publicar')").first.click(timeout=5000),
        lambda: page.locator("button:has-text('Publicar')").first.click(timeout=5000),
    ]

    for i, strategy in enumerate(strategies):
        try:
            strategy()
            console.print(f"[bold green][YOUTUBE][/bold green] Clique em Publicar executado (estrategia {i+1})")
            return True
        except Exception as e:
            console.print(f"[dim][YOUTUBE] Estrategia publicar {i+1} falhou: {str(e)[:60]}[/dim]")

    return False


def upload(video_path: str, metadata: dict) -> str | None:
    """
    Faz upload do vídeo via YouTube Studio com comportamento humano.
    Retorna a URL do Short publicado ou None em caso de erro.
    """
    from playwright.sync_api import sync_playwright, TimeoutError as PlaywrightTimeout

    titulo   = metadata.get("titulo", "Video Infantil")
    descricao = metadata.get("descricao", "") + "\n\n#Shorts #Infantil #Educativo #Criancas"
    video_path = str(Path(video_path).absolute())

    console.print("\n[bold blue][YOUTUBE][/bold blue] Iniciando upload humano via YouTube Studio...")
    console.print(f"[dim]  Arquivo : {video_path}[/dim]")
    console.print(f"[dim]  Titulo  : {titulo[:70]}[/dim]")
    console.print(f"[dim]  Perfil  : {PROFILE_DIR}[/dim]")

    with sync_playwright() as p:
        browser = p.chromium.launch_persistent_context(
            user_data_dir=PROFILE_DIR,
            headless=False,
            args=[
                "--start-maximized",
                "--disable-blink-features=AutomationControlled",
            ],
            no_viewport=True,
            slow_mo=80,  # delay suave em TODAS as açoes (mais humano)
        )

        page = browser.new_page()

        try:
            # 1. Acessa YouTube Studio
            console.print("[bold blue][YOUTUBE][/bold blue] Abrindo YouTube Studio...")
            page.goto("https://studio.youtube.com", wait_until="networkidle", timeout=30000)
            human_delay(2, 4)

            # 2. Verifica login
            if "accounts.google.com" in page.url:
                console.print("[bold yellow][YOUTUBE][/bold yellow] Faca login no navegador — aguardando ate 3 min...")
                page.wait_for_url("**/studio.youtube.com**", timeout=180000)
                console.print("[bold green][YOUTUBE][/bold green] Login detectado! Continuando...")
                human_delay(2, 3)

            # 3. Clica em "Criar" (botao no canto superior direito)
            console.print("[bold blue][YOUTUBE][/bold blue] Abrindo menu Criar...")
            criar_strategies = [
                lambda: page.locator("#create-icon").click(timeout=8000),
                lambda: page.get_by_text("Criar", exact=True).click(timeout=8000),
                lambda: page.locator("[aria-label='Criar']").click(timeout=8000),
                lambda: page.locator("ytcp-icon-button[id='create-icon']").click(timeout=8000),
            ]
            for fn in criar_strategies:
                try:
                    fn()
                    break
                except Exception:
                    pass
            human_delay(1.0, 2.0)

            # 4. Clica em "Enviar videos" (PT-BR: "Enviar vídeos")
            console.print("[bold blue][YOUTUBE][/bold blue] Clicando em Enviar videos...")
            enviar_strategies = [
                lambda: page.get_by_text("Enviar vídeos").click(timeout=8000),
                lambda: page.get_by_text("Enviar videos").click(timeout=8000),
                lambda: page.locator("tp-yt-paper-item").filter(has_text="Enviar").first.click(timeout=8000),
                lambda: page.locator("tp-yt-paper-item:has-text('Enviar')").first.click(timeout=8000),
                lambda: page.locator("tp-yt-paper-item:has-text('Upload')").first.click(timeout=8000),
                lambda: page.locator("tp-yt-paper-item:has-text('Fazer upload')").first.click(timeout=8000),
            ]
            for fn in enviar_strategies:
                try:
                    fn()
                    break
                except Exception:
                    pass
            human_delay(1.5, 2.5)

            # 5. Seleciona arquivo
            console.print("[bold blue][YOUTUBE][/bold blue] Selecionando arquivo de video...")
            with page.expect_file_chooser(timeout=15000) as fc_info:
                page.locator("input[type='file']").first.dispatch_event("click")
            fc_info.value.set_files(video_path)
            console.print("[bold blue][YOUTUBE][/bold blue] Arquivo enviado — aguardando tela de detalhes...")
            human_delay(4, 7)  # Aguarda YouTube processar o arquivo localmente

            # 6. Aguarda tela de detalhes
            page.wait_for_selector("#textbox, ytcp-video-title", timeout=60000)
            human_delay(2.0, 3.5)

            # 7. Preenche TÍTULO — digitação humana lenta
            console.print("[bold blue][YOUTUBE][/bold blue] Digitando titulo (modo humano lento)...")
            title_box = page.locator("#textbox").first
            title_box.click()
            human_delay(0.5, 1.0)
            title_box.press("Control+a")
            human_delay(0.3, 0.6)
            title_box.press("Backspace")
            human_delay(0.4, 0.8)
            for char in titulo:
                title_box.type(char, delay=random.randint(*TYPING_DELAY_TITLE_MS))
                # Pausa extra ocasional (humano pensa enquanto digita)
                if random.random() < 0.08:
                    time.sleep(random.uniform(0.3, 0.8))
            human_delay(1.2, 2.0)

            # 8. Preenche DESCRIÇÃO — digitação lenta
            console.print("[bold blue][YOUTUBE][/bold blue] Digitando descricao...")
            desc_candidates = [
                page.locator("#description-textarea #textbox"),
                page.locator("ytcp-social-suggestions-textbox #textbox").nth(1),
                page.locator("#textbox").nth(1),
            ]
            desc_box = None
            for candidate in desc_candidates:
                try:
                    if candidate.is_visible(timeout=3000):
                        desc_box = candidate
                        break
                except Exception:
                    pass

            if desc_box:
                desc_box.click()
                human_delay(0.6, 1.2)
                desc_text = descricao[:600]  # Limita para não demorar demais
                for char in desc_text:
                    desc_box.type(char, delay=random.randint(*TYPING_DELAY_DESC_MS))
                    if random.random() < 0.05:
                        time.sleep(random.uniform(0.2, 0.6))
            human_delay(1.5, 2.5)

            # 9. Marca "Feito para crianças"
            console.print("[bold blue][YOUTUBE][/bold blue] Configurando publico infantil...")
            try:
                kids_yes = page.locator("tp-yt-paper-radio-button[name='VIDEO_MADE_FOR_KIDS_MFK']").first
                kids_yes.click(timeout=5000)
                human_delay(0.8, 1.5)
            except Exception:
                console.print("[dim][YOUTUBE] Opcao 'Feito para criancas' nao encontrada nesta etapa[/dim]")

            # 10. Avança pelas páginas: Detalhes → Elementos → Verificações → Visibilidade
            for passo_nome in ["Detalhes", "Elementos", "Verificacoes"]:
                console.print(f"[dim][YOUTUBE] Avancando etapa: {passo_nome}...[/dim]")
                human_delay(1.0, 2.0)
                next_strategies = [
                    lambda: page.locator("ytcp-button#next-button").first.click(timeout=6000),
                    lambda: page.get_by_role("button", name="Proximo").first.click(timeout=6000),
                    lambda: page.get_by_role("button", name="Next").first.click(timeout=6000),
                    lambda: page.locator("button:has-text('Próximo'), button:has-text('Next')").first.click(timeout=6000),
                ]
                clicked = False
                for strategy in next_strategies:
                    try:
                        strategy()
                        clicked = True
                        break
                    except Exception:
                        pass
                if not clicked:
                    console.print(f"[yellow][YOUTUBE] Nao foi possivel avancar de '{passo_nome}'[/yellow]")
                human_delay(1.5, 2.5)

            # 11. Página de VISIBILIDADE — define PÚBLICO
            console.print("[bold blue][YOUTUBE][/bold blue] Pagina de visibilidade aberta...")
            human_delay(1.5, 3.0)  # Aguarda página carregar completamente

            vis_ok = set_visibility_public(page)
            if not vis_ok:
                console.print("[bold yellow][YOUTUBE][/bold yellow] ATENCAO: verifique visibilidade manualmente no navegador!")

            human_delay(1.5, 2.5)

            # 12. Aguarda upload do arquivo completar no servidor YouTube
            wait_for_publish_button(page, timeout_s=300)
            human_delay(1.0, 2.0)

            # 13. Clica em PUBLICAR
            human_delay(0.8, 1.5)
            click_ok = click_publish(page)
            if not click_ok:
                console.print("[bold yellow][YOUTUBE][/bold yellow] Clique automatico falhou — aguardando 20s para tentativa manual...")
                human_delay(20, 20)

            human_delay(4, 8)  # Aguarda animação de confirmação

            # 14. Captura URL do vídeo publicado
            video_url = None
            try:
                page.wait_for_selector(
                    "a[href*='youtu.be'], a[href*='youtube.com/shorts'], a[href*='youtube.com/watch']",
                    timeout=20000
                )
                link_el = page.locator(
                    "a[href*='youtu.be'], a[href*='youtube.com/shorts'], a[href*='youtube.com/watch']"
                ).first
                video_url = link_el.get_attribute("href")
                if video_url:
                    console.print(f"[bold green][YOUTUBE][/bold green] Publicado! URL: {video_url}")
            except PlaywrightTimeout:
                console.print("[yellow][YOUTUBE] URL nao capturada — verifique YouTube Studio[/yellow]")

            # Fecha modal
            human_delay(2, 4)
            try:
                page.locator("ytcp-button#close-button").first.click(timeout=5000)
            except Exception:
                pass

            return video_url

        except Exception as e:
            console.print(f"[bold red][YOUTUBE] Erro: {e}[/bold red]")
            try:
                ss = f"debug_{int(time.time())}.png"
                page.screenshot(path=ss)
                console.print(f"[dim]Screenshot: {ss}[/dim]")
            except Exception:
                pass
            return None

        finally:
            human_delay(3, 5)
            browser.close()
