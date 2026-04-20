import { z } from 'zod';
import type { Frontmatter, ThemeContext, ThemePlugin } from '@topic2md/shared';

export interface ThemeMd2wechatOptions {
  baseUrl: string;
  theme?: string;
  author?: string;
  enableComment?: boolean;
  coverStrategy?: 'sharp' | 'ai';
  coverPrompt?: string;
  timeoutMs?: number;
}

const ThemesResponseSchema = z.object({
  builtin: z.array(z.string()).default([]),
  custom: z
    .array(
      z
        .object({
          name: z.string(),
        })
        .passthrough(),
    )
    .default([]),
});

export function themeMd2wechat(options: ThemeMd2wechatOptions): ThemePlugin {
  if (!options.baseUrl) {
    throw new Error('themeMd2wechat: baseUrl is required (e.g. http://localhost:3000).');
  }
  const endpoint = `${options.baseUrl.replace(/\/$/, '')}/api/themes`;
  const timeoutMs = options.timeoutMs ?? 5_000;
  let themeListPromise: Promise<string[]> | null = null;

  async function listThemes(): Promise<string[]> {
    if (!themeListPromise) {
      themeListPromise = (async () => {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), timeoutMs);
        try {
          const res = await fetch(endpoint, { signal: ctrl.signal });
          if (!res.ok) {
            throw new Error(`md2wechat /api/themes failed: ${res.status} ${res.statusText}`);
          }
          const parsed = ThemesResponseSchema.parse(await res.json());
          return [...parsed.builtin, ...parsed.custom.map((c) => c.name)];
        } finally {
          clearTimeout(t);
        }
      })().catch((err) => {
        themeListPromise = null;
        throw err;
      });
    }
    return themeListPromise;
  }

  return {
    name: 'theme-md2wechat',
    async decorate(frontmatter: Frontmatter, _ctx: ThemeContext): Promise<Frontmatter> {
      const available = await listThemes();
      if (available.length === 0) {
        throw new Error(
          'themeMd2wechat: md2wechat reports zero available themes. Ensure at least one built-in or custom theme is registered.',
        );
      }

      const requested = options.theme;
      const theme =
        requested && available.includes(requested) ? requested : (available[0] as string);

      const enriched: Frontmatter = {
        ...frontmatter,
        theme,
      };
      if (options.author) enriched.author = options.author;
      if (options.enableComment !== undefined) enriched.enableComment = options.enableComment;
      if (options.coverStrategy) enriched.coverStrategy = options.coverStrategy;
      if (options.coverPrompt) enriched.coverPrompt = options.coverPrompt;

      return enriched;
    },
  };
}
