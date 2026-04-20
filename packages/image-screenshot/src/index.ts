import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { parse as parseHtml } from 'node-html-parser';
import { chromium, type Browser } from 'playwright';
import type { ImageOptions, ImagePlugin, ImageRef, ImageRequest, Source } from '@topic2md/shared';

export interface ScreenshotImageOptions {
  outDir?: string;
  urlPrefix?: string;
  concurrency?: number;
  viewport?: { width: number; height: number };
  timeoutMs?: number;
  fullPage?: boolean;
  preferOgImage?: boolean;
  userAgent?: string;
}

const DEFAULT_VIEWPORT = { width: 1280, height: 720 };

export function screenshotImage(options: ScreenshotImageOptions = {}): ImagePlugin {
  const outDir = resolve(options.outDir ?? './out/images');
  const urlPrefix = options.urlPrefix ?? '';
  const viewport = options.viewport ?? DEFAULT_VIEWPORT;
  const timeoutMs = options.timeoutMs ?? 20_000;
  const fullPage = options.fullPage ?? false;
  const preferOgImage = options.preferOgImage ?? true;
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

  return {
    name: 'screenshot',
    async capture(request: ImageRequest, reqOpts?: ImageOptions): Promise<ImageRef | null> {
      const source = pickSource(request.sources);
      if (!source) return null;

      return semaphore(async () => {
        if (preferOgImage) {
          const og = await fetchOgImage(source, userAgent, timeoutMs, reqOpts?.signal).catch(
            () => null,
          );
          if (og) return og;
        }

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
  };

  async function fetchOgImage(
    source: Source,
    ua: string,
    timeout: number,
    signal: AbortSignal | undefined,
  ): Promise<ImageRef | null> {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), timeout);
    const linkedAbort = () => ctrl.abort();
    signal?.addEventListener('abort', linkedAbort, { once: true });
    try {
      const res = await fetch(source.url, {
        headers: { 'user-agent': ua, accept: 'text/html,*/*;q=0.8' },
        signal: ctrl.signal,
        redirect: 'follow',
      });
      if (!res.ok) return null;
      const html = (await res.text()).slice(0, 500_000);
      const ogUrl = extractOgImageUrl(html);
      if (!ogUrl) return null;
      const absolute = new URL(ogUrl, source.url).toString();
      return {
        url: absolute,
        alt: source.title,
        sourceUrl: source.url,
        kind: 'og',
      };
    } finally {
      clearTimeout(t);
      signal?.removeEventListener('abort', linkedAbort);
    }
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
