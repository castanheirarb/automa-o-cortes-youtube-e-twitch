// poster/accounts.js
// Contas ADICIONAIS (genéricas, no mesmo estilo do Corte Certo 034) que replicam
// os cortes de futebol publicados pela conta principal.
//
// A conta principal (profiles/chrome-youtube e profiles/chrome-tiktok, já
// configurada) nunca muda de comportamento — essas contas aqui são um destino
// EXTRA, processado sequencialmente DEPOIS da conta principal, nunca em
// paralelo (mesmo navegador Playwright por vez, mesmo upload-lock), pra não
// competir por CPU/rede com a atividade principal nem levantar suspeita de
// postar em várias contas ao mesmo tempo pela mesma máquina.
//
// Listas vazias = nenhuma distribuição extra acontece (comportamento idêntico
// a antes desta feature existir).
//
// Para ativar uma conta:
//   1. node poster/login.js --platform youtube --profile ./profiles/chrome-youtube-02
//      (ou --platform tiktok)
//   2. Faça login manual na conta genérica quando o navegador abrir
//   3. Adicione a entrada abaixo com o mesmo profileDir

export const EXTRA_YOUTUBE_ACCOUNTS = [
    // NÃO adicionar o chrome-youtube-02 aqui: é o canal religioso, com conteúdo
    // próprio via persona 'bispobrunoleonardo' (src/capturer/personas.js).
    // Colocá-lo nesta lista replicaria cortes de futebol no canal errado.
];

export const EXTRA_TIKTOK_ACCOUNTS = [
    // { id: 'tt-02', profileDir: './profiles/chrome-tiktok-02', label: 'Conta 2' },
];
