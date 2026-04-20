import type { Source, SourcePlugin } from '@topic2md/shared';

export function createMockSource(overrides: Partial<Source>[] = []): SourcePlugin {
  return {
    name: 'mock-source',
    async research(topic: string) {
      const defaults: Source[] = [
        {
          url: 'https://example.com/a',
          title: `关于 ${topic} 的权威介绍`,
          snippet: `这是一段关于 ${topic} 的占位摘要，用于端到端测试。`,
          publishedAt: '2026-04-20',
          score: 0.9,
        },
        {
          url: 'https://example.com/b',
          title: `${topic} 的技术细节`,
          snippet: `第二条占位资料，覆盖 ${topic} 的若干技术点。`,
          score: 0.8,
        },
        {
          url: 'https://example.com/c',
          title: `${topic} 背景解读`,
          snippet: `第三条占位资料，提供背景信息。`,
        },
      ];
      return overrides.length > 0
        ? overrides.map((o, i) => ({ ...(defaults[i % defaults.length] as Source), ...o }))
        : defaults;
    },
  };
}
