// bilibili/sources.js
// Fontes de vídeo a clipar para a Bilibili — conteúdo de entretenimento
// chinês. Douyin ficou de fora por enquanto (yt-dlp exige cookie de sessão
// fresco pra baixar de lá — ver histórico da conversa; login web em
// andamento). Pivotado para canais do YOUTUBE em mandarim: sem parede de
// login/cookie, mesmo extrator já usado pra todas as outras personas deste
// projeto, e cobrindo o nicho mais forte da própria Bilibili (games).
//
// Dois modos, verificados nesta ordem por getNextSource():
//   1. CURATED_SOURCES / BILIBILI_SOURCES — vídeo individual específico
//      (útil pra testar uma URL pontual, ou pra fontes tipo link de
//      compartilhamento do Douyin quando isso for resolvido).
//   2. CURATED_CHANNELS — canal inteiro; escaneia os vídeos recentes e pega
//      o mais visto ainda não tentado (mesmo padrão do GTA VI Hunter, ver
//      src/trend-hunter/gta6-capture.js).
//
// Canais validados ao vivo em 31/08/2026-02/09/2026 (yt-dlp --dump-json
// confirmado retornando vídeos reais, sem erro de auth):
//   陈一发儿 (@chenyifaer)  — streamer da China continental (Chongqing),
//                             games + chat/canto. 29K-143K views/vídeo.
//                             /videos SEM replay de chat (repost editado de
//                             outra plataforma) — cai sempre no fallback de
//                             vídeo inteiro em chat-peaks.js.
//   阿神Kouki                — Taiwanês, Minecraft, um dos maiores canais de
//                             games em mandarim (1.3B views totais). Mesma
//                             observação: /videos sem replay de chat.
//   李聽 (@leelisten2017)   — VTuber taiwanesa, PUBG/games. Aponta pra aba
//                             /streams (não /videos!) DE PROPÓSITO — é onde
//                             ficam as lives arquivadas de verdade
//                             (live_status="was_live"), com replay de chat
//                             confirmado (live_chat.json, 1775 mensagens
//                             testadas num vídeo real) — é a fonte que
//                             valida o corte por pico de chat-peaks.js.
//                             ATENÇÃO: nem todo vídeo do canal é apropriado
//                             (tem conteúdo picante em playlist de membros
//                             fora do /streams) — o filtro de duração/pico
//                             ajuda, mas vale checar o resultado real.
// Não é lista definitiva — mesmo aviso do GTA VI Hunter: valide o resultado
// real (clipe bom? conteúdo apropriado pro nicho?) antes de confiar cegamente
// em produção, e adicione/remova canais conforme o desempenho real.

export const CURATED_SOURCES = [
    // Vídeos individuais pontuais — vazio até haver um caso de uso pra isso
    // (ex.: link de compartilhamento do Douyin validado).
];

export const CURATED_CHANNELS = [
    'https://www.youtube.com/@chenyifaer/videos',
    'https://www.youtube.com/channel/UCnJEWsS5agXCkqIpyHC9Grg/videos', // 阿神Kouki
    'https://www.youtube.com/@leelisten2017/streams', // 李聽 — tem replay de chat de verdade
];

// Teste EXPLÍCITO (decisão de 03/09/2026, não é migração de canal): de vez em
// quando, tenta um clipe do Casimiro reagindo a algo bem visual/não-verbal
// (esporte, dublê, pet, produto) em vez de conteúdo chinês — a aposta é que
// "estranheza" de um idioma diferente pode ser gancho, não problema, pro
// público da Bilibili (achado de pesquisa: criadores estrangeiros crescendo
// lá NÃO apesar do sotaque/idioma, mas por causa dele). Ver bilibili/run.js
// (BILIBILI_BR_EXPERIMENT_RATE controla a frequência) — nunca é a maioria dos
// posts, só uma amostragem ocasional pra validar a hipótese com dado real.
// Canal validado ao vivo em 03/09/2026. Aponta pra aba /shorts (não /videos!)
// DE PROPÓSITO — /videos só tem reações longas (15-60min, sem replay de chat,
// sempre estoura o teto de fallback e é pulado); /shorts tem cortes curtos e
// bem visuais de verdade (raposa vs gato, pet novo, Homem-Aranha — 14K-723K
// views). yt-dlp --flat-playlist não retorna duração pra Shorts (vem 0/undefined)
// — bilibili/scout.js trata isso como "provavelmente curto, deixa passar" só
// pra esse pool, não pro resto do projeto.
export const EXPERIMENTAL_BR_CHANNELS = [
    'https://www.youtube.com/@CortesdoCasimitoOFICIAL/shorts', // Cortes do Casimito
];

// Roblox — decisão de 05/09/2026 (pedido explícito do usuário): prioriza
// conteúdo de Roblox nos posts do canal, além do pool chinês/BR já existente.
// Pesquisa (mesma sessão) não achou streamer de Roblox confiável em mandarim
// — canais fonte aqui são em INGLÊS, tratados como conteúdo majoritariamente
// VISUAL (jump scares, reações, gameplay caótico/cômico), mesma aposta do
// teste BR: pula nossa legenda (não traduz Whisper pra zh, geraria lixo),
// deixa o clipe falar por si, título/descrição em chinês vêm do contexto
// (título+descrição originais), não de tradução literal. Note: China tem uma
// versão local regulada chamada 罗布乐思 (Luobu) — vale usar os dois nomes
// (Roblox e 罗布乐思) nas tags pra cobrir quem busca por qualquer um dos dois.
// Validados ao vivo em 05/09/2026 via yt-dlp:
//   KreekCraft (@KreekCraft) — um dos maiores YouTubers de Roblox (Blox
//                              Fruits, Doors, etc.), /streams tem lives
//                              arquivadas de verdade (chat real, ver
//                              chat-peaks.js).
//   Flamingo (@flamingo)      — maior canal de comédia/Roblox do YouTube
//                              (shorts com 18M+ views), NÃO tem /streams (só
//                              conteúdo editado) — sem chat, cai no fallback
//                              por views. Duração 0 no flat-playlist (Shorts)
//                              é tratado como elegível, igual ao pool BR.
export const ROBLOX_CHANNELS = [
    'https://www.youtube.com/@KreekCraft/streams',
    'https://www.youtube.com/@flamingo/shorts',
];

export function getRobloxChannels() {
    const fromEnv = (process.env.BILIBILI_ROBLOX_CHANNELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    return [...new Set([...ROBLOX_CHANNELS, ...fromEnv])];
}

export function getSources() {
    const fromEnv = (process.env.BILIBILI_SOURCES || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    return [...new Set([...CURATED_SOURCES, ...fromEnv])];
}

export function getChannels() {
    const fromEnv = (process.env.BILIBILI_CHANNELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    return [...new Set([...CURATED_CHANNELS, ...fromEnv])];
}

export function getExperimentalBrChannels() {
    const fromEnv = (process.env.BILIBILI_BR_CHANNELS || '')
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

    return [...new Set([...EXPERIMENTAL_BR_CHANNELS, ...fromEnv])];
}
