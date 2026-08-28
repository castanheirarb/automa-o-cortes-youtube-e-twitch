import { z } from "zod";

export const CenaSchema = z.object({
    id: z.number(),
    tipo: z.string(),
    texto: z.string(),
    duracao_s: z.number(),
    prompt_imagem_ia: z.string(),
    duracao_real_s: z.number().optional(),
});

export const VideoMetadataSchema = z.object({
    tema: z.string(),
    titulo: z.string(),
    descricao: z.string(),
    tags: z.array(z.string()),
    imagens: z.array(z.string()),
    audio: z.string(),
    duracao_total_s: z.number(),
    duracao_total_real_s: z.number().optional(),
    cenas: z.array(CenaSchema),
});

export type Cena = z.infer<typeof CenaSchema>;
export type VideoMetadata = z.infer<typeof VideoMetadataSchema>;
