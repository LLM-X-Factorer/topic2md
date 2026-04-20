import { z } from 'zod';
import {
  ArticleSchema,
  OutlineSchema,
  SectionContentSchema,
  SectionOutlineSchema,
  SourceSchema,
} from '@topic2md/shared';

export const WorkflowInputSchema = z.object({
  topic: z.string().min(1),
  model: z.string().optional(),
});
export type WorkflowInputValue = z.infer<typeof WorkflowInputSchema>;

export const ResearchOutputSchema = z.object({
  topic: z.string(),
  sources: z.array(SourceSchema),
});
export type ResearchOutput = z.infer<typeof ResearchOutputSchema>;

export const OutlineOutputSchema = z.object({
  topic: z.string(),
  sources: z.array(SourceSchema),
  outline: OutlineSchema,
});
export type OutlineOutput = z.infer<typeof OutlineOutputSchema>;

export const SectionsOutputSchema = z.object({
  topic: z.string(),
  sources: z.array(SourceSchema),
  title: z.string(),
  digest: z.string(),
  sections: z.array(SectionContentSchema),
});
export type SectionsOutput = z.infer<typeof SectionsOutputSchema>;

export const ImagesOutputSchema = SectionsOutputSchema;
export type ImagesOutput = z.infer<typeof ImagesOutputSchema>;

export const AssembleOutputSchema = z.object({
  topic: z.string(),
  article: ArticleSchema,
});
export type AssembleOutput = z.infer<typeof AssembleOutputSchema>;

export const PublishOutputSchema = z.object({
  location: z.string(),
  markdown: z.string(),
});
export type PublishOutput = z.infer<typeof PublishOutputSchema>;

export { SectionOutlineSchema, SectionContentSchema, OutlineSchema };
