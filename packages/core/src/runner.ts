import { RuntimeContext } from '@mastra/core/runtime-context';
import type { PluginConfig, WorkflowInput, WorkflowResult } from '@topic2md/shared';
import { buildRuntime, RUNTIME_KEY } from './context.js';
import { createLLM, type LLM } from './llm.js';
import type { EmitFn } from './logger.js';
import { noopEmit } from './logger.js';
import { assertPluginConfig } from './registry.js';
import { createTopic2mdWorkflow, type Topic2mdWorkflow } from './workflow.js';

export interface RunTopic2mdOptions {
  plugins: PluginConfig;
  llm?: LLM;
  emit?: EmitFn;
  signal?: AbortSignal;
  model?: string;
}

export async function runTopic2md(
  input: WorkflowInput,
  options: RunTopic2mdOptions,
): Promise<WorkflowResult> {
  assertPluginConfig(options.plugins);
  const llm = options.llm ?? createLLM({ defaultModel: options.model });
  const model = options.model ?? input.model ?? llm.defaultModel;
  const emit = options.emit ?? noopEmit;

  const workflow: Topic2mdWorkflow = createTopic2mdWorkflow();
  const run = await workflow.createRunAsync();

  const runtimeContext = new RuntimeContext();
  runtimeContext.set(
    RUNTIME_KEY,
    buildRuntime({ plugins: options.plugins, llm, emit, model }),
  );

  const result = await run.start({
    inputData: { topic: input.topic, model },
    runtimeContext,
  });

  if (result.status !== 'success') {
    const reason =
      result.status === 'failed'
        ? result.error instanceof Error
          ? result.error.message
          : String(result.error)
        : `workflow suspended at ${result.suspended.map((p) => p.join('.')).join(', ')}`;
    throw new Topic2mdRunError(`topic2md workflow did not complete: ${reason}`, result);
  }

  return result.result;
}

export class Topic2mdRunError extends Error {
  readonly runResult: unknown;
  constructor(message: string, runResult: unknown) {
    super(message);
    this.name = 'Topic2mdRunError';
    this.runResult = runResult;
  }
}
