import { z } from 'zod';

export const SourceSchema = z.object({
  url: z.string().url(),
  title: z.string(),
  snippet: z.string().default(''),
  publishedAt: z.string().optional(),
  score: z.number().optional(),
  raw: z.unknown().optional(),
});

export type Source = z.infer<typeof SourceSchema>;
