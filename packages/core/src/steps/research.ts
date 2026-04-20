import { createStep } from '@mastra/core';
import type { Source, SourcePlugin } from '@topic2md/shared';
import { getRuntime } from '../context.js';
import { log, progress, stepEnd, stepError, stepStart, type EmitFn } from '../logger.js';
import { ResearchOutputSchema, WorkflowInputSchema } from './schemas.js';

export const researchStep = createStep({
  id: 'research',
  description:
    'Collect authoritative sources for the topic by querying all configured source plugins in parallel and merging results by URL.',
  inputSchema: WorkflowInputSchema,
  outputSchema: ResearchOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { plugins, emit } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'research');
    try {
      const pool = plugins.sources;
      if (pool.length === 0) {
        throw new Error('research: no source plugins configured — enable at least one.');
      }
      progress(
        emit,
        'research',
        `querying ${pool.length} source${pool.length === 1 ? '' : 's'} (${pool.map((s) => s.name).join(', ')}) for topic: ${inputData.topic}${inputData.background ? ` (with background)` : ''}`,
      );

      const results = await Promise.allSettled(
        pool.map((src) =>
          src.research(inputData.topic, {
            signal: abortSignal,
            background: inputData.background,
          }),
        ),
      );
      const perSource = results.map((r, i) => annotate(pool[i] as SourcePlugin, r, emit));
      const merged = mergeSources(perSource);

      if (merged.length === 0) {
        const errors = results
          .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
          .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
        throw new Error(
          `research: every source plugin failed or returned empty.${errors.length ? ` Errors: ${errors.join('; ')}` : ''}`,
        );
      }

      log(
        emit,
        'info',
        `research merged ${merged.length} unique sources from ${pool.length} plugin${pool.length === 1 ? '' : 's'}`,
      );
      stepEnd(emit, 'research', started);
      return { topic: inputData.topic, background: inputData.background, sources: merged };
    } catch (err) {
      stepError(emit, 'research', err);
      throw err;
    }
  },
});

interface AnnotatedResult {
  plugin: SourcePlugin;
  sources: Source[];
}

function annotate(
  plugin: SourcePlugin,
  result: PromiseSettledResult<Source[]>,
  emit: EmitFn,
): AnnotatedResult {
  if (result.status === 'fulfilled') {
    return { plugin, sources: result.value };
  }
  log(
    emit,
    'warn',
    `research source "${plugin.name}" failed: ${result.reason instanceof Error ? result.reason.message : String(result.reason)}`,
  );
  return { plugin, sources: [] };
}

// Merge sources from multiple plugins, de-duplicating by normalized URL.
// Keep the longest available snippet, the earliest non-empty title, and
// the max score seen. Order: highest-score first.
export function mergeSources(perSource: AnnotatedResult[]): Source[] {
  const byKey = new Map<string, { source: Source; origins: Set<string> }>();

  for (const { plugin, sources } of perSource) {
    for (const s of sources) {
      const key = normalizeUrl(s.url);
      const existing = byKey.get(key);
      if (!existing) {
        byKey.set(key, { source: { ...s }, origins: new Set([plugin.name]) });
        continue;
      }
      existing.origins.add(plugin.name);
      existing.source = {
        url: existing.source.url,
        title: existing.source.title || s.title,
        snippet:
          s.snippet.length > existing.source.snippet.length ? s.snippet : existing.source.snippet,
        publishedAt: existing.source.publishedAt ?? s.publishedAt,
        score: Math.max(existing.source.score ?? 0, s.score ?? 0) || undefined,
        raw: existing.source.raw ?? s.raw,
      };
    }
  }

  return [...byKey.values()]
    .map(({ source, origins }) => ({
      ...source,
      // Boost score by fraction of sources that agree (cross-source corroboration).
      score: source.score !== undefined ? source.score + (origins.size - 1) * 0.05 : undefined,
    }))
    .sort((a, b) => (b.score ?? 0) - (a.score ?? 0));
}

function normalizeUrl(input: string): string {
  try {
    const u = new URL(input);
    u.hash = '';
    const stripParams = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content'];
    for (const p of stripParams) u.searchParams.delete(p);
    if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }
    return u.toString();
  } catch {
    return input;
  }
}
