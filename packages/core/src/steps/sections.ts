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

export async function writeSection(
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

  const first = await attempt();
  let best = first;

  if (!first.ok || isSuspect(first.markdown, first.finishReason)) {
    if (!first.ok) {
      log(
        emit,
        'warn',
        `section "${outline.id}" first attempt failed (${first.error}); retrying once.`,
      );
    } else {
      log(
        emit,
        'warn',
        `section "${outline.id}" returned ${first.markdown.length} chars (finishReason=${first.finishReason}); retrying once.`,
      );
    }
    const retry = await attempt();
    best = pickBest(first, retry);
    if (!best.ok) {
      log(
        emit,
        'warn',
        `section "${outline.id}" both attempts failed (${best.error}); falling back to outline bullets.`,
      );
    } else if (isSuspect(best.markdown, best.finishReason)) {
      log(
        emit,
        'warn',
        `section "${outline.id}" still short after retry (${best.markdown.length} chars); keeping partial output.`,
      );
    }
  }

  const citations = best.ok
    ? dedupe(
        best.citationIndices
          .map((n) => sources[n - 1]?.url)
          .filter((u): u is string => typeof u === 'string'),
      )
    : [];
  const markdown = best.ok && best.markdown.length > 0 ? best.markdown : renderFallback(outline);
  return {
    id: outline.id,
    title: outline.title,
    points: outline.points,
    imageHint: outline.imageHint,
    markdown,
    images: [],
    citations,
  };

  async function attempt(): Promise<SectionAttempt> {
    try {
      const res = await llm.generate({
        schema: SectionWriteSchema,
        prompt,
        system: SECTION_SYSTEM,
        model,
        signal,
        maxTokens: 4096,
      });
      return {
        ok: true,
        markdown: res.object.markdown.trim(),
        citationIndices: res.object.citationIndices,
        finishReason: res.finishReason,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}

type SectionAttempt =
  | { ok: true; markdown: string; citationIndices: number[]; finishReason: string }
  | { ok: false; error: string };

function pickBest(a: SectionAttempt, b: SectionAttempt): SectionAttempt {
  if (!a.ok && !b.ok) return a;
  if (!a.ok) return b;
  if (!b.ok) return a;
  if (a.finishReason === 'length' && b.finishReason !== 'length') return b;
  if (b.finishReason === 'length' && a.finishReason !== 'length') return a;
  return b.markdown.length > a.markdown.length ? b : a;
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

// When both LLM attempts fail we'd rather show the outline bullets than a
// bare H2 followed by an image. Makes the gap legible to the reader.
function renderFallback(outline: SectionOutline): string {
  const bullets = outline.points.map((p) => `- ${p}`).join('\n');
  return `> 本节由兜底逻辑渲染：LLM 两次均未返回有效 markdown，以下为大纲要点。\n\n${bullets}`;
}

function dedupe<T>(arr: T[]): T[] {
  return Array.from(new Set(arr));
}
