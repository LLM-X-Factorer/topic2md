import { z } from 'zod';
import type { Article, PublishOptions, PublishPlugin, PublishResult } from '@topic2md/shared';

export interface PublishMd2wechatOptions {
  baseUrl: string;
  author?: string;
  theme?: string;
  enableComment?: boolean;
  coverStrategy?: 'sharp' | 'ai';
  coverPrompt?: string;
  webhookUrl?: string;
  timeoutMs?: number;
  filename?: (article: Article) => string;
}

const PublishResponseSchema = z.discriminatedUnion('success', [
  z.object({
    success: z.literal(true),
    data: z
      .object({
        publishId: z.string(),
        mediaId: z.string(),
        title: z.string(),
        author: z.string(),
        coverUrl: z.string().optional(),
        coverStrategy: z.string(),
        publishedAt: z.string(),
      })
      .passthrough(),
  }),
  z.object({
    success: z.literal(false),
    error: z
      .object({
        code: z.string(),
        message: z.string(),
        step: z.string().optional(),
      })
      .passthrough(),
  }),
]);

export function publishMd2wechat(options: PublishMd2wechatOptions): PublishPlugin {
  if (!options.baseUrl) {
    throw new Error('publishMd2wechat: baseUrl is required (e.g. http://localhost:3000).');
  }
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/api/publish`;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const filenameFn = options.filename ?? defaultFilename;

  return {
    name: 'md2wechat',
    async publish(article: Article, opts?: PublishOptions): Promise<PublishResult> {
      const fm = article.frontmatter;
      const filename = filenameFn(article);
      const form = new FormData();
      form.append(
        'article',
        new Blob([article.markdown], { type: 'text/markdown;charset=utf-8' }),
        filename,
      );

      const theme = options.theme ?? (typeof fm.theme === 'string' ? fm.theme : undefined);
      const author = options.author ?? fm.author;
      const digest = fm.digest;
      const enableComment =
        options.enableComment ??
        (typeof fm.enableComment === 'boolean' ? fm.enableComment : undefined);

      if (author) form.append('author', author);
      if (theme) form.append('theme', theme);
      if (digest) form.append('digest', digest);
      if (enableComment !== undefined)
        form.append('enableComment', enableComment ? 'true' : 'false');
      if (options.coverStrategy) form.append('coverStrategy', options.coverStrategy);
      if (options.coverPrompt) form.append('coverPrompt', options.coverPrompt);
      if (options.webhookUrl) form.append('webhookUrl', options.webhookUrl);

      const signal = combineSignals(opts?.signal, timeoutMs);
      const res = await fetch(endpoint, { method: 'POST', body: form, signal });

      const payload = PublishResponseSchema.parse(await res.json());
      if (!payload.success) {
        throw new Error(
          `md2wechat publish failed: [${payload.error.code}${payload.error.step ? ` @ ${payload.error.step}` : ''}] ${payload.error.message}`,
        );
      }
      const { publishId, mediaId, title, publishedAt, coverUrl } = payload.data;
      return {
        location: `${options.baseUrl.replace(/\/$/, '')}/history/${publishId}`,
        meta: { publishId, mediaId, title, publishedAt, coverUrl },
      };
    },
  };
}

function defaultFilename(article: Article): string {
  const title = article.frontmatter.title.trim() || 'article';
  const slug = title
    .replace(/[\s\u3000]+/g, '-')
    .replace(/[\\/:*?"<>|]+/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-|-$/g, '');
  return `${slug || 'article'}.md`;
}

function combineSignals(external: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const ctrl = new AbortController();
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true });
  }
  setTimeout(
    () => ctrl.abort(new Error(`md2wechat publish timed out after ${timeoutMs}ms`)),
    timeoutMs,
  );
  return ctrl.signal;
}
