import { z } from 'zod';

export const ImageKind = z.enum(['screenshot', 'og', 'inline', 'library']);
export type ImageKind = z.infer<typeof ImageKind>;

export const ImageRefSchema = z.object({
  url: z.string(),
  alt: z.string(),
  sourceUrl: z.string().url().optional(),
  caption: z.string().optional(),
  kind: ImageKind,
  width: z.number().int().positive().optional(),
  height: z.number().int().positive().optional(),
});

export type ImageRef = z.infer<typeof ImageRefSchema>;
