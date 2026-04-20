import { createStep } from '@mastra/core';
import { OutlineSchema, type Source } from '@topic2md/shared';
import { nanoid } from 'nanoid';
import { getRuntime } from '../context.js';
import { log, progress, stepEnd, stepError, stepStart } from '../logger.js';
import { OutlineOutputSchema, ResearchOutputSchema } from './schemas.js';

const OUTLINE_SYSTEM = `你是一名中文科技与商业写作编辑。基于给定的话题与研究资料，输出结构化的文章大纲。
要求：
- title：紧扣话题，10~30 字，不要夸张标题党。
- digest：60~120 字，概述全文要点。
- sections：3~6 节；每节 id 用短横线命名；points 用 2~5 条 bullet 说明本节论点或证据。
- 如该节需要配图，在 imageHint.purpose 给出图片用途（"原始链接截图"/"相关示意图"），imageHint.keywords 提供 1~3 个英文或中文关键词。
- 不要在本步生成正文。`;

export const outlineStep = createStep({
  id: 'outline',
  description:
    'Produce an article outline (title/digest/sections) grounded in the research sources.',
  inputSchema: ResearchOutputSchema,
  outputSchema: OutlineOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { llm, emit, model } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'outline');
    try {
      progress(emit, 'outline', `drafting outline with ${inputData.sources.length} sources`);
      const prompt = renderPrompt(inputData.topic, inputData.sources);
      const raw = await llm.generate({
        schema: OutlineSchema,
        prompt,
        system: OUTLINE_SYSTEM,
        model,
        signal: abortSignal,
      });
      const outline = {
        ...raw,
        sections: raw.sections.map((s) => ({ ...s, id: s.id || nanoid(8) })),
      };
      log(emit, 'info', `outline "${outline.title}" with ${outline.sections.length} sections`);
      stepEnd(emit, 'outline', started);
      return { topic: inputData.topic, sources: inputData.sources, outline };
    } catch (err) {
      stepError(emit, 'outline', err);
      throw err;
    }
  },
});

function renderPrompt(topic: string, sources: Source[]): string {
  const sourceList = sources
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${s.title}\n   ${s.url}\n   ${s.snippet}`)
    .join('\n');
  return `话题：${topic}\n\n研究资料：\n${sourceList}`;
}
