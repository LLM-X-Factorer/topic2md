import { createStep } from '@mastra/core';
import { getRuntime } from '../context.js';
import { primaryPublish } from '../registry.js';
import { log, progress, stepEnd, stepError, stepStart } from '../logger.js';
import { AssembleOutputSchema, PublishOutputSchema } from './schemas.js';

export const publishStep = createStep({
  id: 'publish',
  description: 'Publish the assembled article via the first configured publish plugin.',
  inputSchema: AssembleOutputSchema,
  outputSchema: PublishOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { plugins, emit } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'publish');
    try {
      const publisher = primaryPublish(plugins);
      progress(emit, 'publish', `publishing via "${publisher.name}"`);
      const res = await publisher.publish(inputData.article, { signal: abortSignal });
      log(emit, 'info', `published to ${res.location}`);
      stepEnd(emit, 'publish', started);
      return { location: res.location, markdown: inputData.article.markdown };
    } catch (err) {
      stepError(emit, 'publish', err);
      throw err;
    }
  },
});
