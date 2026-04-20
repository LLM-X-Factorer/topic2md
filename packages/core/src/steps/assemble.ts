import { createStep } from '@mastra/core';
import type { Frontmatter } from '@topic2md/shared';
import { getRuntime } from '../context.js';
import { themePlugins } from '../registry.js';
import { log, progress, stepEnd, stepError, stepStart } from '../logger.js';
import { toArticle } from '../markdown.js';
import { AssembleOutputSchema, ImagesOutputSchema } from './schemas.js';

export const assembleStep = createStep({
  id: 'assemble',
  description:
    'Build frontmatter (via theme plugins) and stitch sections + citations into markdown.',
  inputSchema: ImagesOutputSchema,
  outputSchema: AssembleOutputSchema,
  execute: async ({ inputData, runtimeContext }) => {
    const { plugins, emit, model } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'assemble');
    try {
      progress(emit, 'assemble', 'building frontmatter and markdown');
      let frontmatter: Frontmatter = {
        title: inputData.title,
        digest: inputData.digest,
        author: 'topic2md',
        date: new Date().toISOString().slice(0, 10),
        tags: [],
        model,
      };
      for (const theme of themePlugins(plugins)) {
        frontmatter = await theme.decorate(frontmatter, {
          topic: inputData.topic,
          sources: inputData.sources,
        });
      }
      const article = toArticle(frontmatter, inputData.sections, inputData.sources);
      log(emit, 'info', `assembled article: ${article.markdown.length} chars`);
      stepEnd(emit, 'assemble', started);
      return { topic: inputData.topic, article };
    } catch (err) {
      stepError(emit, 'assemble', err);
      throw err;
    }
  },
});
