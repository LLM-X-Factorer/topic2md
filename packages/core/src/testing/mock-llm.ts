import type { LLM } from '../llm.js';

const MOCK_OUTLINE = (topic: string) => ({
  title: `${topic} 速览`,
  digest: `本文简要介绍 ${topic} 的要点、背景与展望，作为 topic2md 的端到端跑通用例。`,
  sections: [
    {
      id: 'background',
      title: '背景',
      points: ['缘起', '为什么此刻值得关注'],
      imageHint: { purpose: '原始链接截图', keywords: [topic] },
    },
    {
      id: 'highlights',
      title: '核心亮点',
      points: ['关键能力 1', '关键能力 2'],
      imageHint: { purpose: '相关示意图' },
    },
    {
      id: 'outlook',
      title: '展望',
      points: ['开发者可利用的方向', '下一步值得关注的细节'],
    },
  ],
});

const MOCK_SECTION = (topic: string) => ({
  markdown: `这是关于 ${topic} 的一段占位正文，由 mock LLM 产出。实际输出需配置 OPENROUTER_API_KEY 再运行。[1]`,
  citationIndices: [1],
});

export function createMockLLM(): LLM {
  return {
    defaultModel: 'mock/topic2md',
    async generate({ schema, prompt }) {
      const topic = extractTopic(prompt) ?? 'mock topic';
      const outlineAttempt = schema.safeParse(MOCK_OUTLINE(topic));
      if (outlineAttempt.success) return { object: outlineAttempt.data, finishReason: 'stop' };
      const sectionAttempt = schema.safeParse(MOCK_SECTION(topic));
      if (sectionAttempt.success) return { object: sectionAttempt.data, finishReason: 'stop' };
      throw new Error(
        'createMockLLM: schema not supported; extend MOCK_OUTLINE / MOCK_SECTION or provide a custom LLM.',
      );
    },
    async generateText({ prompt }) {
      return { text: `[mock response] ${prompt.slice(0, 80)}`, finishReason: 'stop' };
    },
  };
}

function extractTopic(prompt: string): string | null {
  const line = prompt
    .split('\n')
    .map((l) => l.trim())
    .find((l) => l.startsWith('话题：') || l.startsWith('章节标题：'));
  if (!line) return null;
  const colon = line.indexOf('：');
  return colon >= 0 ? line.slice(colon + 1).trim() : null;
}
