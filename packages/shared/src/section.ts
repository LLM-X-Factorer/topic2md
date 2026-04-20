import { z } from 'zod';
import { ImageRefSchema } from './image.js';

export const ImageHintSchema = z.object({
  purpose: z.string(),
  keywords: z.array(z.string()).optional(),
});
export type ImageHint = z.infer<typeof ImageHintSchema>;

export const SectionOutlineSchema = z.object({
  id: z.string(),
  title: z.string(),
  points: z.array(z.string()),
  imageHint: ImageHintSchema.optional(),
});
export type SectionOutline = z.infer<typeof SectionOutlineSchema>;

export const SectionContentSchema = SectionOutlineSchema.extend({
  markdown: z.string(),
  images: z.array(ImageRefSchema).default([]),
  citations: z.array(z.string().url()).default([]),
});
export type SectionContent = z.infer<typeof SectionContentSchema>;

export const OutlineSchema = z.object({
  title: z.string(),
  digest: z.string(),
  sections: z.array(SectionOutlineSchema).min(1),
});
export type Outline = z.infer<typeof OutlineSchema>;
