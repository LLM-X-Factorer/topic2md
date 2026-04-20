import { createStep } from '@mastra/core';
import { z } from 'zod';
import type { SectionContent, SectionOutline, Source } from '@topic2md/shared';
import { getRuntime } from '../context.js';
import { log, progress, stepEnd, stepError, stepStart, type EmitFn } from '../logger.js';
import { OutlineOutputSchema, SectionsOutputSchema } from './schemas.js';

const SECTION_SYSTEM = `你是一名中文深度写作者。基于该节的大纲与给定研究资料，写出 300~600 字的 markdown 段落。
要求：
- 只写本节内容，不要写章节标题（标题由上游拼装）。
- 用简体中文，语言紧凑、有信息量，避免水字。
- 引用事实时，在句末用 [n] 给出资料编号（n 对应提供给你的 sources 列表序号）。
- 不要生成图片（图片由后续步骤配置）。`;

const SectionWriteSchema = z.object({
  markdown: z.string(),
  citationIndices: z.array(z.number().int().nonnegative()).default([]),
});

export const sectionsStep = createStep({
  id: 'sections',
  description: 'Generate markdown body for each outlined section in parallel.',
  inputSchema: OutlineOutputSchema,
  outputSchema: SectionsOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { llm, emit, model } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'sections');
    try {
      progress(emit, 'sections', `generating ${inputData.outline.sections.length} section bodies`);
      const sections = await Promise.all(
        inputData.outline.sections.map((section) =>
          writeSection(section, inputData.sources, llm, model, emit, abortSignal),
        ),
      );
      log(emit, 'info', `sections produced ${sections.length} bodies`);
      stepEnd(emit, 'sections', started);
      return {
        topic: inputData.topic,
        sources: inputData.sources,
        title: inputData.outline.title,
        digest: inputData.outline.digest,
        sections,
      };
    } catch (err) {
      stepError(emit, 'sections', err);
      throw err;
    }
  },
});

const MIN_SECTION_CHARS = 120;

async function writeSection(
  outline: SectionOutline,
  sources: Source[],
  llm: ReturnType<typeof getRuntime>['llm'],
  model: string,
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<SectionContent> {
  const sourceList = sources
    .slice(0, 10)
    .map((s, i) => `[${i + 1}] ${s.title} — ${s.url}\n    ${s.snippet}`)
    .join('\n');
  const points = outline.points.map((p, i) => `${i + 1}. ${p}`).join('\n');
  const prompt = `章节标题：${outline.title}\n\n要点：\n${points}\n\n可用资料：\n${sourceList}`;

  let res = await callLLM();
  let markdown = res.object.markdown.trim();

  if (isSuspect(markdown, res.finishReason)) {
    log(
      emit,
      'warn',
      `section "${outline.id}" returned ${markdown.length} chars (finishReason=${res.finishReason}); retrying once.`,
    );
    try {
      const retry = await callLLM();
      const retryMd = retry.object.markdown.trim();
      if (retryMd.length > markdown.length) {
        res = retry;
        markdown = retryMd;
      }
    } catch (err) {
      log(
        emit,
        'warn',
        `section "${outline.id}" retry failed (${err instanceof Error ? err.message : String(err)}); keeping first attempt.`,
      );
    }
    if (isSuspect(markdown, res.finishReason)) {
      log(
        emit,
        'warn',
        `section "${outline.id}" still short after retry (${markdown.length} chars); keeping partial output.`,
      );
    }
  }

  const citations = dedupe(
    res.object.citationIndices
      .map((n) => sources[n - 1]?.url)
      .filter((u): u is string => typeof u === 'string'),
  );
  return {
    id: outline.id,
    title: outline.title,
    points: outline.points,
    imageHint: outline.imageHint,
    markdown,
    images: [],
    citations,
  };

  function callLLM() {
    return llm.generate({
      schema: SectionWriteSchema,
      prompt,
      system: SECTION_SYSTEM,
      model,
      signal,
      maxTokens: 4096,
    });
  }
}

// Only two signals mean the body is probably broken:
// - the provider hit maxTokens (finishReason === 'length'), or
// - the markdown is implausibly short for a 300+ 字 target.
// finishReason === 'tool-calls' is the normal completion signal for
// Vercel AI SDK generateObject (which uses a tool call to return JSON).
function isSuspect(markdown: string, finishReason: string): boolean {
  if (finishReason === 'length') return true;
  if (markdown.length < MIN_SECTION_CHARS) return true;
  return false;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
