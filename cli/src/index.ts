import { readFile } from 'node:fs/promises';
import {
  createLangfuseObserver,
  getRun,
  listRuns,
  openDatabase,
  regenSection,
  runTopic2md,
} from '@topic2md/core';
import type { WorkflowEvent } from '@topic2md/shared';
import { loadPluginConfig } from './config.js';

const HELP = `topic2md — natural-language topic → markdown article

Usage:
  topic2md "<topic>" [--background <text>|--background-file <path>] [--model <id>] [--config <path>] [--verbose]
  topic2md list [--limit <n>] [--status <running|success|failed>]
  topic2md show <run-id> [--markdown]
  topic2md regen <run-id> --section <n> [--background <text>|--background-file <path>] [--model <id>] [--config <path>]

Options:
  --model, -m         Model id (e.g. openrouter/anthropic/claude-sonnet-4-6)
  --config, -c        Path to plugins.config (default: ./plugins.config.ts)
  --background <t>    Freeform context (your role, goal, desired angle) threaded into research/outline/sections prompts
  --background-file   Read background text from a UTF-8 file
  --verbose, -v       Log all workflow events
  --limit <n>         list: max rows to show (default 20)
  --status <s>        list: filter by status
  --markdown          show: print the generated markdown body
  --section <n>       regen: 0-based section index to rewrite
  --help, -h          Show this help

Env:
  OPENROUTER_API_KEY  required unless a mock LLM is injected via config
  TAVILY_API_KEY      required when using @topic2md/source-tavily
  DATABASE_URL        SQLite location (default sqlite:./data.db)
`;

export async function main(argv: string[]): Promise<void> {
  const [first, ...rest] = argv;

  if (first === '-h' || first === '--help' || argv.length === 0) {
    process.stdout.write(HELP);
    return;
  }

  if (first === 'list') return cmdList(rest);
  if (first === 'show') return cmdShow(rest);
  if (first === 'regen') return cmdRegen(rest);

  return cmdRun(argv);
}

async function cmdRegen(argv: string[]): Promise<void> {
  let runId: string | undefined;
  let sectionIndex: number | undefined;
  let model: string | undefined;
  let configPath: string | undefined;
  let background: string | undefined;
  let backgroundFile: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--section') sectionIndex = Number(argv[++i]);
    else if (a === '--model' || a === '-m') model = argv[++i];
    else if (a === '--config' || a === '-c') configPath = argv[++i];
    else if (a === '--background') background = argv[++i];
    else if (a === '--background-file') backgroundFile = argv[++i];
    // nanoid ids can start with '-' or '_', so don't filter on leading dash here.
    else if (a && !runId) runId = a;
  }
  if (!runId || sectionIndex === undefined || Number.isNaN(sectionIndex)) {
    process.stderr.write('Usage: topic2md regen <run-id> --section <n>\n');
    process.exit(2);
  }
  if (background !== undefined && backgroundFile !== undefined) {
    process.stderr.write('error: --background and --background-file are mutually exclusive\n');
    process.exit(2);
  }
  if (backgroundFile) background = await readBackgroundFile(backgroundFile);

  const { config, source } = await loadPluginConfig({ configPath });
  process.stderr.write(`[topic2md] loaded config from ${source}\n`);
  process.stderr.write(`[topic2md] regen run=${runId} section=${sectionIndex}\n`);

  const emit = (event: WorkflowEvent) => {
    if (event.type === 'step.start') process.stderr.write(`→ ${event.step}\n`);
    else if (event.type === 'step.end')
      process.stderr.write(`✓ ${event.step} (${event.durationMs}ms)\n`);
    else if (event.type === 'step.error') process.stderr.write(`✗ ${event.step}: ${event.error}\n`);
    else if (event.type === 'log' && (event.level === 'warn' || event.level === 'error'))
      process.stderr.write(`⚠ ${event.message}\n`);
  };

  const result = await regenSection(
    { runId, sectionIndex },
    { plugins: config, model, emit, background },
  );
  if (result.runId) process.stderr.write(`[topic2md] new run id: ${result.runId}\n`);
  process.stdout.write(`${result.location}\n`);
}

