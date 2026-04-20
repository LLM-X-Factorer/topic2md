import { createStep } from '@mastra/core';
import { getRuntime } from '../context.js';
import { primarySource } from '../registry.js';
import { log, progress, stepEnd, stepError, stepStart } from '../logger.js';
import { ResearchOutputSchema, WorkflowInputSchema } from './schemas.js';

export const researchStep = createStep({
  id: 'research',
  description: 'Collect authoritative sources for the topic via the first configured source plugin.',
  inputSchema: WorkflowInputSchema,
  outputSchema: ResearchOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { plugins, emit } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'research');
    try {
      const source = primarySource(plugins);
      progress(emit, 'research', `querying source "${source.name}" for topic: ${inputData.topic}`);
      const sources = await source.research(inputData.topic, { signal: abortSignal });
      log(emit, 'info', `research returned ${sources.length} sources`);
      stepEnd(emit, 'research', started);
      return { topic: inputData.topic, sources };
    } catch (err) {
      stepError(emit, 'research', err);
      throw err;
    }
  },
});
