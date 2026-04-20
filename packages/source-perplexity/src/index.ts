import { z } from 'zod';
import type { ResearchOptions, Source, SourcePlugin } from '@topic2md/shared';

export interface PerplexitySourceOptions {
  apiKey: string;
  model?: string;
  endpoint?: string;
  searchRecencyFilter?: 'month' | 'week' | 'day' | 'hour';
  searchDomainFilter?: string[];
  maxResults?: number;
  timeoutMs?: number;
  systemPrompt?: string;
}

const DEFAULT_ENDPOINT = 'https://api.perplexity.ai/chat/completions';
const DEFAULT_MODEL = 'sonar-pro';
const DEFAULT_SYSTEM = [
  '你是一名资料检索助理。用户会给你一个话题，请调用联网搜索返回最权威的资料。',
  '你的回答必须简短，不要尝试总结——工具把 citations 字段返回就足够。',
].join(' ');

const MessageSchema = z
  .object({
    role: z.string(),
    content: z.string(),
  })
  .passthrough();

const CitationSchema = z.union([
  z.string().url(),
  z
    .object({
      url: z.string().url(),
      title: z.string().optional(),
      snippet: z.string().optional(),
    })
    .passthrough(),
]);

const SearchResultSchema = z
  .object({
    url: z.string().url(),
    title: z.string().optional(),
    snippet: z.string().optional(),
    date: z.string().optional(),
  })
  .passthrough();

const PerplexityResponseSchema = z
  .object({
    choices: z.array(z.object({ message: MessageSchema }).passthrough()).default([]),
    citations: z.array(CitationSchema).default([]),
    search_results: z.array(SearchResultSchema).default([]),
  })
  .passthrough();

export function perplexitySource(options: PerplexitySourceOptions): SourcePlugin {
  if (!options.apiKey) {
    throw new Error('perplexitySource: apiKey is required (PERPLEXITY_API_KEY).');
  }
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;

  return {
    name: 'perplexity',
    async research(topic: string, reqOpts?: ResearchOptions): Promise<Source[]> {
      const maxResults = reqOpts?.maxResults ?? options.maxResults ?? 8;
      const body = {
        model: options.model ?? DEFAULT_MODEL,
        messages: [
          { role: 'system', content: options.systemPrompt ?? DEFAULT_SYSTEM },
          { role: 'user', content: topic },
        ],
        search_recency_filter: options.searchRecencyFilter,
        search_domain_filter: options.searchDomainFilter,
        return_citations: true,
        return_search_results: true,
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
        const text = await safeText(res);
        throw new Error(`Perplexity request failed: ${res.status} ${res.statusText} — ${text}`);
      }
      const parsed = PerplexityResponseSchema.parse(await res.json());
      return normalize(parsed, maxResults);
    },
  };
}

function normalize(
  response: z.infer<typeof PerplexityResponseSchema>,
  maxResults: number,
): Source[] {
  const byUrl = new Map<string, Source>();
  for (const sr of response.search_results) {
    byUrl.set(sr.url, {
      url: sr.url,
      title: sr.title ?? sr.url,
      snippet: sr.snippet ?? '',
      publishedAt: sr.date,
    });
  }
  for (const c of response.citations) {
    if (typeof c === 'string') {
      if (!byUrl.has(c)) byUrl.set(c, { url: c, title: c, snippet: '' });
    } else {
      const existing = byUrl.get(c.url);
      byUrl.set(c.url, {
        url: c.url,
        title: c.title ?? existing?.title ?? c.url,
        snippet: c.snippet ?? existing?.snippet ?? '',
        publishedAt: existing?.publishedAt,
      });
    }
  }
  return [...byUrl.values()].slice(0, maxResults);
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
      () => ctrl.abort(new Error(`Perplexity request timed out after ${timeoutMs}ms`)),
      timeoutMs,
    );
  }
  return ctrl.signal;
}

async function safeText(res: Response): Promise<string> {
  try {
    return (await res.text()).slice(0, 500);
  } catch {
    return '<unreadable response body>';
  }
}
