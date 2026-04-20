import { z } from 'zod';
import type {
  ImageCandidate,
  ImageOptions,
  ImagePlugin,
  ImageRequest,
  SectionOutline,
} from '@topic2md/shared';

export interface TavilyImageOptions {
  apiKey: string;
  endpoint?: string;
  /**
   * Max images per section. Tavily returns up to `max_results`; we ask for
   * a bit more than we expect the reranker to look at so it has options.
   */
  maxResults?: number;
  timeoutMs?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  searchDepth?: 'basic' | 'advanced';
}

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search';

const TavilyImageEntrySchema = z.union([
  z.string().url(),
  z
    .object({
      url: z.string().url(),
      description: z.string().optional(),
    })
    .passthrough(),
]);

const TavilyResponseSchema = z.object({
  images: z.array(TavilyImageEntrySchema).default([]),
});

export function tavilyImage(options: TavilyImageOptions): ImagePlugin {
  if (!options.apiKey) {
    throw new Error('tavilyImage: apiKey is required (TAVILY_API_KEY).');
  }
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const maxResults = options.maxResults ?? 5;
  const timeoutMs = options.timeoutMs ?? 15_000;
  const searchDepth = options.searchDepth ?? 'basic';

  return {
    name: 'tavily-image',
    async discover(request: ImageRequest, reqOpts?: ImageOptions): Promise<ImageCandidate[]> {
      const query = buildQuery(request.section, request.topic);
      if (!query) return [];

      const signal = combineSignals(reqOpts?.signal, timeoutMs);
      const body = {
        query,
        search_depth: searchDepth,
        max_results: maxResults,
        include_answer: false,
        include_raw_content: false,
        include_images: true,
        include_image_descriptions: true,
        include_domains: options.includeDomains,
        exclude_domains: options.excludeDomains,
      };

      let res: Response;
      try {
        res = await fetch(endpoint, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${options.apiKey}`,
          },
          body: JSON.stringify(body),
          signal,
        });
      } catch {
        return [];
      }

      if (!res.ok) return [];
      let payload: z.infer<typeof TavilyResponseSchema>;
      try {
        payload = TavilyResponseSchema.parse(await res.json());
      } catch {
        return [];
      }

      return payload.images.map<ImageCandidate>((entry) => {
        if (typeof entry === 'string') {
          return { url: entry, kind: 'library' as const };
        }
        return {
          url: entry.url,
          alt: entry.description,
          caption: entry.description,
          kind: 'library' as const,
        };
      });
    },
  };
}

function buildQuery(section: SectionOutline, topic: string): string {
  const parts = [
    topic,
    section.title,
    ...(section.imageHint?.keywords ?? []),
    section.imageHint?.purpose ?? '',
  ]
    .map((s) => s.trim())
    .filter(Boolean);
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const p of parts) {
    const key = p.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(p);
  }
  return unique.slice(0, 5).join(' ').slice(0, 300);
}

function combineSignals(
  external: AbortSignal | undefined,
  timeoutMs: number | undefined,
): AbortSignal | undefined {
  if (!external && !timeoutMs) return undefined;
  const ctrl = new AbortController();
  if (external) {
    if (external.aborted) ctrl.abort(external.reason);
    else external.addEventListener('abort', () => ctrl.abort(external.reason), { once: true });
  }
  if (timeoutMs) {
    setTimeout(
      () => ctrl.abort(new Error(`tavilyImage request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  }
  return ctrl.signal;
}
