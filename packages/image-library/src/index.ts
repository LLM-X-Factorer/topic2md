import { z } from 'zod';
import type { ImagePlugin, ImageRef, ImageRequest } from '@topic2md/shared';

export interface UnsplashImageOptions {
  accessKey: string;
  orientation?: 'landscape' | 'portrait' | 'squarish';
  contentFilter?: 'low' | 'high';
  language?: string;
  timeoutMs?: number;
  endpoint?: string;
}

const DEFAULT_ENDPOINT = 'https://api.unsplash.com/search/photos';

const UnsplashUserSchema = z
  .object({
    name: z.string().optional(),
    links: z
      .object({
        html: z.string().url().optional(),
      })
      .passthrough()
      .optional(),
  })
  .passthrough();

const UnsplashPhotoSchema = z
  .object({
    id: z.string(),
    alt_description: z.string().nullable().optional(),
    description: z.string().nullable().optional(),
    urls: z.object({
      regular: z.string().url(),
      small: z.string().url().optional(),
      full: z.string().url().optional(),
    }),
    links: z
      .object({
        html: z.string().url().optional(),
      })
      .passthrough()
      .optional(),
    width: z.number().int().optional(),
    height: z.number().int().optional(),
    user: UnsplashUserSchema.optional(),
  })
  .passthrough();

const UnsplashSearchResponseSchema = z.object({
  results: z.array(UnsplashPhotoSchema).default([]),
});

export function unsplashImage(options: UnsplashImageOptions): ImagePlugin {
  if (!options.accessKey) {
    throw new Error('unsplashImage: accessKey is required (Unsplash Access Key).');
  }
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const timeoutMs = options.timeoutMs ?? 10_000;

  return {
    name: 'unsplash',
    async capture(request: ImageRequest): Promise<ImageRef | null> {
      const query = buildQuery(request);
      if (!query) return null;
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const url = new URL(endpoint);
        url.searchParams.set('query', query);
        url.searchParams.set('per_page', '1');
        if (options.orientation) url.searchParams.set('orientation', options.orientation);
        if (options.contentFilter) url.searchParams.set('content_filter', options.contentFilter);
        if (options.language) url.searchParams.set('lang', options.language);

        const res = await fetch(url.toString(), {
          headers: {
            authorization: `Client-ID ${options.accessKey}`,
            'accept-version': 'v1',
          },
          signal: ctrl.signal,
        });
        if (!res.ok) return null;
        const payload = UnsplashSearchResponseSchema.parse(await res.json());
        const hit = payload.results[0];
        if (!hit) return null;
        const alt = hit.alt_description ?? hit.description ?? request.section.title;
        return {
          url: hit.urls.regular,
          alt: alt.slice(0, 200),
          sourceUrl: hit.links?.html,
          caption: hit.user?.name ? `© ${hit.user.name} / Unsplash` : 'Unsplash',
          kind: 'library',
          width: hit.width,
          height: hit.height,
        };
      } catch {
        return null;
      } finally {
        clearTimeout(t);
      }
    },
  };
}

function buildQuery(request: ImageRequest): string | null {
  const tokens = new Set<string>();
  for (const raw of [
    ...(request.section.imageHint?.keywords ?? []),
    request.section.title,
    request.topic,
  ]) {
    for (const t of tokenize(raw)) tokens.add(t);
  }
  const query = [...tokens].slice(0, 4).join(' ').trim();
  return query.length > 0 ? query : null;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,.;:!?()[\]（）【】、，。；：！？/\\"'`~]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}
