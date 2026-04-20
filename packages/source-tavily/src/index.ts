import { z } from 'zod';
import type { ResearchOptions, Source, SourcePlugin } from '@topic2md/shared';

export interface TavilySourceOptions {
  apiKey: string;
  endpoint?: string;
  searchDepth?: 'basic' | 'advanced';
  maxResults?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
  includeRawContent?: boolean;
  topic?: 'general' | 'news' | 'finance';
  timeoutMs?: number;
}

const DEFAULT_ENDPOINT = 'https://api.tavily.com/search';

const TavilyResultSchema = z.object({
  title: z.string().default(''),
  url: z.string().url(),
  content: z.string().default(''),
  score: z.number().optional(),
  published_date: z.string().optional(),
  raw_content: z.string().nullish(),
});

const TavilyResponseSchema = z.object({
  query: z.string().optional(),
  results: z.array(TavilyResultSchema).default([]),
});

export function tavilySource(options: TavilySourceOptions): SourcePlugin {
  if (!options.apiKey) {
    throw new Error('tavilySource: apiKey is required (TAVILY_API_KEY).');
  }
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  return {
    name: 'tavily',
    async research(topic: string, reqOpts?: ResearchOptions): Promise<Source[]> {
      // Tavily's `query` is a retrieval search string, not natural language,
      // so pasting a multi-sentence background into it hurts recall. We
      // accept the option for interface parity but deliberately ignore it
      // here; upstream LLM steps (outline/sections) still see the background.
      void reqOpts?.background;
      const body = {
        query: topic,
        search_depth: options.searchDepth ?? 'advanced',
        max_results: reqOpts?.maxResults ?? options.maxResults ?? 8,
        include_answer: false,
        include_raw_content: options.includeRawContent ?? false,
        include_images: false,
        topic: options.topic ?? 'general',
        include_domains: options.includeDomains,
        exclude_domains: options.excludeDomains,
      };

      const signal = combineSignals(reqOpts?.signal, options.timeoutMs);

      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${options.apiKey}`,
        },
        body: JSON.stringify(body),
        signal,
      });

      if (!res.ok) {
        const text = await safeReadText(res);
        throw new Error(`Tavily request failed: ${res.status} ${res.statusText} — ${text}`);
      }

      const payload = TavilyResponseSchema.parse(await res.json());

      return payload.results.map((r) => ({
        url: r.url,
        title: r.title || r.url,
        snippet: r.content,
        publishedAt: r.published_date,
        score: r.score,
        raw: r.raw_content ?? undefined,
      }));
    },
  };
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
      () => ctrl.abort(new Error(`Tavily request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  }
  return ctrl.signal;
}

async function safeReadText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable response body>';
  }
}
