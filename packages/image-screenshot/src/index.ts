import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { HTMLElement, parse as parseHtml } from 'node-html-parser';
import { chromium, type Browser } from 'playwright';
import type {
  ImageCandidate,
  ImageOptions,
  ImagePlugin,
  ImageRef,
  ImageRequest,
  Source,
} from '@topic2md/shared';

export interface ScreenshotImageOptions {
  outDir?: string;
  urlPrefix?: string;
  concurrency?: number;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  fullPage?: boolean;
  /**
   * When the static HTML yields fewer than this many content images, spin up
   * Playwright to render the page and re-extract. Set to 0 to disable.
   */
  spaFallbackMinImages?: number;
  userAgent?: string;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };
const MAX_HTML_BYTES = 1_000_000;

export function screenshotImage(options: ScreenshotImageOptions = {}): ImagePlugin {
  const outDir = resolve(options.outDir ?? './out/images');
  const urlPrefix = options.urlPrefix ?? '';
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fullPage = options.fullPage ?? false;
  const spaFallbackMinImages = options.spaFallbackMinImages ?? 2;
  const userAgent =
    options.userAgent ?? 'Mozilla/5.0 (topic2md; +https://github.com/LLM-X-Factorer/topic2md)';

  const semaphore = createSemaphore(options.concurrency ?? 3);
  let browserPromise: Promise<Browser> | null = null;

  async function getBrowser(): Promise<Browser> {
    if (!browserPromise) {
      browserPromise = chromium.launch({ headless: true }).catch((err) => {
        browserPromise = null;
        if (
          err instanceof Error &&
          /Executable doesn't exist|BrowserType\.launch/.test(err.message)
        ) {
          throw new Error(
            'Playwright Chromium is not installed. Run `pnpm exec playwright install chromium` first.\n' +
              `Original: ${err.message}`,
          );
        }
        throw err;
      });
    }
    return browserPromise;
  }

  async function collectCandidates(source: Source, signal: AbortSignal | undefined) {
    const candidates: ImageCandidate[] = [];
    const html = await fetchHtml(source.url, userAgent, timeoutMs, signal).catch(() => null);

    if (html) {
      for (const c of extractContentImages(html, source.url)) {
        candidates.push(toCandidate(c, source.url));
      }
      const og = pickOgCandidate(html, source);
      if (og) candidates.push(og);
    }

    if (candidates.length < spaFallbackMinImages && spaFallbackMinImages > 0) {
      const rendered = await renderAndExtract(source, signal).catch(() => null);
      if (rendered) {
        const seen = new Set(candidates.map((c) => c.url));
        for (const c of rendered) {
          if (!seen.has(c.url)) candidates.push(c);
        }
      }
    }

    return candidates;
  }

  async function renderAndExtract(
    source: Source,
    signal: AbortSignal | undefined,
  ): Promise<ImageCandidate[] | null> {
    const browser = await getBrowser();
    const ctx = await browser.newContext({ viewport, userAgent });
    try {
      const page = await ctx.newPage();
      if (signal) signal.addEventListener('abort', () => page.close().catch(() => {}));
      await page.goto(source.url, { waitUntil: 'networkidle', timeout: timeoutMs });
      const html = await page.content();
      return extractContentImages(html.slice(0, MAX_HTML_BYTES), source.url).map((c) =>
        toCandidate(c, source.url),
      );
    } finally {
      await ctx.close();
    }
  }

  return {
    name: 'screenshot',
    async discover(request: ImageRequest, reqOpts?: ImageOptions): Promise<ImageCandidate[]> {
      const source = pickSource(request.sources);
      if (!source) return [];
      return semaphore(() => collectCandidates(source, reqOpts?.signal));
    },
    async capture(request: ImageRequest, reqOpts?: ImageOptions): Promise<ImageRef | null> {
      const source = pickSource(request.sources);
      if (!source) return null;

      return semaphore(async () => {
        const browser = await getBrowser();
        const ctx = await browser.newContext({ viewport, userAgent });
        try {
          const page = await ctx.newPage();
          await page.goto(source.url, { waitUntil: 'load', timeout: timeoutMs });
          const buffer = await page.screenshot({ type: 'png', fullPage });
          const file = await persist(buffer, outDir, source.url, 'png');
          return {
            url: urlPrefix + file.publicUrl,
            alt: request.section.title,
            sourceUrl: source.url,
            caption: request.section.imageHint?.purpose,
            kind: 'screenshot',
            width: viewport.width,
            height: fullPage ? undefined : viewport.height,
          };
        } finally {
          await ctx.close();
        }
      });
    },
    async dispose() {
      if (!browserPromise) return;
      const p = browserPromise;
      browserPromise = null;
      try {
        const browser = await p;
        await browser.close();
      } catch {
        /* best-effort */
      }
    },
  };
}

