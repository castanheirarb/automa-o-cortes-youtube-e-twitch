// src/content-optimizer/index.js
// Gera 3 variantes de título e escolhe a mais viral.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../poster/logger.js';
import { sanitizeMetadataText } from '../../poster/content-filter.js';

const OPTIMIZER_PROMPT = `Você é um especialista em CTR (Click-Through Rate) do YouTube. Gere 3 variantes de títulos virais para o mesmo vídeo. A melhor variante deve ser a primeira da lista.

Título Original: "{{originalTitle}}"
Transcrição: "{{transcript}}"

Fórmulas de Sucesso (inspire-se, NÃO copie literalmente):
- REAÇÃO: "[STREAMER] REAGE: [ASSUNTO SURPREENDENTE]"
- REVELAÇÃO: "SEI A VERDADE SOBRE [ASSUNTO POLÊMICO]"
- CONFRONTO: "[PESSOA] BRIGOU/SAIU/CHOROU AO VIVO"
- PERGUNTA CHOCANTE: "[ASSUNTO] É UM CAMINHO SEM VOLTA?"
- CITAÇÃO DIRETA: "\\"[FRASE MARCANTE]\\" - NOME"
- FAIL/HUMOR: "[STREAMER] PASSOU A MAIOR VERGONHA AO VIVO"

REGRAS:
- 40-70 caracteres cada variante
- CAIXA ALTA em palavras-chave para impacto
- ZERO palavrões ou linguagem ofensiva
- Não revele o final do vídeo — crie gancho de curiosidade
- Cada variante deve usar uma abordagem diferente

Responda APENAS com JSON válido:
{"variants":["variante1","variante2","variante3"]}`;

export async function optimizeContent(metadata) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || !metadata.titulo || !metadata.transcript) return metadata;

    logger.info('[Optimizer] Gerando 3 variantes de título para máximo CTR...');

    // Preserva o sufixo de branding ("| Cortes do X") do título original
    const brandingMatch = metadata.titulo.match(/(\|\s*Cortes\s+do\s+\S+[\s\S]*)$/i);
    const brandingSuffix = brandingMatch ? ` ${brandingMatch[1].trim()}` : '';
    const titleWithoutBranding = brandingMatch
        ? metadata.titulo.slice(0, brandingMatch.index).trim()
        : metadata.titulo;

    const prompt = OPTIMIZER_PROMPT
        .replace('{{originalTitle}}', titleWithoutBranding)
        .replace('{{transcript}}', metadata.transcript.substring(0, 500));

    try {
        const genAI = new GoogleGenerativeAI(apiKey);
        const model = genAI.getGenerativeModel({
            model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
            generationConfig: {
                temperature: 0.7,
                responseMimeType: 'application/json',
            },
        });

        const result = await model.generateContent(prompt);
        const raw = result.response.text().trim();

        let optimized;
        try {
            optimized = JSON.parse(raw);
        } catch {
            const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '');
            const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
            if (!jsonMatch) throw new Error(`JSON inválido: ${raw.substring(0, 80)}`);
            optimized = JSON.parse(jsonMatch[0]);
        }

        if (optimized.variants?.length > 0) {
            const bestTitle = `${sanitizeMetadataText(optimized.variants[0])}${brandingSuffix}`.trim();
            if (bestTitle.length >= 20) {
                logger.success(`[Optimizer] Título otimizado: "${bestTitle}"`);
                return { ...metadata, titulo: bestTitle };
            }
        }
        return metadata;
    } catch (err) {
        logger.warn(`[Optimizer] Falha: ${err.message}. Usando título original.`);
        return metadata;
    }
}
