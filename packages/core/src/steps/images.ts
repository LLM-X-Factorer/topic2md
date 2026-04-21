import { appendFile } from 'node:fs/promises';
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

  const gated = await clipGate(filtered, section, emit, signal);
  if (gated.length === 0) {
    log(emit, 'info', `section "${section.id}" left without image (CLIP gate rejected all candidates)`);
    return section;
  }
  const bounded = gated.slice(0, MAX_CANDIDATES_PER_SECTION);

  let winner: ImageCandidate | null = null;
  let visionRejected = false;
  if (rerankModel) {
    try {
      winner = await visionRerank(bounded, section, topic, llm, rerankModel, emit, signal);
      if (!winner) visionRejected = true;
    } catch (err) {
      log(
        emit,
        'warn',
        `vision rerank failed for "${section.id}": ${err instanceof Error ? err.message : String(err)} — falling back to keyword scoring`,
      );
    }
  }
  // Only fall back to keyword scoring when vision actually errored (or was
  // disabled). A deliberate "-1 / no good candidate" from vision must be
  // respected — otherwise the "宁缺毋滥" instruction in the prompt is a lie.
  if (!winner && !visionRejected) {
    winner = keywordRerank(bounded, section);
  }
  await logCandidatePool(section, topic, bounded, winner, emit);

  if (!winner) {
    if (visionRejected) {
      log(emit, 'info', `section "${section.id}" left without image (vision rejected all candidates)`);
    }
    return section;
  }

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
    .map((c) => ({ c, hits: countKeywordHits(c, keywords), score: scoreCandidate(c, keywords) }))
    .sort((a, b) => b.score - a.score);
  const top = scored[0];
  // Without a single keyword anywhere in alt/caption/context the "score" is
  // just noise from `kind === 'inline'` + having alt text. Better no image.
  if (!top || top.hits === 0) return null;
  return top.c;
}

function countKeywordHits(c: ImageCandidate, keywords: string[]): number {
  if (keywords.length === 0) return 0;
  const hay = `${c.alt ?? ''} ${c.caption ?? ''} ${c.surroundingText ?? ''}`.toLowerCase();
  let n = 0;
  for (const k of keywords) if (hay.includes(k)) n++;
  return n;
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

// Pre-vision pool filter: embed section query + each candidate image via
// jina-clip-v2 on Replicate, drop anything below cos-sim threshold. Calibrated
// on 68 labeled candidates: AUC 0.85, threshold 0.30 → recall 0.97, kills
// ~60% of irrelevant images. Off by default unless REPLICATE_API_TOKEN is set;
// set CLIP_GATE=disabled to force-off, or CLIP_GATE_THRESHOLD=<float> to retune.
const CLIP_MODEL_VERSION =
  '5050c3108bab23981802011a3c76ee327cc0dbfdd31a2f4ef1ee8ef0d3f0b448';
const CLIP_DEFAULT_THRESHOLD = 0.3;

async function clipGate(
  candidates: ImageCandidate[],
  section: SectionContent,
  emit: EmitFn,
  signal?: AbortSignal,
): Promise<ImageCandidate[]> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token || process.env.CLIP_GATE === 'disabled') return candidates;
  const threshold = Number(process.env.CLIP_GATE_THRESHOLD ?? CLIP_DEFAULT_THRESHOLD);
  if (!Number.isFinite(threshold)) return candidates;

  const query = sectionQueryText(section);
  try {
    const [qEmb, ...imgEmbsRaw] = await Promise.all([
      clipEmbed({ text: query }, token, signal),
      ...candidates.map((c) =>
        clipEmbed({ image: c.url }, token, signal).catch((err) => {
          log(
            emit,
            'warn',
            `CLIP embed failed for ${c.url}: ${err instanceof Error ? err.message : String(err)}`,
          );
          return null;
        }),
      ),
    ]);
    const scored = candidates.map((c, i) => {
      const e = imgEmbsRaw[i];
      return { c, score: e ? cosSim(qEmb, e) : null };
    });
    const kept = scored
      .filter((s): s is { c: ImageCandidate; score: number } => s.score != null && s.score >= threshold)
      .sort((a, b) => b.score - a.score);

    const scoreStr = scored
      .map((s) => (s.score == null ? 'err' : s.score.toFixed(2)))
      .join(',');
    log(
      emit,
      'info',
      `CLIP gate "${section.id}": kept ${kept.length}/${candidates.length} @ ≥${threshold} [${scoreStr}]`,
    );
    return kept.map((s) => s.c);
  } catch (err) {
    log(
      emit,
      'warn',
      `CLIP gate failed for "${section.id}": ${err instanceof Error ? err.message : String(err)} — skipping filter`,
    );
    return candidates;
  }
}

