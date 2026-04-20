/** @type {import('next').NextConfig} */
const nextConfig = {
  experimental: {
    serverComponentsExternalPackages: [
      '@mastra/core',
      'playwright',
      'playwright-core',
      '@topic2md/core',
      '@topic2md/source-tavily',
      '@topic2md/image-screenshot',
      '@topic2md/publish-file',
    ],
  },
  transpilePackages: ['@topic2md/shared'],
  output: 'standalone',
};

export default nextConfig;