function toCandidate(c: ContentImageCandidate, sourceUrl: string): ImageCandidate {
  return {
    url: c.url,
    alt: c.alt || undefined,
    caption: c.caption,
    surroundingText: c.surroundingText || undefined,
    sourceUrl,
    kind: 'inline',
    width: c.width,
    height: c.height,
  };
}

function pickOgCandidate(html: string, source: Source): ImageCandidate | null {
  const ogUrl = extractOgImageUrl(html);
  if (!ogUrl) return null;
  let absolute: string;
  try {
    absolute = new URL(ogUrl, source.url).toString();
  } catch {
    return null;
  }
  return {
    url: absolute,
    alt: source.title,
    sourceUrl: source.url,
    kind: 'og',
  };
}

async function fetchHtml(
  url: string,
  ua: string,
  timeout: number,
  signal: AbortSignal | undefined,
): Promise<string | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  const linkedAbort = () => ctrl.abort();
  signal?.addEventListener('abort', linkedAbort, { once: true });
  try {
    const res = await fetch(url, {
      headers: { 'user-agent': ua, accept: 'text/html,*/*;q=0.8' },
      signal: ctrl.signal,
      redirect: 'follow',
    });
    if (!res.ok) return null;
    return (await res.text()).slice(0, MAX_HTML_BYTES);
  } finally {
    clearTimeout(t);
    signal?.removeEventListener('abort', linkedAbort);
  }
}

// Honour the caller's ordering — core's images step greedy-assigns one
// distinct source per section and expects the chosen one at position 0.
function pickSource(sources: Source[]): Source | null {
  return sources[0] ?? null;
}

const OG_META_KEYS = [
  'og:image:secure_url',
  'og:image:url',
  'og:image',
  'twitter:image:src',
  'twitter:image',
] as const;

export function extractOgImageUrl(html: string): string | null {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false } });
  for (const key of OG_META_KEYS) {
    const el =
      root.querySelector(`meta[property="${key}"]`) ?? root.querySelector(`meta[name="${key}"]`);
    const content = el?.getAttribute('content')?.trim();
    if (content) return content;
  }
  const linkImage = root.querySelector('link[rel="image_src"]')?.getAttribute('href')?.trim();
  return linkImage || null;
}

export interface ContentImageCandidate {
  url: string;
  alt: string;
  caption?: string;
  width?: number;
  height?: number;
  inMain: boolean;
  surroundingText: string;
  domOrder: number;
}

