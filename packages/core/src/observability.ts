import type { WorkflowEvent, WorkflowStep } from '@topic2md/shared';
import type { EmitFn } from './logger.js';

export interface LangfuseObserverOptions {
  publicKey?: string;
  secretKey?: string;
  baseUrl?: string;
  traceName?: string;
  release?: string;
  metadata?: Record<string, unknown>;
  passthrough?: EmitFn;
}

export interface LangfuseObserver {
  emit: EmitFn;
  flush(): Promise<void>;
}

interface LangfuseLike {
  trace(input: Record<string, unknown>): LangfuseTraceLike;
  shutdownAsync(): Promise<void>;
}

interface LangfuseTraceLike {
  span(input: Record<string, unknown>): LangfuseSpanLike;
  generation(input: Record<string, unknown>): LangfuseGenerationLike;
  update(input: Record<string, unknown>): void;
  event(input: Record<string, unknown>): void;
}

interface LangfuseSpanLike {
  end(input?: Record<string, unknown>): void;
}

interface LangfuseGenerationLike {
  end(input?: Record<string, unknown>): void;
}

export async function createLangfuseObserver(
  topic: string,
  options: LangfuseObserverOptions = {},
): Promise<LangfuseObserver> {
  const publicKey = options.publicKey ?? process.env.LANGFUSE_PUBLIC_KEY;
  const secretKey = options.secretKey ?? process.env.LANGFUSE_SECRET_KEY;
  const baseUrl = options.baseUrl ?? process.env.LANGFUSE_HOST;
  const passthrough = options.passthrough;

  if (!publicKey || !secretKey) {
    return {
      emit: (event) => passthrough?.(event),
      async flush() {},
    };
  }

  const mod = await import('langfuse').catch(() => null);
  if (!mod) {
    throw new Error(
      'Langfuse observability enabled but the "langfuse" package is not installed. Run `pnpm add langfuse`.',
    );
  }
  const LangfuseCtor = (mod as { Langfuse: new (opts: Record<string, unknown>) => LangfuseLike })
    .Langfuse;
  const client = new LangfuseCtor({ publicKey, secretKey, baseUrl });

  const trace = client.trace({
    name: options.traceName ?? 'topic2md',
    input: { topic },
    metadata: options.metadata,
    release: options.release,
  });

  const spans = new Map<WorkflowStep, LangfuseSpanLike>();
  const generations = new Map<string, { gen: LangfuseGenerationLike; model: string }>();

  const emit: EmitFn = (event: WorkflowEvent) => {
    passthrough?.(event);
    switch (event.type) {
      case 'step.start': {
        spans.set(event.step, trace.span({ name: event.step, startTime: new Date(event.at) }));
        return;
      }
      case 'step.end': {
        spans
          .get(event.step)
          ?.end({ endTime: new Date(event.at), metadata: { durationMs: event.durationMs } });
        spans.delete(event.step);
        return;
      }
      case 'step.error': {
        spans.get(event.step)?.end({
          endTime: new Date(event.at),
          level: 'ERROR',
          statusMessage: event.error,
        });
        spans.delete(event.step);
        trace.update({ output: { error: event.error }, level: 'ERROR' });
        return;
      }
      case 'progress':
      case 'log': {
        trace.event({
          name: event.type === 'progress' ? `progress:${event.step}` : `log:${event.level}`,
          input:
            event.type === 'progress'
              ? event.message
              : { level: event.level, message: event.message },
          startTime: new Date(event.at),
        });
        return;
      }
      case 'generation.start': {
        const gen = trace.generation({
          name: `${event.kind}:${event.model}`,
          model: event.model,
          startTime: new Date(event.at),
        });
        generations.set(event.id, { gen, model: event.model });
        return;
      }
      case 'generation.end': {
        const record = generations.get(event.id);
        if (!record) return;
        record.gen.end({
          endTime: new Date(event.at),
          usage: event.usage,
          metadata: {
            durationMs: event.durationMs,
            finishReason: event.finishReason,
            model: event.model,
          },
          level: event.finishReason === 'error' ? 'ERROR' : undefined,
        });
        generations.delete(event.id);
        return;
      }
      case 'generation.fallback': {
        trace.event({
          name: 'generation.fallback',
          input: {
            failedModel: event.failedModel,
            nextModel: event.nextModel,
            error: event.error,
          },
          startTime: new Date(event.at),
          level: 'WARNING',
        });
        return;
      }
    }
  };

  return {
    emit,
    async flush() {
      await client.shutdownAsync();
    },
  };
}
