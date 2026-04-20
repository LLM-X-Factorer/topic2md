import type { PluginConfig } from './plugin.js';

export const WORKFLOW_STEPS = [
  'research',
  'outline',
  'sections',
  'images',
  'assemble',
  'publish',
] as const;

export type WorkflowStep = (typeof WORKFLOW_STEPS)[number];

export interface WorkflowInput {
  topic: string;
  model?: string;
  /**
   * Freeform context about the user, their goal, and the angle they want the
   * article to take. Threaded through research / outline / sections prompts
   * so the pipeline doesn't drift from the user's actual intent.
   */
  background?: string;
}

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface GenerationUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
}

export type WorkflowEvent =
  | { type: 'step.start'; step: WorkflowStep; at: number }
  | { type: 'step.end'; step: WorkflowStep; at: number; durationMs: number }
  | { type: 'step.error'; step: WorkflowStep; at: number; error: string }
  | { type: 'log'; level: LogLevel; message: string; at: number }
  | { type: 'progress'; step: WorkflowStep; message: string; at: number }
  | {
      type: 'generation.start';
      id: string;
      model: string;
      kind: 'object' | 'text';
      at: number;
    }
  | {
      type: 'generation.end';
      id: string;
      model: string;
      at: number;
      durationMs: number;
      finishReason?: string;
      usage?: GenerationUsage;
    }
  | {
      type: 'generation.fallback';
      id: string;
      failedModel: string;
      nextModel: string;
      error: string;
      at: number;
    };

export interface WorkflowContext {
  topic: string;
  model: string;
  plugins: PluginConfig;
  emit?: (event: WorkflowEvent) => void;
  signal?: AbortSignal;
}

export interface WorkflowResult {
  location: string;
  markdown: string;
}