const SKIP_URL_PATTERNS = [
  /\blogo\b/i,
  /\bicon\b/i,
  /\bfavicon\b/i,
  /\bavatar\b/i,
  /\bsprite\b/i,
  /\bbullet\b/i,
  /\bdivider\b/i,
  /\bbutton\b/i,
  /\bbadge\b/i,
  /\bemoji\b/i,
  /\bspacer\b/i,
  /\bpixel\b/i,
  /\btracker\b/i,
  /\bad[s]?[-_/]/i,
  /qrcode/i,
  /\.svg(?:[?#]|$)/i,
  /^data:/i,
  // UI chrome patterns seen in the wild:
  // tidenews.com.cn/imgs/pc-back-top.png, pc-download.png, pc-share.png …
  /\/imgs?\/(pc|m|mobile|wap)[-_]/i,
  /\b(back[-_]?top|scroll[-_]?top|go[-_]?top|top[-_]?btn)\b/i,
  /\b(download|subscribe|follow|share)[-_](btn|button|icon|img)\b/i,
  /\bqr[-_]?(btn|button|icon|img|code)\b/i,
];

const SKIP_ALT_PATTERNS = [
  /^\s*(logo|icon|avatar|author|分享|share)\s*$/i,
  /qr.?code/i,
  /二维码/,
  // Common Chinese UI-chrome alts — most news sites label nav assets this way
  /(作者)?头像$/,
  /^(关注|订阅|点赞|收藏|评论|微信|微博|抖音)$/,
  /^回到顶部$|^返回顶部$/,
  /^(下载|下载APP|扫码下载|扫一扫)$/,
];

const NON_CONTENT_ANCESTORS = new Set(['nav', 'footer', 'header', 'aside']);
const PREFERRED_ANCESTORS = new Set(['article', 'main']);
const MIN_WIDTH = 200;
const MIN_HEIGHT = 150;

export function extractContentImages(html: string, baseUrl: string): ContentImageCandidate[] {
  const root = parseHtml(html, { blockTextElements: { script: false, style: false } });
  const imgs = root.querySelectorAll('img');
  const candidates: ContentImageCandidate[] = [];
  imgs.forEach((img, i) => {
    const raw =
      img.getAttribute('src') ||
      img.getAttribute('data-src') ||
      img.getAttribute('data-original') ||
      img.getAttribute('data-lazy-src') ||
      '';
    if (!raw) return;
    if (SKIP_URL_PATTERNS.some((re) => re.test(raw))) return;

    const alt = (img.getAttribute('alt') ?? '').trim();
    if (SKIP_ALT_PATTERNS.some((re) => re.test(alt))) return;

    const widthAttr = toInt(img.getAttribute('width'));
    const heightAttr = toInt(img.getAttribute('height'));
    if (widthAttr !== undefined && widthAttr < MIN_WIDTH) return;
    if (heightAttr !== undefined && heightAttr < MIN_HEIGHT) return;

    const ancestry = collectAncestry(img);
    if (ancestry.some((tag) => NON_CONTENT_ANCESTORS.has(tag))) return;

    let absolute: string;
    try {
      absolute = new URL(raw, baseUrl).toString();
    } catch {
      return;
    }

    candidates.push({
      url: absolute,
      alt,
      caption: findCaption(img),
      width: widthAttr,
      height: heightAttr,
      inMain: ancestry.some((tag) => PREFERRED_ANCESTORS.has(tag)),
      surroundingText: collectSurroundingText(img),
      domOrder: i,
    });
  });
  return candidates;
}

function collectAncestry(node: HTMLElement): string[] {
  const tags: string[] = [];
  let cur: HTMLElement | null = node.parentNode ?? null;
  while (cur) {
    const tag = cur.tagName?.toLowerCase();
    if (tag) tags.push(tag);
    cur = cur.parentNode ?? null;
  }
  return tags;
}

function findCaption(img: HTMLElement): string | undefined {
  const figure = img.closest('figure');
  if (!figure) return undefined;
  const figcap = figure.querySelector('figcaption');
  const text = figcap?.text?.trim();
  return text ? text.slice(0, 200) : undefined;
}

function collectSurroundingText(img: HTMLElement): string {
  const parent = img.parentNode;
  if (!parent) return '';
  return parent.text.trim().slice(0, 500);
}

function toInt(value: string | undefined | null): number | undefined {
  if (!value) return undefined;
  const n = parseInt(value, 10);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

async function persist(
  buffer: Buffer,
  outDir: string,
  sourceUrl: string,
  ext: string,
): Promise<{ absolutePath: string; publicUrl: string }> {
  await mkdir(outDir, { recursive: true });
  const hash = createHash('sha1').update(sourceUrl).digest('hex').slice(0, 16);
  const filename = `${hash}.${ext}`;
  const absolutePath = join(outDir, filename);
  await writeFile(absolutePath, buffer);
  return { absolutePath, publicUrl: absolutePath };
}

function createSemaphore(max: number): <T>(fn: () => Promise<T>) => Promise<T> {
  let active = 0;
  const queue: (() => void)[] = [];
  return async function run<T>(fn: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((r) => queue.push(r));
    }
    active++;
    try {
      return await fn();
    } finally {
      active--;
      const next = queue.shift();
      if (next) next();
    }
  };
}
