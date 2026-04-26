// src/trend-hunter/ranker.js
import { GoogleGenerativeAI } from '@google/generative-ai';
import { logger } from '../utils/logger.js';

export async function rankTargets(targets) {
    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) throw new Error('GEMINI_API_KEY não configurada.');

    const genAI = new GoogleGenerativeAI(apiKey);
    const model = genAI.getGenerativeModel({
        model: process.env.GEMINI_MODEL || 'gemini-2.5-flash',
        generationConfig: { temperature: 0.3, maxOutputTokens: 2048 },
    });

    const prompt = `Você é um Analista de Viralidade especialista em YouTube Shorts e TikTok. Analise a lista de vídeos/clips abaixo e selecione os 10 com maior potencial para gerar cortes virais.

**Critérios de Avaliação:**
- Potencial de Polêmica/Debate: Títulos que geram discussão.
- Emoção Forte: Conteúdo que evoca surpresa, raiva, humor, etc.
- Relevância Atual: Assuntos em alta no momento.
- Alto View Count Recente: Prova de popularidade.

**Lista de Alvos:**
${JSON.stringify(targets, null, 2)}

Responda EXCLUSIVAMENTE com um JSON contendo uma chave "top10", que é um array com os 10 melhores alvos. Para cada alvo, inclua os campos originais e adicione "score" (0-100) e "justificativa" curta.`;

    logger.info('[TrendHunter/Ranker] Solicitando análise de viralidade ao Gemini...');

    const result = await model.generateContent(prompt);
    const raw = result.response.text().trim();
    const cleaned = raw.replace(/```(?:json)?\n?/g, '').replace(/```/g, '');
    const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
    if (!jsonMatch) throw new Error(`Ranker não retornou JSON válido: ${raw}`);

    const parsed = JSON.parse(jsonMatch[0]);
    logger.success('[TrendHunter/Ranker] Top 10 alvos recebidos da IA.');
    return parsed.top10 || [];
}
