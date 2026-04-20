import type { PluginConfig } from '@topic2md/shared';
import { tavilySource } from '@topic2md/source-tavily';
import { screenshotImage } from '@topic2md/image-screenshot';
import { filePublish } from '@topic2md/publish-file';

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
      outDir: './out/images',
      concurrency: 3,
      preferOgImage: true,
    }),
  ],
  themes: [],
  publish: [filePublish({ outDir: './out' })],
};

export default config;
