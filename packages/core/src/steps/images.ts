import { createStep } from '@mastra/core';
import type { ImagePlugin, SectionContent, Source } from '@topic2md/shared';
import { getRuntime } from '../context.js';
import { imagePlugins } from '../registry.js';
import { log, progress, stepEnd, stepError, stepStart, type EmitFn } from '../logger.js';
import { ImagesOutputSchema, SectionsOutputSchema } from './schemas.js';

export const imagesStep = createStep({
  id: 'images',
  description: 'Resolve a cover/inline image for each section via image plugins in parallel.',
  inputSchema: SectionsOutputSchema,
  outputSchema: ImagesOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { plugins, emit } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'images');
    try {
      const plugs = imagePlugins(plugins);
      if (plugs.length === 0) {
        log(emit, 'info', 'no image plugins configured — skipping');
        stepEnd(emit, 'images', started);
        return inputData;
      }
      progress(emit, 'images', `resolving images for ${inputData.sections.length} sections`);

      const assignments = assignSources(inputData.sections, inputData.sources);
      const sections = await Promise.all(
        inputData.sections.map((section, i) =>
          resolveImages(
            section,
            reorderWithAssigned(inputData.sources, assignments[i] ?? null),
            inputData.topic,
            plugs,
            emit,
            abortSignal,
          ),
        ),
      );
      const total = sections.reduce((n, s) => n + s.images.length, 0);
      log(emit, 'info', `images attached: ${total}`);
      stepEnd(emit, 'images', started);
      return { ...inputData, sections };
    } catch (err) {
      stepError(emit, 'images', err);
      throw err;
    }
  },
});

async function resolveImages(
  section: SectionContent,
  sources: Source[],
  topic: string,
  plugs: ImagePlugin[],
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<SectionContent> {
  if (!section.imageHint || plugs.length === 0 || sources.length === 0) return section;
  const request = { section, sources, topic };
  for (const plug of plugs) {
    try {
      const img = await plug.capture(request, { signal });
      if (img) {
        return { ...section, images: [...section.images, img] };
      }
    } catch (err) {
      log(
        emit,
        'warn',
        `image plugin "${plug.name}" failed for section "${section.id}": ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return section;
}

// Greedy dedupe with keyword-affinity tie-breaker. When sections outnumber
// sources we fall back to round-robin rather than leaving later sections
// without an image.
export function assignSources(
  sections: Pick<SectionContent, 'title' | 'points' | 'imageHint'>[],
  sources: Source[],
): (Source | null)[] {
  if (sources.length === 0) return sections.map(() => null);
  const used = new Set<string>();
  const assignments: (Source | null)[] = [];

  for (const section of sections) {
    const keywords = sectionKeywords(section);
    const ranked = [...sources].sort((a, b) => {
      const diff = keywordAffinity(b, keywords) - keywordAffinity(a, keywords);
      if (diff !== 0) return diff;
      return (b.score ?? 0) - (a.score ?? 0);
    });
    const pick = ranked.find((s) => !used.has(s.url)) ?? ranked[0] ?? null;
    if (pick) used.add(pick.url);
    assignments.push(pick);
  }
  return assignments;
}

function reorderWithAssigned(sources: Source[], assigned: Source | null): Source[] {
  if (!assigned) return sources;
  return [assigned, ...sources.filter((s) => s.url !== assigned.url)];
}

function sectionKeywords(
  section: Pick<SectionContent, 'title' | 'points' | 'imageHint'>,
): string[] {
  const tokens = new Set<string>();
  for (const src of [section.title, ...(section.imageHint?.keywords ?? []), ...section.points]) {
    for (const t of tokenize(src)) tokens.add(t);
  }
  return [...tokens];
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,.;:!?()[\]（）【】、，。；：！？/\\"'`~]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function keywordAffinity(source: Source, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const hay = `${source.title} ${source.snippet}`.toLowerCase();
  let n = 0;
  for (const k of keywords) if (hay.includes(k)) n++;
  return n;
}
