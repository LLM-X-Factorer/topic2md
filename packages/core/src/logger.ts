import type { WorkflowEvent, WorkflowStep, LogLevel } from '@topic2md/shared';

export type EmitFn = (event: WorkflowEvent) => void;

export const noopEmit: EmitFn = () => {};

export function stepStart(emit: EmitFn, step: WorkflowStep): number {
  const at = Date.now();
  emit({ type: 'step.start', step, at });
  return at;
}

export function stepEnd(emit: EmitFn, step: WorkflowStep, startedAt: number): void {
  const at = Date.now();
  emit({ type: 'step.end', step, at, durationMs: at - startedAt });
}

export function stepError(emit: EmitFn, step: WorkflowStep, error: unknown): void {
  emit({
    type: 'step.error',
    step,
    at: Date.now(),
    error: error instanceof Error ? error.message : String(error),
  });
}

export function progress(emit: EmitFn, step: WorkflowStep, message: string): void {
  emit({ type: 'progress', step, message, at: Date.now() });
}

export function log(emit: EmitFn, level: LogLevel, message: string): void {
  emit({ type: 'log', level, message, at: Date.now() });
}
