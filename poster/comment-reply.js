// poster/comment-reply.js
// Geração de resposta a comentário via IA — espelha exatamente o padrão de
// poster/metadata.js: Gemini 2.5 Flash primário, fallback Groq em qualquer
// falha, JSON de resposta com fence-stripping.
//
// Diferente de metadata.js, aqui a IA também é a rede de segurança pra
// inferência de gênero (ver src/comment-bot/gender.js): quando o Censo do
// IBGE não reconhece o nome do comentarista, o mesmo modelo que já está
// gerando a resposta recebe instrução de arriscar um palpite prudente — ou,
// na dúvida, escrever de forma neutra. Nunca menciona a inferência.

import 'dotenv/config';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';
import { sanitizeTranscript } from './content-filter.js';
import { inferGenderFromName } from '../src/comment-bot/gender.js';

const CONFIDENT_GENDER_THRESHOLD = 0.7;

// ─── Vozes por canal ──────────────────────────────────────────────────────

const VOICE_PROMPTS = {
    main: `Você responde comentários do canal "Corte Certo 034", que posta cortes de
podcasts, reagts e streams de games (react/gaming/podcast em geral). Tom: energético,
descontraído, brasileiro, como um fã do canal respondendo outro fã. Pode usar 1 emoji,
no máximo. NUNCA fale de política, NUNCA prometa nada (sorteio, resposta de outro vídeo
etc.), NUNCA peça pra seguir/se inscrever de forma forçada.`,

    fe: `Você responde comentários do canal "Canal da Fé" / cortes do Bispo Bruno
Leonardo (conteúdo religioso cristão). Tom: caloroso, respeitoso, breve. FRONTEIRA DURA
(nunca cruzar): NUNCA dê conselho teológico ou pastoral, NUNCA interprete escritura,
NUNCA responda pedido de oração ou desabafo pessoal com algo além de um acolhimento
genérico e breve ("Que Deus abençoe! 🙏", "Estamos na torcida e na oração por você!"),
NUNCA tome posição doutrinária/denominacional, NUNCA fale de política. Se o comentário
fizer uma pergunta teológica de verdade, desvie com algo genérico e caloroso — não tente
responder a pergunta em si.`,

    infantil: `Você responde comentários do canal infantil (cortes do Luccas Neto e
vídeos educativos infantis). Tom: simples, seguro, animado, apropriado pra criança.
NUNCA pergunte ou faça referência a nome/idade/localização de quem comentou, NUNCA
sugira qualquer interação fora do YouTube, NUNCA use gírias adultas.`,

    gta6: `Você responde comentários do canal "FOCO NO GTAVI", dedicado a análise/reação
sobre o jogo GTA VI (Rockstar Games, lançamento 19/11/2026) — trailers, teorias,
comparações, vazamentos. Tom: animado, hype, brasileiro, como um fã hardcore da
franquia GTA respondendo outro fã. Pode usar 1 emoji de jogo/controle, no máximo.
NUNCA afirme como fato nada que não esteja confirmado oficialmente pela Rockstar
(teorias/vazamentos são especulação, trate como tal), NUNCA fale de política, NUNCA
prometa nada (sorteio, resposta de outro vídeo etc.).`,
};

function buildReplyPrompt(voice, { authorName, genderHint }) {
    const voicePrompt = VOICE_PROMPTS[voice] || VOICE_PROMPTS.main;

    return `${voicePrompt}

Responda ao comentário abaixo, em português do Brasil, com 1-2 frases curtas (respostas
longas parecem bot/spam). Nunca repita o comentário, nunca se apresente, nunca mencione
que você é uma IA. Nunca inclua links.

Sobre quem comentou (nome: "${authorName || 'desconhecido'}"): ${genderHint}

Responda em JSON estrito: {"resposta": "..."}`;
}

function buildGenderHint(genderInfo) {
    if (genderInfo.gender !== 'unknown' && genderInfo.confidence >= CONFIDENT_GENDER_THRESHOLD) {
        const label = genderInfo.gender === 'f' ? 'feminino' : 'masculino';
        return `gênero provável ${label} (fonte: dado estatístico) — pode flexionar `
            + `concordância nominal discretamente nesse sentido (ex.: "querido"/"querida"), `
            + `SEM NUNCA mencionar ou confirmar isso explicitamente.`;
    }
    return `gênero não identificado com segurança — se o nome der uma pista forte e óbvia, `
        + `pode arriscar um palpite prudente na flexão; se não tiver certeza, escreva de forma `
        + `NEUTRA (evite "obrigado"/"obrigada", prefira "valeu", "que bom", formas sem flexão de gênero).`;
}

