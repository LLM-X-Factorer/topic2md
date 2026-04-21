import type { RuntimeContext } from '@mastra/core/runtime-context';
import type { PluginConfig } from '@topic2md/shared';
import type { LLM } from './llm.js';
import type { EmitFn } from './logger.js';
import { noopEmit } from './logger.js';
import type { DatabaseType } from './persistence.js';

export interface Topic2mdRuntime {
  plugins: PluginConfig;
  llm: LLM;
  emit: EmitFn;
  model: string;
  /** Optional SQLite handle — enables cross-run caches (e.g. CLIP image embeddings). */
  db?: DatabaseType;
}

export const RUNTIME_KEY = 'topic2md' as const;

export function getRuntime(ctx: RuntimeContext): Topic2mdRuntime {
  const runtime = ctx.get(RUNTIME_KEY) as Topic2mdRuntime | undefined;
  if (!runtime) {
    throw new Error(
      `topic2md runtime missing from RuntimeContext. Use runTopic2md() or set runtimeContext.set('${RUNTIME_KEY}', ...).`,
    );
  }
  return runtime;
}

export function buildRuntime(
  partial: Partial<Topic2mdRuntime> & Pick<Topic2mdRuntime, 'plugins' | 'llm'>,
): Topic2mdRuntime {
  return {
    emit: noopEmit,
    model: partial.llm.defaultModel,
    ...partial,
  };
}
