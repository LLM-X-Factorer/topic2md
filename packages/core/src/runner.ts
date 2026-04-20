import { RuntimeContext } from '@mastra/core/runtime-context';
import {
  WORKFLOW_STEPS,
  type PluginConfig,
  type WorkflowInput,
  type WorkflowResult,
  type WorkflowStep,
} from '@topic2md/shared';
import { buildRuntime, RUNTIME_KEY } from './context.js';
import { createLLM, type LLM } from './llm.js';
import type { EmitFn } from './logger.js';
import { log, noopEmit } from './logger.js';
import {
  completeRun,
  createRun,
  openDatabase,
  saveStage,
  type DatabaseType,
} from './persistence.js';
import { assertPluginConfig } from './registry.js';
import { createTopic2mdWorkflow, type Topic2mdWorkflow } from './workflow.js';

export interface RunTopic2mdOptions {
  plugins: PluginConfig;
  llm?: LLM;
  emit?: EmitFn;
  signal?: AbortSignal;
  model?: string;
  /**
   * Persist this run to SQLite. `true` uses `DATABASE_URL` / the default
   * `sqlite:./data.db`. Pass an open `DatabaseType` to reuse an existing
   * handle (e.g. from a long-lived web server). Pass `false` to skip.
   */
  record?: boolean | DatabaseType;
  databaseUrl?: string;
}

export interface RunTopic2mdResult extends WorkflowResult {
  runId: string | null;
}

export async function runTopic2md(
  input: WorkflowInput,
  options: RunTopic2mdOptions,
): Promise<RunTopic2mdResult> {
  assertPluginConfig(options.plugins);
  const llm = options.llm ?? createLLM({ defaultModel: options.model });
  const model = options.model ?? input.model ?? llm.defaultModel;
  const emit = options.emit ?? noopEmit;

  const { db, ownedDb, runId } = initRecorder(options, input, model, emit);

  const workflow: Topic2mdWorkflow = createTopic2mdWorkflow();
  const run = await workflow.createRunAsync();

  const runtimeContext = new RuntimeContext();
  runtimeContext.set(RUNTIME_KEY, buildRuntime({ plugins: options.plugins, llm, emit, model }));

  try {
    const result = await run.start({
      inputData: { topic: input.topic, model },
      runtimeContext,
    });

    if (db && runId) persistResult(db, runId, result);

    if (result.status !== 'success') {
      const reason =
        result.status === 'failed'
          ? result.error instanceof Error
            ? result.error.message
            : String(result.error)
          : `workflow suspended at ${result.suspended.map((p) => p.join('.')).join(', ')}`;
      throw new Topic2mdRunError(`topic2md workflow did not complete: ${reason}`, result, runId);
    }

    return { ...result.result, runId };
  } catch (err) {
    if (db && runId) {
      try {
        completeRun(db, runId, {
          status: 'failed',
          errorMessage: err instanceof Error ? err.message : String(err),
        });
      } catch {
        /* swallow — persistence is best-effort */
      }
    }
    throw err;
  } finally {
    if (ownedDb && db) db.close();
  }
}

interface Recorder {
  db: DatabaseType | null;
  ownedDb: boolean;
  runId: string | null;
}

function initRecorder(
  options: RunTopic2mdOptions,
  input: WorkflowInput,
  model: string,
  emit: EmitFn,
): Recorder {
  const record = options.record ?? true;
  if (record === false) return { db: null, ownedDb: false, runId: null };

  let db: DatabaseType;
  let ownedDb = false;
  if (typeof record === 'object' && record !== null) {
    db = record;
  } else {
    try {
      db = openDatabase(options.databaseUrl);
      ownedDb = true;
    } catch (err) {
      log(
        emit,
        'warn',
        `persistence disabled — failed to open SQLite at ${options.databaseUrl ?? process.env.DATABASE_URL ?? 'sqlite:./data.db'}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return { db: null, ownedDb: false, runId: null };
    }
  }

  try {
    const runId = createRun(db, { topic: input.topic, model });
    return { db, ownedDb, runId };
  } catch (err) {
    log(
      emit,
      'warn',
      `persistence disabled — createRun failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    if (ownedDb) db.close();
    return { db: null, ownedDb: false, runId: null };
  }
}

function persistResult(
  db: DatabaseType,
  runId: string,
  result: Awaited<ReturnType<Awaited<ReturnType<Topic2mdWorkflow['createRunAsync']>>['start']>>,
): void {
  if (result.status === 'success') {
    for (const stage of WORKFLOW_STEPS) {
      const step = result.steps[stage as keyof typeof result.steps] as
        | { status: 'success'; output: unknown }
        | undefined;
      if (step?.status === 'success') {
        try {
          saveStage(db, runId, stage as WorkflowStep, step.output);
        } catch {
          /* best-effort */
        }
      }
    }
    completeRun(db, runId, {
      status: 'success',
      location:
        result.result && typeof result.result === 'object' && 'location' in result.result
          ? (result.result as { location: string }).location
          : undefined,
    });
  } else if (result.status === 'failed') {
    completeRun(db, runId, {
      status: 'failed',
      errorMessage: result.error instanceof Error ? result.error.message : String(result.error),
    });
  }
}

export class Topic2mdRunError extends Error {
  readonly runResult: unknown;
  readonly runId: string | null;
  constructor(message: string, runResult: unknown, runId: string | null = null) {
    super(message);
    this.name = 'Topic2mdRunError';
    this.runResult = runResult;
    this.runId = runId;
  }
}