async function clipEmbed(
  input: { text?: string; image?: string },
  token: string,
  signal?: AbortSignal,
): Promise<number[]> {
  const authHeaders = { Authorization: `Token ${token}`, 'Content-Type': 'application/json' };
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    signal,
    headers: { ...authHeaders, Prefer: 'wait=60' },
    body: JSON.stringify({ version: CLIP_MODEL_VERSION, input }),
  });
  if (!res.ok) throw new Error(`replicate HTTP ${res.status}`);
  let body = (await res.json()) as {
    status: string;
    output?: string[];
    error?: string;
    urls?: { get?: string };
  };
  // Cold-start on the model side: Prefer: wait=60 may time out in "starting"
  // or "processing". Poll the prediction URL until it terminates.
  const pollUrl = body.urls?.get;
  const deadline = Date.now() + 240_000; // 4 min total
  while ((body.status === 'starting' || body.status === 'processing') && pollUrl) {
    if (Date.now() > deadline) throw new Error(`replicate poll timeout (last status=${body.status})`);
    await new Promise((r) => setTimeout(r, 2000));
    const pollRes = await fetch(pollUrl, { headers: authHeaders, signal });
    if (!pollRes.ok) throw new Error(`replicate poll HTTP ${pollRes.status}`);
    body = (await pollRes.json()) as typeof body;
  }
  if (body.status !== 'succeeded') {
    throw new Error(`replicate status=${body.status} error=${body.error ?? '?'}`);
  }
  const first = body.output?.[0];
  if (!first) throw new Error('replicate: empty output');
  const buf = Buffer.from(first, 'base64');
  return Array.from(new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4));
}

function cosSim(a: number[], b: number[]): number {
  let dot = 0;
  let na = 0;
  let nb = 0;
  const len = Math.min(a.length, b.length);
  for (let i = 0; i < len; i++) {
    const ai = a[i] ?? 0;
    const bi = b[i] ?? 0;
    dot += ai * bi;
    na += ai * ai;
    nb += bi * bi;
  }
  return na === 0 || nb === 0 ? 0 : dot / Math.sqrt(na * nb);
}

function sectionQueryText(section: SectionContent): string {
  const bits: string[] = [section.title];
  if (section.imageHint?.purpose) bits.push(section.imageHint.purpose);
  if (section.imageHint?.keywords?.length) bits.push(section.imageHint.keywords.join(', '));
  if (section.points.length) bits.push(section.points.slice(0, 4).join('; '));
  return bits.join(' | ');
}

// Best-effort JSONL dump for offline CLIP-threshold calibration. Gated by
// IMAGE_CANDIDATE_LOG=<path>; writes one record per section with the full
// bounded candidate pool + which URL won. Silent no-op when env unset.
async function logCandidatePool(
  section: SectionContent,
  topic: string,
  candidates: ImageCandidate[],
  winner: ImageCandidate | null,
  emit: EmitFn,
): Promise<void> {
  const path = process.env.IMAGE_CANDIDATE_LOG;
  if (!path) return;
  const record = {
    at: new Date().toISOString(),
    topic,
    sectionId: section.id,
    sectionTitle: section.title,
    points: section.points,
    imageHint: section.imageHint ?? null,
    candidates: candidates.map((c) => ({
      url: c.url,
      alt: c.alt ?? null,
      caption: c.caption ?? null,
      surroundingText: c.surroundingText ?? null,
      sourceUrl: c.sourceUrl ?? null,
      pluginName: c.pluginName ?? null,
      kind: c.kind,
    })),
    winnerUrl: winner?.url ?? null,
  };
  try {
    await appendFile(path, JSON.stringify(record) + '\n', 'utf8');
  } catch (err) {
    log(
      emit,
      'warn',
      `candidate pool log append failed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
