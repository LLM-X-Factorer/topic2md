import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { Article, PublishPlugin, PublishResult } from '@topic2md/shared';

export interface FilePublishOptions {
  outDir?: string;
  filename?: (article: Article) => string;
  overwrite?: boolean;
}

export function filePublish(options: FilePublishOptions = {}): PublishPlugin {
  const outDir = resolve(options.outDir ?? './out');
  const overwrite = options.overwrite ?? true;
  const filenameFn = options.filename ?? defaultFilename;

  return {
    name: 'file',
    async publish(article: Article): Promise<PublishResult> {
      await mkdir(outDir, { recursive: true });
      const name = filenameFn(article);
      const absolute = join(outDir, name);
      await writeFile(absolute, article.markdown, {
        encoding: 'utf8',
        flag: overwrite ? 'w' : 'wx',
      });
      return {
        location: absolute,
        meta: { bytes: Buffer.byteLength(article.markdown, 'utf8') },
      };
    },
  };
}

function defaultFilename(article: Article): string {
  const date = article.frontmatter.date || new Date().toISOString().slice(0, 10);
  const slug = slugify(article.frontmatter.title);
  return `${date}-${slug}.md`;
}

function slugify(input: string): string {
  const trimmed = input
    .trim()
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return trimmed || 'article';
}
