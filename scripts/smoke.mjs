#!/usr/bin/env node
import { runSmoke } from '@topic2md/core/testing';

const topic = process.argv[2] ?? 'topic2md smoke test';
const started = Date.now();
const result = await runSmoke(topic);
const elapsed = Date.now() - started;

if (result.length < 200) {
  console.error(`[smoke] suspiciously short output (${result.length} chars)`);
  process.exit(1);
}
console.error(
  `[smoke] ok — ${result.length} chars, location=${result.location}, ${elapsed}ms`,
);