async function readBackgroundFile(path: string): Promise<string> {
  try {
    return (await readFile(path, 'utf8')).trim();
  } catch (err) {
    process.stderr.write(
      `error: cannot read --background-file ${path}: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exit(2);
  }
}

async function cmdRun(argv: string[]): Promise<void> {
  const args = parseRunArgs(argv);
  if (!args.topic) {
    process.stderr.write(HELP);
    process.exit(2);
  }
  if (args.background !== undefined && args.backgroundFile !== undefined) {
    process.stderr.write('error: --background and --background-file are mutually exclusive\n');
    process.exit(2);
  }
  const background = args.backgroundFile
    ? await readBackgroundFile(args.backgroundFile)
    : args.background;

  const { config, source } = await loadPluginConfig({ configPath: args.configPath });
  process.stderr.write(`[topic2md] loaded config from ${source}\n`);
  process.stderr.write(`[topic2md] topic: ${args.topic}\n`);
  if (background) {
    process.stderr.write(`[topic2md] background: ${truncate(background, 80)}\n`);
  }

  const printEvent = (event: WorkflowEvent) => {
    if (args.verbose) {
      process.stderr.write(`[${event.type}] ${summarizeEvent(event)}\n`);
      return;
    }
    if (event.type === 'step.start') process.stderr.write(`→ ${event.step}\n`);
    else if (event.type === 'step.end')
      process.stderr.write(`✓ ${event.step} (${event.durationMs}ms)\n`);
    else if (event.type === 'step.error') process.stderr.write(`✗ ${event.step}: ${event.error}\n`);
    else if (event.type === 'log' && (event.level === 'warn' || event.level === 'error'))
      process.stderr.write(`⚠ ${event.message}\n`);
  };

  const observer = await createLangfuseObserver(args.topic, { passthrough: printEvent });

  try {
    const result = await runTopic2md(
      { topic: args.topic, model: args.model, background },
      { plugins: config, emit: observer.emit },
    );
    if (result.runId) process.stderr.write(`[topic2md] run id: ${result.runId}\n`);
    process.stdout.write(`${result.location}\n`);
  } finally {
    await observer.flush();
  }
}

function cmdList(argv: string[]): void {
  let limit = 20;
  let status: 'running' | 'success' | 'failed' | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limit') limit = Number(argv[++i]) || 20;
    else if (a === '--status') {
      const v = argv[++i];
      if (v === 'running' || v === 'success' || v === 'failed') status = v;
    }
  }
  const db = openDatabase();
  try {
    const rows = listRuns(db, { limit, status });
    if (rows.length === 0) {
      process.stdout.write('no runs yet\n');
      return;
    }
    const pad = (s: string, n: number) => s + ' '.repeat(Math.max(0, n - visualWidth(s)));
    process.stdout.write(
      `${pad('ID', 14)} ${pad('STATUS', 8)} ${pad('DURATION', 10)} ${pad('STARTED', 20)} TOPIC\n`,
    );
    for (const r of rows) {
      const dur = r.durationMs ? `${(r.durationMs / 1000).toFixed(1)}s` : '—';
      const started = new Date(r.startedAt).toISOString().replace('T', ' ').slice(0, 19);
      const topic = truncate(r.topic, 60);
      process.stdout.write(
        `${pad(r.id, 14)} ${pad(r.status, 8)} ${pad(dur, 10)} ${pad(started, 20)} ${topic}\n`,
      );
    }
  } finally {
    db.close();
  }
}

function cmdShow(argv: string[]): void {
  const id = argv.find((a) => !a.startsWith('-'));
  const showMarkdown = argv.includes('--markdown');
  if (!id) {
    process.stderr.write('Usage: topic2md show <run-id> [--markdown]\n');
    process.exit(2);
  }
  const db = openDatabase();
  try {
    const full = getRun(db, id);
    if (!full) {
      process.stderr.write(`no run with id ${id}\n`);
      process.exit(1);
    }
    const { run, stages } = full;
    process.stdout.write(`id:        ${run.id}\n`);
    process.stdout.write(`topic:     ${run.topic}\n`);
    if (run.background) process.stdout.write(`background: ${run.background}\n`);
    process.stdout.write(`model:     ${run.model ?? '—'}\n`);
    process.stdout.write(`status:    ${run.status}\n`);
    process.stdout.write(
      `duration:  ${run.durationMs ? `${(run.durationMs / 1000).toFixed(1)}s` : '—'}\n`,
    );
    process.stdout.write(`started:   ${new Date(run.startedAt).toISOString()}\n`);
    if (run.location) process.stdout.write(`location:  ${run.location}\n`);
    if (run.errorMessage) process.stdout.write(`error:     ${run.errorMessage}\n`);
    if (run.sourceRunId)
      process.stdout.write(
        `source:    regen of ${run.sourceRunId}${run.sourceStage ? `@${run.sourceStage}` : ''}\n`,
      );
    process.stdout.write(`stages:    ${Object.keys(stages).join(', ')}\n`);

    const assemble = stages.assemble as { article?: { markdown?: string } } | undefined;
    if (showMarkdown && assemble?.article?.markdown) {
      process.stdout.write('---\n');
      process.stdout.write(assemble.article.markdown);
    }
  } finally {
    db.close();
  }
}

interface RunArgs {
  topic: string;
  model?: string;
  configPath?: string;
  verbose: boolean;
  background?: string;
  backgroundFile?: string;
}

function parseRunArgs(argv: string[]): RunArgs {
  const args: RunArgs = { topic: '', verbose: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-v':
      case '--verbose':
        args.verbose = true;
        break;
      case '-m':
      case '--model':
        args.model = argv[++i];
        break;
      case '-c':
      case '--config':
        args.configPath = argv[++i];
        break;
      case '--background':
        args.background = argv[++i];
        break;
      case '--background-file':
        args.backgroundFile = argv[++i];
        break;
      default:
        if (a && !a.startsWith('-') && !args.topic) args.topic = a;
    }
  }
  return args;
}

function summarizeEvent(event: WorkflowEvent): string {
  switch (event.type) {
    case 'step.start':
      return `${event.step}`;
    case 'step.end':
      return `${event.step} ${event.durationMs}ms`;
    case 'step.error':
      return `${event.step} — ${event.error}`;
    case 'log':
      return `[${event.level}] ${event.message}`;
    case 'progress':
      return `${event.step} · ${event.message}`;
    case 'generation.start':
      return `${event.kind} → ${event.model}`;
    case 'generation.end':
      return `${event.model} ${event.durationMs}ms ${event.finishReason ?? ''} ${
        event.usage?.totalTokens !== undefined ? `${event.usage.totalTokens}t` : ''
      }`;
    case 'generation.fallback':
      return `fallback ${event.failedModel} → ${event.nextModel}: ${event.error}`;
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : `${s.slice(0, n - 1)}…`;
}

function visualWidth(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! > 0x2e80 ? 2 : 1;
  return w;
}
