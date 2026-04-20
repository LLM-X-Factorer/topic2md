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

/**
 * One candidate returned by an ImagePlugin.discover() call. Many candidates
 * from multiple plugins are merged, then a downstream reranker (typically a
 * vision LLM) picks at most one and materialises it into an ImageRef.
 */
export interface ImageCandidate {
  url: string;
  alt?: string;
  caption?: string;
  /** Short snippet of surrounding page text — helps the reranker decide relevance. */
  surroundingText?: string;
  /** URL of the page this image was extracted from (if any). */
  sourceUrl?: string;
  kind: ImageKind;
  width?: number;
  height?: number;
  /** Name of the ImagePlugin that produced this candidate. Set by core. */
  pluginName?: string;
}
