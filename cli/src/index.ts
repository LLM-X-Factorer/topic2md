import { runTopic2md } from '@topic2md/core';
import type { WorkflowEvent } from '@topic2md/shared';
import { loadPluginConfig } from './config.js';

interface CliArgs {
  topic: string;
  model?: string;
  configPath?: string;
  verbose: boolean;
  help: boolean;
}

const HELP = `topic2md — natural-language topic → markdown article

Usage:
  topic2md "<topic>" [--model <id>] [--config <path>] [--verbose]

Options:
  --model, -m     Model id (e.g. openrouter/anthropic/claude-sonnet-4-6)
  --config, -c    Path to plugins.config (default: ./plugins.config.ts)
  --verbose, -v   Log all workflow events
  --help, -h      Show this help

Env:
  OPENROUTER_API_KEY  required unless a mock LLM is injected via config
  TAVILY_API_KEY      required when using @topic2md/source-tavily
`;

export async function main(argv: string[]): Promise<void> {
  const args = parseArgs(argv);
  if (args.help) {
    process.stdout.write(HELP);
    return;
  }
  if (!args.topic) {
    process.stderr.write(HELP);
    process.exit(2);
  }

  const { config, source } = await loadPluginConfig({ configPath: args.configPath });
  process.stderr.write(`[topic2md] loaded config from ${source}\n`);
  process.stderr.write(`[topic2md] topic: ${args.topic}\n`);

  const emit = (event: WorkflowEvent) => {
    if (args.verbose) {
      process.stderr.write(`[${event.type}] ${summarizeEvent(event)}\n`);
      return;
    }
    if (event.type === 'step.start') process.stderr.write(`→ ${event.step}\n`);
    else if (event.type === 'step.end')
      process.stderr.write(`✓ ${event.step} (${event.durationMs}ms)\n`);
    else if (event.type === 'step.error') process.stderr.write(`✗ ${event.step}: ${event.error}\n`);
  };

  const result = await runTopic2md(
    { topic: args.topic, model: args.model },
    { plugins: config, emit },
  );

  process.stdout.write(`${result.location}\n`);
}

function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { topic: '', verbose: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    switch (a) {
      case '-h':
      case '--help':
        args.help = true;
        break;
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
  }
}
