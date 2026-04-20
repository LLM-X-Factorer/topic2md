import { z } from 'zod';
import { SectionContentSchema } from './section.js';
import { SourceSchema } from './source.js';

export const FrontmatterSchema = z
  .object({
    title: z.string(),
    digest: z.string(),
    author: z.string().default('topic2md'),
    date: z.string(),
    tags: z.array(z.string()).default([]),
    model: z.string().optional(),
  })
  .passthrough();
export type Frontmatter = z.infer<typeof FrontmatterSchema>;

export const ArticleSchema = z.object({
  frontmatter: FrontmatterSchema,
  sections: z.array(SectionContentSchema),
  citations: z.array(SourceSchema),
  markdown: z.string(),
});
export type Article = z.infer<typeof ArticleSchema>;
