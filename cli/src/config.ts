import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createJiti } from 'jiti';
import type { PluginConfig } from '@topic2md/shared';

const CANDIDATES = [
  'plugins.config.ts',
  'plugins.config.mts',
  'plugins.config.js',
  'plugins.config.mjs',
];

export interface LoadConfigOptions {
  cwd?: string;
  configPath?: string;
}

export async function loadPluginConfig(options: LoadConfigOptions = {}): Promise<{
  config: PluginConfig;
  source: string;
}> {
  const cwd = options.cwd ?? process.cwd();
  const source = resolveConfigPath(cwd, options.configPath);
  if (!source) {
    throw new Error(
      `No plugins.config found in ${cwd}. Create plugins.config.ts exporting a PluginConfig default.`,
    );
  }

  const mod =
    source.endsWith('.ts') || source.endsWith('.mts') ? await loadTs(source) : await loadJs(source);
  const config = extractDefault(mod);
  return { config, source };
}

function resolveConfigPath(cwd: string, explicit?: string): string | null {
  if (explicit) {
    const full = resolve(cwd, explicit);
    if (!existsSync(full)) {
      throw new Error(`plugins.config not found at ${full}`);
    }
    return full;
  }
  for (const name of CANDIDATES) {
    const full = resolve(cwd, name);
    if (existsSync(full)) return full;
  }
  return null;
}

async function loadTs(source: string): Promise<unknown> {
  const jiti = createJiti(source, { interopDefault: true });
  return jiti.import(source);
}

async function loadJs(source: string): Promise<unknown> {
  const url = pathToFileURL(source).href;
  return import(url);
}

function extractDefault(mod: unknown): PluginConfig {
  if (mod && typeof mod === 'object' && 'default' in mod) {
    return (mod as { default: PluginConfig }).default;
  }
  return mod as PluginConfig;
}
