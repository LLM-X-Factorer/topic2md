import { createStep } from '@mastra/core';
import { OutlineSchema, type SectionOutline, type Source } from '@topic2md/shared';
import { nanoid } from 'nanoid';
import { getRuntime } from '../context.js';
import { log, progress, stepEnd, stepError, stepStart } from '../logger.js';
import { OutlineOutputSchema, ResearchOutputSchema } from './schemas.js';

const OUTLINE_SYSTEM = `你是一名中文科技与商业写作编辑。基于给定的话题与研究资料，输出结构化的文章大纲。
要求：
- title：紧扣话题，10~30 字，不要夸张标题党。
- digest：60~120 字，概述全文要点。
- sections：3~6 节；每节 id 用短横线命名；points 用 2~5 条 bullet 说明本节论点或证据。
- **每节都必须给 imageHint**：purpose 描述图片用途（如 "原始链接截图" / "相关示意图" / "概念插画"），keywords 提供 2~3 个中英文关键词用于配图查询。即便是抽象或理论性话题，也请给一张概念性示意图的 hint，不要省略。
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
      const result = await llm.generate({
        schema: OutlineSchema,
        prompt,
        system: OUTLINE_SYSTEM,
        model,
        signal: abortSignal,
        maxTokens: 4096,
      });
      if (result.finishReason === 'length') {
        log(
          emit,
          'warn',
          'outline hit the token budget (finishReason=length); the JSON may be incomplete. Consider a higher maxTokens or a shorter prompt.',
        );
      }
      const outline = {
        ...result.object,
        sections: result.object.sections.map((s) =>
          backfillImageHint({ ...s, id: s.id || nanoid(8) }),
        ),
      };
      const backfilled = outline.sections.filter(
        (s) => s.imageHint?.purpose === '概念示意图',
      ).length;
      if (backfilled > 0) {
        log(
          emit,
          'info',
          `outline: synthesized imageHint for ${backfilled} section(s) that the model omitted`,
        );
      }
      log(emit, 'info', `outline "${outline.title}" with ${outline.sections.length} sections`);
      stepEnd(emit, 'outline', started);
      return { topic: inputData.topic, sources: inputData.sources, outline };
    } catch (err) {
      stepError(emit, 'outline', err);
      throw err;
    }
  },
});

// Keep article imagery non-empty even when the LLM forgets to include
// imageHint. Pull 2-3 keywords from the section title / points; an image
// plugin (og:image / screenshot / library) can still find something.
function backfillImageHint(section: SectionOutline): SectionOutline {
  if (section.imageHint && section.imageHint.purpose && section.imageHint.keywords?.length) {
    return section;
  }
  const tokens = new Set<string>();
  for (const src of [section.title, ...(section.points ?? [])]) {
    for (const t of src.split(/[\s,.;:!?()[\]（）【】、，。；：！？/\\"'`~]+/)) {
      const trimmed = t.trim();
      if (trimmed.length >= 2) tokens.add(trimmed);
    }
  }
  return {
    ...section,
    imageHint: {
      purpose: '概念示意图',
      keywords: [...tokens].slice(0, 3),
    },
  };
}

function renderPrompt(topic: string, sources: Source[]): string {
  const sourceList = sources
    .slice(0, 12)
    .map((s, i) => `${i + 1}. ${s.title}\n   ${s.url}\n   ${s.snippet}`)
    .join('\n');
  return `话题：${topic}\n\n研究资料：\n${sourceList}`;
}
