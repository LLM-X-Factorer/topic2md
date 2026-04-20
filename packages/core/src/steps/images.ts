import { createStep } from '@mastra/core';
import { z } from 'zod';
import type {
  ImageCandidate,
  ImagePlugin,
  ImageRef,
  SectionContent,
  Source,
} from '@topic2md/shared';
import { getRuntime } from '../context.js';
import { imagePlugins } from '../registry.js';
import { log, progress, stepEnd, stepError, stepStart, type EmitFn } from '../logger.js';
import type { LLM } from '../llm.js';
import { ImagesOutputSchema, SectionsOutputSchema } from './schemas.js';

// Qwen3-VL-32B is cheap ($0.1/M in) and — critically — not blocked by the
// OpenRouter "data policy / provider ToS" rejection that hits Google and
// OpenAI vision models on this account. Override via IMAGE_RERANK_MODEL.
const DEFAULT_RERANK_MODEL = 'openrouter/qwen/qwen3-vl-32b-instruct';
const MAX_CANDIDATES_PER_SECTION = 6;

export const imagesStep = createStep({
  id: 'images',
  description:
    'Collect image candidates from every plugin and pick one per section with a vision LLM rerank.',
  inputSchema: SectionsOutputSchema,
  outputSchema: ImagesOutputSchema,
  execute: async ({ inputData, runtimeContext, abortSignal }) => {
    const { plugins, emit, llm } = getRuntime(runtimeContext);
    const started = stepStart(emit, 'images');
    try {
      const plugs = imagePlugins(plugins);
      if (plugs.length === 0) {
        log(emit, 'info', 'no image plugins configured — skipping');
        stepEnd(emit, 'images', started);
        return inputData;
      }
      progress(emit, 'images', `resolving images for ${inputData.sections.length} sections`);

      const assignments = assignSources(inputData.sections, inputData.sources);
      const rerankModel = resolveRerankModel();

      const sections = await Promise.all(
        inputData.sections.map((section, i) =>
          resolveSectionImage(
            section,
            reorderWithAssigned(inputData.sources, assignments[i] ?? null),
            inputData.topic,
            plugs,
            llm,
            rerankModel,
            emit,
            abortSignal,
          ),
        ),
      );

      const total = sections.reduce((n, s) => n + s.images.length, 0);
      log(emit, 'info', `images attached: ${total}`);
      stepEnd(emit, 'images', started);
      return { ...inputData, sections };
    } catch (err) {
      stepError(emit, 'images', err);
      throw err;
    }
  },
});

