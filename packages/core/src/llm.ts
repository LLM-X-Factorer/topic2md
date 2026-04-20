import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import { nanoid } from 'nanoid';
import type { z } from 'zod';
import type { GenerationUsage } from '@topic2md/shared';
import type { EmitFn } from './logger.js';
import { noopEmit } from './logger.js';

export interface GenerateObjectOptions<T extends z.ZodType> {
  schema: T;
  prompt: string;
  system?: string;
  model?: string;
  signal?: AbortSignal;
  maxTokens?: number;
  /**
   * Image URLs to include as multi-modal input alongside `prompt`. Each entry
   * becomes a content part in a user message. Only honoured by vision-capable
   * models — passing images to a text-only model yields a provider error.
   */
  images?: { url: string }[];
}

export interface GenerateTextOptions {
  prompt: string;
  system?: string;
  model?: string;
  signal?: AbortSignal;
  maxTokens?: number;
}

export type FinishReason =
  | 'stop'
  | 'length'
  | 'content-filter'
  | 'tool-calls'
  | 'error'
  | 'other'
  | 'unknown';

export interface GenerateObjectResult<T> {
  object: T;
  finishReason: FinishReason;
  usage?: GenerationUsage;
}

export interface GenerateTextResult {
  text: string;
  finishReason: FinishReason;
  usage?: GenerationUsage;
}

export interface LLM {
  readonly defaultModel: string;
  generate<T extends z.ZodType>(
    opts: GenerateObjectOptions<T>,
  ): Promise<GenerateObjectResult<z.infer<T>>>;
  generateText(opts: GenerateTextOptions): Promise<GenerateTextResult>;
}

export interface LLMOptions {
  defaultModel?: string;
  apiKey?: string;
  baseURL?: string;
  /**
   * Additional models to retry against if the primary model fails. Applied
   * in order; the primary is tried first. A successful fallback emits a
   * `generation.fallback` workflow event.
   */
  fallbackModels?: string[];
  /**
   * Workflow emit function. When provided, createLLM emits
   * `generation.start` / `generation.end` / `generation.fallback` events so
   * observers (e.g. Langfuse) can report per-call telemetry.
   */
  emit?: EmitFn;
}

const DEFAULT_MODEL = 'openrouter/anthropic/claude-sonnet-4-6';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function createLLM(opts: LLMOptions = {}): LLM {
  const defaultModel = opts.defaultModel ?? process.env.DEFAULT_MODEL ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;
  const emit = opts.emit ?? noopEmit;
  const fallbackModels = opts.fallbackModels ?? [];

  if (!apiKey) {
    throw new LLMNotConfiguredError(
      'OPENROUTER_API_KEY is not set. Either set the env var or inject a custom LLM via runTopic2md({ llm }).',
    );
  }

  const openrouter = createOpenAI({
    baseURL: opts.baseURL ?? OPENROUTER_BASE,
    apiKey,
  });

  async function withFallback<R>(
    kind: 'object' | 'text',
    primary: string,
    id: string,
    call: (modelId: string) => Promise<R>,
  ): Promise<R> {
    const chain = [primary, ...fallbackModels.filter((m) => m !== primary)];
    let lastError: unknown;
    for (let i = 0; i < chain.length; i++) {
      const candidate = chain[i] as string;
      const modelId = normalizeModelId(candidate);
      try {
        return await call(modelId);
      } catch (err) {
        lastError = err;
        const next = chain[i + 1];
        if (next) {
          emit({
            type: 'generation.fallback',
            id,
            failedModel: candidate,
            nextModel: next,
            error: err instanceof Error ? err.message : String(err),
            at: Date.now(),
          });
        }
      }
    }
    void kind;
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }

  return {
    defaultModel,
    async generate({ schema, prompt, system, model, signal, maxTokens, images }) {
      const primary = model ?? defaultModel;
      const id = nanoid(10);
      const started = Date.now();
      emit({ type: 'generation.start', id, model: primary, kind: 'object', at: started });
      try {
        const res = await withFallback('object', primary, id, async (modelId) =>
          generateObject({
            model: openrouter(modelId),
            schema,
            abortSignal: signal,
            maxTokens,
            // OpenRouter-routed providers (MiniMax, GLM, …) have been
            // returning malformed JSON via the tool-call path ~20% of the
            // time. JSON mode (response_format=json_object) has been
            // dramatically more reliable in practice.
            mode: 'json',
            ...(images && images.length > 0
              ? {
                  messages: [
                    {
                      role: 'user' as const,
                      content: [
                        { type: 'text' as const, text: prompt },
                        ...images.map((img) => ({
                          type: 'image' as const,
                          image: img.url,
                        })),
                      ],
                    },
                  ],
                  ...(system ? { system } : {}),
                }
              : { prompt, ...(system ? { system } : {}) }),
          }),
        );
        const usage = normalizeUsage(res.usage);
        const finishReason = normalizeFinishReason(res.finishReason);
        emit({
          type: 'generation.end',
          id,
          model: primary,
          at: Date.now(),
          durationMs: Date.now() - started,
          finishReason,
          usage,
        });
        return { object: res.object, finishReason, usage };
      } catch (err) {
        emit({
          type: 'generation.end',
          id,
          model: primary,
          at: Date.now(),
          durationMs: Date.now() - started,
          finishReason: 'error',
        });
        throw err;
      }
    },
    async generateText({ prompt, system, model, signal, maxTokens }) {
      const primary = model ?? defaultModel;
      const id = nanoid(10);
      const started = Date.now();
      emit({ type: 'generation.start', id, model: primary, kind: 'text', at: started });
      try {
        const res = await withFallback('text', primary, id, async (modelId) =>
          generateText({
            model: openrouter(modelId),
            system,
            prompt,
            abortSignal: signal,
            maxTokens,
          }),
        );
        const usage = normalizeUsage(res.usage);
        const finishReason = normalizeFinishReason(res.finishReason);
        emit({
          type: 'generation.end',
          id,
          model: primary,
          at: Date.now(),
          durationMs: Date.now() - started,
          finishReason,
          usage,
        });
        return { text: res.text, finishReason, usage };
      } catch (err) {
        emit({
          type: 'generation.end',
          id,
          model: primary,
          at: Date.now(),
          durationMs: Date.now() - started,
          finishReason: 'error',
        });
        throw err;
      }
    },
  };
}

function normalizeFinishReason(reason: unknown): FinishReason {
  const known: FinishReason[] = [
    'stop',
    'length',
    'content-filter',
    'tool-calls',
    'error',
    'other',
    'unknown',
  ];
  return known.includes(reason as FinishReason) ? (reason as FinishReason) : 'unknown';
}

function normalizeUsage(usage: unknown): GenerationUsage | undefined {
  if (!usage || typeof usage !== 'object') return undefined;
  const u = usage as Record<string, unknown>;
  const out: GenerationUsage = {};
  if (typeof u.promptTokens === 'number') out.promptTokens = u.promptTokens;
  if (typeof u.completionTokens === 'number') out.completionTokens = u.completionTokens;
  if (typeof u.totalTokens === 'number') out.totalTokens = u.totalTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeModelId(model: string): string {
  return model.startsWith('openrouter/') ? model.slice('openrouter/'.length) : model;
}

export class LLMNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LLMNotConfiguredError';
  }
}
