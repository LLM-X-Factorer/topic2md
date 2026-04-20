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
      const sections = await Promise.all(
        inputData.sections.map((section) =>
          resolveImages(section, inputData.sources, inputData.topic, plugs, emit, abortSignal),
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
  if (!section.imageHint || plugs.length === 0) return section;
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