function parseReplyJson(raw, source) {
    let parsed;
    try {
        parsed = JSON.parse(raw);
    } catch {
        const jsonMatch = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').match(/\{[\s\S]*\}/);
        if (!jsonMatch) throw new Error(`${source} não retornou JSON válido: ${raw.substring(0, 100)}`);
        parsed = JSON.parse(jsonMatch[0]);
    }
    if (!parsed.resposta || typeof parsed.resposta !== 'string') {
        throw new Error(`${source}: JSON sem campo "resposta": ${raw.substring(0, 100)}`);
    }
    return parsed.resposta.trim();
}

async function generateReplyWithGemini(commentText, prompt) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
    });

    const result = await model.generateContent(
        `${prompt}\n\nComentário:\n${sanitizeTranscript(commentText)}`
    );
    return parseReplyJson(result.response.text().trim(), 'Gemini');
}

async function generateReplyWithGroq(commentText, prompt) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada');

    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_COPY_MODEL || 'openai/gpt-oss-120b',
        // gpt-oss-120b gasta tokens de raciocínio interno ANTES do JSON de
        // saída — variável, medido até ~980 com prompts mais longos (ver
        // poster/metadata.js). reasoning_effort:'low' derruba isso pra
        // ~150-250 tokens sem perder qualidade; max_tokens com folga.
        reasoning_effort: 'low',
        max_tokens: 400,
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [
            { role: 'system', content: prompt },
            { role: 'user', content: `Comentário:\n${sanitizeTranscript(commentText)}` },
        ],
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error('Groq retornou resposta vazia.');
    return parseReplyJson(raw, 'Groq');
}

/**
 * Gera uma resposta de comentário via IA (Gemini primário, Groq fallback).
 * @param {string} commentText
 * @param {{ channelKey: string, authorName?: string }} opts
 * @returns {Promise<string>} texto da resposta (ainda não sanitizado — o
 *   chamador deve rodar poster/comment-safety.js's classifyOutgoingReply antes de publicar)
 */
export async function generateReply(commentText, { channelKey, authorName = '' } = {}) {
    const genderInfo = await inferGenderFromName(authorName).catch(() => ({ gender: 'unknown', confidence: 0, source: 'none' }));
    const genderHint = buildGenderHint(genderInfo);
    const voice = channelKey === 'fe' || channelKey === 'infantil' || channelKey === 'gta6' ? channelKey : 'main';
    const prompt = buildReplyPrompt(voice, { authorName, genderHint });

    const hasGemini = !!process.env.GEMINI_API_KEY?.trim();
    if (hasGemini) {
        try {
            return await generateReplyWithGemini(commentText, prompt);
        } catch (err) {
            logger.warn(`[Comment-Reply] Gemini falhou: ${err.message} — tentando Groq...`);
        }
    }
    return await generateReplyWithGroq(commentText, prompt);
}

// Execução standalone: node poster/comment-reply.js "texto" --channel main --author "Nome"
if (process.argv[1] && process.argv[1].endsWith('comment-reply.js')) {
    const args = process.argv.slice(2);
    const commentText = args[0];
    const channelIdx = args.indexOf('--channel');
    const authorIdx = args.indexOf('--author');
    const channelKey = channelIdx !== -1 ? args[channelIdx + 1] : 'main';
    const authorName = authorIdx !== -1 ? args[authorIdx + 1] : 'Teste';

    if (!commentText) {
        console.log('Uso: node poster/comment-reply.js "texto do comentario" [--channel main|fe|infantil] [--author "Nome"]');
        process.exit(1);
    }

    generateReply(commentText, { channelKey, authorName })
        .then((resposta) => console.log(JSON.stringify({ commentText, channelKey, authorName, resposta }, null, 2)))
        .catch((err) => { console.error('Falhou:', err.message); process.exit(1); });
}
