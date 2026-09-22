// bilibili/metadata.js
// Gera título/descrição/tags em CHINÊS (mandarim simplificado) para um clipe —
// Gemini como primário, Groq como fallback em qualquer falha, mesma estratégia
// do poster/metadata.js, mas com prompt e banco de fórmulas próprios (nada de
// PT-BR aqui, nada de PERSONAS_MAP/branding dos outros canais — projeto
// isolado). Reaproveita só as CHAVES de API já configuradas no .env raiz.

import 'dotenv/config';
import Groq from 'groq-sdk';
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from './logger.js';

function buildPrompt(contextText) {
    return `你是B站（哔哩哔哩）的爆款视频文案撰写人。根据下面提供的视频信息，生成JSON格式的元数据。

规则：
1. 标题最多40个汉字，吸引点击但不夸张造假（不做诱导党）
2. 描述2-3句话，简体中文，可以包含1-2个相关话题标签（#标签#格式）
3. 提供4-6个简体中文标签（数组），适合B站分区（游戏/动画/娱乐等）
4. 绝对不能包含色情、暴力、政治敏感、辱骂或任何违反B站社区规范的内容
5. 只输出纯JSON，不要markdown代码块，不要任何解释文字

JSON格式：
{"title": "...", "desc": "...", "tags": ["tag1", "tag2", "tag3", "tag4"]}

视频信息：
${contextText}`;
}

function parseJsonResponse(raw) {
    let metadata;
    try {
        metadata = JSON.parse(raw);
    } catch {
        const match = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '').match(/\{[\s\S]*\}/);
        if (!match) throw new Error(`Resposta não é JSON válido: ${raw.slice(0, 120)}`);
        metadata = JSON.parse(match[0]);
    }
    if (!metadata.title || !metadata.desc || !Array.isArray(metadata.tags) || metadata.tags.length === 0) {
        throw new Error(`JSON incompleto: ${raw.slice(0, 120)}`);
    }
    return metadata;
}

async function generateWithGemini(contextText) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: { temperature: 0.6, responseMimeType: 'application/json' },
    });

    const result = await model.generateContent(buildPrompt(contextText));
    return parseJsonResponse(result.response.text().trim());
}

async function generateWithGroq(contextText) {
    const apiKey = process.env.GROQ_API_KEY?.trim();
    if (!apiKey) throw new Error('GROQ_API_KEY não configurada');

    const groq = new Groq({ apiKey });
    const completion = await groq.chat.completions.create({
        model: process.env.GROQ_COPY_MODEL || 'openai/gpt-oss-120b',
        // reasoning_effort:'low' é obrigatório aqui — sem isso o gpt-oss-120b
        // consome o max_tokens inteiro em raciocínio oculto antes do JSON de
        // saída (mesma causa raiz documentada em poster/metadata.js).
        reasoning_effort: 'low',
        max_tokens: 500,
        temperature: 0.6,
        response_format: { type: 'json_object' },
        messages: [{ role: 'user', content: buildPrompt(contextText) }],
    });

    const raw = completion.choices[0]?.message?.content?.trim();
    if (!raw) throw new Error('Groq retornou resposta vazia.');
    return parseJsonResponse(raw);
}

/**
 * Gera metadados em chinês pra um clipe, a partir de um texto de contexto
 * (título original da fonte, transcrição resumida, tema do trend-radar etc.).
 * Gemini primário, Groq como fallback em qualquer falha — nunca lança sem
 * antes tentar os dois.
 *
 * @param {string} contextText
 * @returns {Promise<{ title: string, desc: string, tags: string[] }>}
 */
export async function generateChineseMetadata(contextText) {
    try {
        const metadata = await generateWithGemini(contextText);
        logger.success(`[Bilibili/Metadata] Gemini: "${metadata.title}"`);
        return metadata;
    } catch (err) {
        logger.warn(`[Bilibili/Metadata] Gemini falhou (${err.message}) — tentando Groq...`);
    }

    const metadata = await generateWithGroq(contextText);
    logger.success(`[Bilibili/Metadata] Groq: "${metadata.title}"`);
    return metadata;
}

// ─── Self-test: node bilibili/metadata.js "<contexto>" ───────────────────────
if (process.argv[1] && process.argv[1].endsWith('metadata.js')) {
    const contextText = process.argv[2] || '一个游戏主播的搞笑高光时刻';
    generateChineseMetadata(contextText)
        .then((m) => { console.log(JSON.stringify(m, null, 2)); process.exitCode = 0; })
        .catch((err) => { console.error('Erro fatal:', err.message); process.exitCode = 1; });
}