export async function resolveSectionImage(
  section: SectionContent,
  sources: Source[],
  topic: string,
  plugs: ImagePlugin[],
  llm: LLM,
  rerankModel: string | null,
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<SectionContent> {
  if (!section.imageHint) return section;

  const candidates = await collectCandidates(section, sources, topic, plugs, emit, signal);
  const filtered = filterAndDedupe(candidates);
  if (filtered.length === 0) return section;

  const bounded = filtered.slice(0, MAX_CANDIDATES_PER_SECTION);

  let winner: ImageCandidate | null = null;
  if (rerankModel) {
    winner = await visionRerank(bounded, section, topic, llm, rerankModel, emit, signal).catch(
      (err) => {
        log(
          emit,
          'warn',
          `vision rerank failed for "${section.id}": ${err instanceof Error ? err.message : String(err)} — falling back to keyword scoring`,
        );
        return null;
      },
    );
  }
  if (!winner) {
    winner = keywordRerank(bounded, section);
  }
  if (!winner) return section;

  const ref: ImageRef = {
    url: winner.url,
    alt: winner.alt || section.title,
    kind: winner.kind,
    ...(winner.sourceUrl ? { sourceUrl: winner.sourceUrl } : {}),
    ...(winner.caption ?? section.imageHint?.purpose
      ? { caption: winner.caption ?? section.imageHint?.purpose }
      : {}),
    ...(winner.width ? { width: winner.width } : {}),
    ...(winner.height ? { height: winner.height } : {}),
  };
  return { ...section, images: [...section.images, ref] };
}

async function collectCandidates(
  section: SectionContent,
  sources: Source[],
  topic: string,
  plugs: ImagePlugin[],
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<ImageCandidate[]> {
  const request = { section, sources, topic };
  const results = await Promise.all(
    plugs.map(async (plug) => {
      if (typeof plug.discover !== 'function') return [];
      try {
        const cs = await plug.discover(request, { signal });
        return cs.map((c) => ({ ...c, pluginName: plug.name }));
      } catch (err) {
        log(
          emit,
          'warn',
          `image plugin "${plug.name}" discover failed for "${section.id}": ${err instanceof Error ? err.message : String(err)}`,
        );
        return [];
      }
    }),
  );
  return results.flat();
}

function filterAndDedupe(candidates: ImageCandidate[]): ImageCandidate[] {
  const seen = new Set<string>();
  return candidates.filter((c) => {
    if (isPlaceholderUrl(c.url)) return false;
    if (seen.has(c.url)) return false;
    seen.add(c.url);
    return true;
  });
}

async function visionRerank(
  candidates: ImageCandidate[],
  section: SectionContent,
  topic: string,
  llm: LLM,
  model: string,
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<ImageCandidate | null> {
  if (candidates.length === 0) return null;

  const description = candidates
    .map((c, i) => {
      const bits: string[] = [];
      if (c.alt) bits.push(`alt=${JSON.stringify(truncate(c.alt, 120))}`);
      if (c.caption) bits.push(`caption=${JSON.stringify(truncate(c.caption, 120))}`);
      if (c.surroundingText)
        bits.push(`context=${JSON.stringify(truncate(c.surroundingText, 180))}`);
      if (c.sourceUrl) bits.push(`page=${c.sourceUrl}`);
      if (c.pluginName) bits.push(`source=${c.pluginName}`);
      return `${i}. ${bits.join(' ')}`;
    })
    .join('\n');

  const points = section.points
    .slice(0, 6)
    .map((p) => `- ${p}`)
    .join('\n');
  const keywords = section.imageHint?.keywords?.join(', ') ?? '';
  const purpose = section.imageHint?.purpose ?? '';

  const prompt = [
    '你是专业的科技/商业编辑，正在为一篇长文选择配图。',
    '请仔细查看所有附图，从候选中选出最能匹配本段内容的一张。',
    '',
    `文章主题：${topic}`,
    `本段标题：${section.title}`,
    '本段要点：',
    points,
    purpose ? `配图目的：${purpose}` : '',
    keywords ? `关键词：${keywords}` : '',
    '',
    '候选元数据：',
    description,
    '',
    '评分标准（按优先级从高到低）：',
    '1. 图片内容直接对应本段主题（架构图/图表/产品截图/真实应用场景/相关示意图）',
    '2. 图片有实际信息量（不是单纯装饰、logo、品牌封面、通用占位）',
    '3. 图片与文章调性一致（技术或商业文章不要配无关人物照）',
    '',
    '硬拒绝（看到这类一定不选）：',
    '- APP 下载按钮、二维码、"扫一扫"提示图',
    '- 网站顶部 nav / 底部 footer 的横幅、订阅表单截图',
    '- 单独的品牌 logo、头像、按钮、UI 图标',
    '- 内容与本段完全无关（例如 AI 医学影像文章配股票 K 线图）',
    '',
    '如果所有候选都不合适，请返回 pickIndex = -1。宁缺毋滥：与其配一张"还行"的图让读者困惑，不如不配。',
  ]
    .filter(Boolean)
    .join('\n');

  const schema = z.object({
    pickIndex: z.number().int(),
    reason: z.string(),
  });

  const res = await llm.generate({
    schema,
    prompt,
    model,
    signal,
    images: candidates.map((c) => ({ url: c.url })),
    maxTokens: 400,
  });

  const idx = res.object.pickIndex;
  const reason = res.object.reason.slice(0, 120);
  if (idx < 0 || idx >= candidates.length) {
    log(emit, 'info', `vision rerank "${section.id}": no pick — ${reason}`);
    return null;
  }
  log(
    emit,
    'info',
    `vision rerank "${section.id}": picked #${idx} from ${candidates[idx]?.pluginName ?? '?'} — ${reason}`,
  );
  return candidates[idx] ?? null;
}

function keywordRerank(
  candidates: ImageCandidate[],
  section: SectionContent,
): ImageCandidate | null {
  if (candidates.length === 0) return null;
  const keywords = sectionKeywords(section);
  const scored = candidates
    .map((c) => ({ c, score: scoreCandidate(c, keywords) }))
    .sort((a, b) => b.score - a.score);
  return scored[0]?.c ?? null;
}

function sectionKeywords(
  section: Pick<SectionContent, 'title' | 'points' | 'imageHint'>,
): string[] {
  const tokens = new Set<string>();
  for (const src of [section.title, ...(section.imageHint?.keywords ?? []), ...section.points]) {
    for (const t of tokenize(src)) tokens.add(t);
  }
  return [...tokens];
}

function scoreCandidate(c: ImageCandidate, keywords: string[]): number {
  let score = 0;
  const alt = (c.alt ?? '').toLowerCase();
  const cap = (c.caption ?? '').toLowerCase();
  const sur = (c.surroundingText ?? '').toLowerCase();
  for (const k of keywords) {
    if (alt.includes(k)) score += 3;
    if (cap.includes(k)) score += 2;
    if (sur.includes(k)) score += 1;
  }
  if (c.kind === 'inline') score += 2;
  if (c.alt) score += 1;
  return score;
}

export function reorderWithAssigned(sources: Source[], assigned: Source | null): Source[] {
  if (!assigned) return sources;
  return [assigned, ...sources.filter((s) => s.url !== assigned.url)];
}

// Greedy dedupe with keyword-affinity tie-breaker. When sections outnumber
// sources we fall back to round-robin rather than leaving later sections
// without an image.
export function assignSources(
  sections: Pick<SectionContent, 'title' | 'points' | 'imageHint'>[],
  sources: Source[],
): (Source | null)[] {
  if (sources.length === 0) return sections.map(() => null);
  const used = new Set<string>();
  const assignments: (Source | null)[] = [];

  for (const section of sections) {
    const keywords = sectionKeywords(section);
    const ranked = [...sources].sort((a, b) => {
      const diff = keywordAffinity(b, keywords) - keywordAffinity(a, keywords);
      if (diff !== 0) return diff;
      return (b.score ?? 0) - (a.score ?? 0);
    });
    const pick = ranked.find((s) => !used.has(s.url)) ?? ranked[0] ?? null;
    if (pick) used.add(pick.url);
    assignments.push(pick);
  }
  return assignments;
}

function tokenize(input: string): string[] {
  return input
    .toLowerCase()
    .split(/[\s,.;:!?()[\]（）【】、，。；：！？/\\"'`~]+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 2);
}

function keywordAffinity(source: Source, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const hay = `${source.title} ${source.snippet}`.toLowerCase();
  let n = 0;
  for (const k of keywords) if (hay.includes(k)) n++;
  return n;
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 1) + '…';
}

// `IMAGE_RERANK_MODEL=disabled` (or false/0/empty) skips vision and uses
// keyword scoring as the sole strategy — useful for offline / no-budget runs.
export function resolveRerankModel(): string | null {
  const v = process.env.IMAGE_RERANK_MODEL;
  if (v === undefined) return DEFAULT_RERANK_MODEL;
  const trimmed = v.trim();
  if (trimmed === '' || ['disabled', 'false', '0', 'off'].includes(trimmed.toLowerCase())) {
    return null;
  }
  return trimmed;
}

// Filenames that usually mean "UI chrome / default social card" rather
// than real content imagery. Kept broad on purpose: vision reranker
// occasionally picks these as "cool-looking" choices, so we catch them
// before they even reach the LLM.
const PLACEHOLDER_PATTERNS: RegExp[] = [
  /\/shareicons?\//i,
  /docusaurus-social-card/i,
  /\/(og[-_]?default|default[-_]?og)[.-]/i,
  /\/social[-_]?share[-_]/i,
  /download[-_]?icon/i,
  /\bapp[-_]?(icon|download)\b/i,
  /\/pc[-_](download|qrcode|appdownload)/i,
  /\/(footer|header|nav)[-_]/i,
];

function isPlaceholderUrl(url: string): boolean {
  return PLACEHOLDER_PATTERNS.some((re) => re.test(url));
}
