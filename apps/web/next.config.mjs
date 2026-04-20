/** @type {import('next').NextConfig} */
const nextConfig = {
  serverExternalPackages: [
    '@mastra/core',
    'ai',
    '@ai-sdk/openai',
    'playwright',
    'playwright-core',
    'node-html-parser',
    'langfuse',
    'jiti',
    '@topic2md/core',
    '@topic2md/source-tavily',
    '@topic2md/image-screenshot',
    '@topic2md/publish-file',
  ],
  transpilePackages: ['@topic2md/shared'],
  output: 'standalone',
};

export default nextConfig;
