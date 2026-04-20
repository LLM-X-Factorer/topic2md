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

let cached: PluginConfig | null = null;

export async function getPluginConfig(): Promise<PluginConfig> {
  if (cached) return cached;
  const root = resolve(process.cwd(), '..', '..');
  const source = findConfig(root);
  if (!source) {
    throw new Error(`No plugins.config found at repo root ${root}. Create plugins.config.ts.`);
  }
  const mod =
    source.endsWith('.ts') || source.endsWith('.mts')
      ? await loadTs(source)
      : await import(pathToFileURL(source).href);
  const config =
    mod && typeof mod === 'object' && 'default' in mod
      ? (mod as { default: PluginConfig }).default
      : (mod as PluginConfig);
  cached = config;
  return config;
}

function findConfig(cwd: string): string | null {
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
