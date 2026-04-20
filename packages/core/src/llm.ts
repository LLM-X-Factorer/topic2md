import { generateObject, generateText } from 'ai';
import { createOpenAI } from '@ai-sdk/openai';
import type { z } from 'zod';

export interface GenerateObjectOptions<T extends z.ZodType> {
  schema: T;
  prompt: string;
  system?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface GenerateTextOptions {
  prompt: string;
  system?: string;
  model?: string;
  signal?: AbortSignal;
}

export interface LLM {
  readonly defaultModel: string;
  generate<T extends z.ZodType>(opts: GenerateObjectOptions<T>): Promise<z.infer<T>>;
  generateText(opts: GenerateTextOptions): Promise<string>;
}

export interface LLMOptions {
  defaultModel?: string;
  apiKey?: string;
  baseURL?: string;
}

const DEFAULT_MODEL = 'openrouter/anthropic/claude-sonnet-4-6';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1';

export function createLLM(opts: LLMOptions = {}): LLM {
  const defaultModel = opts.defaultModel ?? process.env.DEFAULT_MODEL ?? DEFAULT_MODEL;
  const apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY;

  if (!apiKey) {
    throw new LLMNotConfiguredError(
      'OPENROUTER_API_KEY is not set. Either set the env var or inject a custom LLM via runTopic2md({ llm }).',
    );
  }

  const openrouter = createOpenAI({
    baseURL: opts.baseURL ?? OPENROUTER_BASE,
    apiKey,
  });

  return {
    defaultModel,
    async generate({ schema, prompt, system, model, signal }) {
      const modelId = normalizeModelId(model ?? defaultModel);
      const res = await generateObject({
        model: openrouter(modelId),
        schema,
        system,
        prompt,
        abortSignal: signal,
      });
      return res.object;
    },
    async generateText({ prompt, system, model, signal }) {
      const modelId = normalizeModelId(model ?? defaultModel);
      const res = await generateText({
        model: openrouter(modelId),
        system,
        prompt,
        abortSignal: signal,
      });
      return res.text;
    },
  };
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
