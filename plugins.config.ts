import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PluginConfig } from '@topic2md/shared';
import { tavilySource } from '@topic2md/source-tavily';
import { screenshotImage } from '@topic2md/image-screenshot';
import { filePublish } from '@topic2md/publish-file';

// Anchor outputs to this config file so CLI (cwd = repo root) and
// `next dev` (cwd = apps/web) both produce into the same repo-root out/.
const ROOT = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(ROOT, 'out');

const config: PluginConfig = {
  sources: [
    tavilySource({
      apiKey: process.env.TAVILY_API_KEY ?? '',
      searchDepth: 'advanced',
      maxResults: 8,
    }),
  ],
  images: [
    screenshotImage({
      outDir: resolve(OUT, 'images'),
      concurrency: 3,
      preferOgImage: true,
    }),
  ],
  themes: [],
  publish: [filePublish({ outDir: OUT })],
};

export default config;
