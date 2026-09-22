// src/content-optimizer/index.js
// Gera 3 variantes de título e escolhe a mais viral.

import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../../poster/logger.js';
import { sanitizeMetadataText } from '../../poster/content-filter.js';
import { isGeminiQuotaExhausted, isGeminiQuotaError, markGeminiQuotaExhausted } from '../utils/gemini-quota-guard.js';

const OPTIMIZER_PROMPT = `Você é uma pessoa de verdade revisando um título antes de postar, tentando
deixá-lo mais interessante sem parecer clickbait de bot. Gere 3 variantes do
mesmo título. A melhor variante deve ser a primeira da lista.

Título Original: "{{originalTitle}}"
Transcrição: "{{transcript}}"

ÂNGULOS POSSÍVEIS (são ideias de ASSUNTO, não moldes de frase — nunca "RÓTULO
EM CAIXA ALTA: frase entre aspas" toda vez; varie a estrutura de cada variante):
- reação genuína a algo surpreendente no clipe
- revelação de um detalhe específico (não genérico)
- uma pergunta curta e real sobre o que acontece
- citação direta de uma frase marcante do próprio clipe
- constatação simples/direta, sem forçar drama

COMO SOA HUMANO (evite, denuncia texto de bot):
- Repetir a mesma estrutura nas 3 variantes — varie de verdade (uma pode ser
  pergunta, outra afirmação, outra citação)
- Exagerar em CAIXA ALTA — no máximo 1-2 palavras em destaque por variante,
  às vezes zero; o resto em minúsculas normais
- Frases genéricas que serviriam pra qualquer vídeo do canal — seja
  específico sobre o que REALMENTE acontece nesse clipe

REGRAS INVIOLÁVEIS:
- 40-70 caracteres cada variante
- ZERO palavrões ou linguagem ofensiva
- Não revele o final do vídeo — crie gancho de curiosidade
- Cada variante deve usar uma abordagem diferente

Responda APENAS com JSON válido:
{"variants":["variante1","variante2","variante3"]}`;

export async function optimizeContent(metadata) {
    const apiKey = process.env.GEMINI_API_KEY?.trim();
    if (!apiKey || !metadata.titulo || !metadata.transcript) return metadata;
    if (isGeminiQuotaExhausted()) return metadata;

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
        if (isGeminiQuotaError(err)) markGeminiQuotaExhausted();
        logger.warn(`[Optimizer] Falha: ${err.message}. Usando título original.`);
        return metadata;
    }
}
