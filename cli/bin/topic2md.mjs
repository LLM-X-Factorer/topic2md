#!/usr/bin/env node
import('../dist/index.js').then((m) => m.main(process.argv.slice(2))).catch((err) => {
  // eslint-disable-next-line no-console
  console.error(err instanceof Error ? err.stack ?? err.message : err);
  process.exit(1);
});
