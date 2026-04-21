import { chromium } from 'playwright';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { createHash } from 'node:crypto';

// Usage: node scripts/mkpdf.mjs <markdown-path>
//   e.g. node scripts/mkpdf.mjs out/2026-04-21-xxx.md
// Outputs sibling .pdf + caches remote images in out/_pdf_assets/
const SRC = process.argv[2];
if (!SRC) {
  console.error('Usage: node scripts/mkpdf.mjs <markdown-path>');
  process.exit(2);
}
const DST = SRC.replace(/\.md$/i, '.pdf');
const ASSETS = 'out/_pdf_assets';

await mkdir(ASSETS, { recursive: true });

let md = await readFile(SRC, 'utf8');

let title = 'Document', author = '', date = '';
const fm = md.match(/^---\n([\s\S]*?)\n---\n/);
if (fm) {
  const yaml = fm[1];
  const get = (k) => (yaml.match(new RegExp(`^${k}:\\s*(.+)$`, 'm')) ?? [])[1]?.trim() ?? '';
  title = get('title') || title;
  author = get('author');
  date = get('date');
  md = md.slice(fm[0].length);
}

const urls = [...md.matchAll(/!\[[^\]]*\]\((https?:\/\/[^)]+)\)/g)].map((m) => m[1]);
for (const url of urls) {
  const hash = createHash('sha1').update(url).digest('hex').slice(0, 10);
  const ext = (url.match(/\.(png|jpg|jpeg|gif|webp|svg)(\?|$)/i)?.[1] || 'png').toLowerCase();
  const fn = path.join(ASSETS, `${hash}.${ext}`);
  if (!existsSync(fn)) {
    const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!res.ok) { console.warn(`fetch fail ${res.status} ${url}`); continue; }
    await writeFile(fn, Buffer.from(await res.arrayBuffer()));
    console.log(`fetched -> ${fn}`);
  }
  md = md.replaceAll(url, `file://${path.resolve(fn)}`);
}

const tmpMd = path.resolve(ASSETS, '.source.md');
await writeFile(tmpMd, md, 'utf8');

const bodyHtmlPath = path.resolve(ASSETS, '.body.html');
const r = spawnSync('pandoc', [tmpMd, '-o', bodyHtmlPath, '--from=gfm', '--to=html5'], {
  encoding: 'utf8',
});
if (r.status !== 0) {
  console.error(r.stderr);
  process.exit(r.status ?? 1);
}
const body = await readFile(bodyHtmlPath, 'utf8');

const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${title}</title>
<style>
@page { size: A4; margin: 18mm 16mm; }
html, body {
  font-family: "PingFang SC", "Hiragino Sans GB", "Songti SC", sans-serif;
  font-size: 11pt; line-height: 1.8; color: #1a1a1a; background: #fff;
}
h1 { font-size: 22pt; border-bottom: 2px solid #222; padding-bottom: .4em; margin: 0 0 .5em; }
h2 { font-size: 16pt; margin: 1.6em 0 .6em; border-left: 4px solid #444; padding-left: .55em; page-break-after: avoid; }
h3 { font-size: 13pt; margin: 1.2em 0 .5em; }
p  { margin: .65em 0; text-align: justify; }
img { max-width: 100%; max-height: 15cm; display: block; margin: .9em auto .3em; page-break-inside: avoid; }
em { display: block; text-align: center; color: #666; font-size: 9.5pt; margin: 0 0 1.3em; }
ul, ol { padding-left: 1.6em; }
li { margin: .25em 0; }
a { color: #1a5490; text-decoration: none; }
hr { border: none; border-top: 1px solid #ccc; margin: 1.5em 0; }
code { font-family: "SF Mono", Menlo, monospace; font-size: 10pt; background: #f3f3f3; padding: 1px 4px; border-radius: 3px; }
pre  { background: #f5f5f5; padding: .7em .9em; border-radius: 4px; font-size: 10pt; line-height: 1.5; page-break-inside: avoid; }
.meta { color: #888; font-size: 10pt; margin: -.5em 0 2em; }
</style></head><body>
<h1>${title}</h1>
<div class="meta">${[author, date].filter(Boolean).join(' · ')}</div>
${body}
</body></html>`;

const htmlPath = path.resolve(ASSETS, 'source.html');
await writeFile(htmlPath, html, 'utf8');

const browser = await chromium.launch();
const page = await browser.newPage();
await page.goto(`file://${htmlPath}`, { waitUntil: 'networkidle' });
await page.pdf({
  path: DST,
  format: 'A4',
  margin: { top: '18mm', right: '16mm', bottom: '18mm', left: '16mm' },
  printBackground: true,
  displayHeaderFooter: true,
  headerTemplate: '<div></div>',
  footerTemplate:
    '<div style="font-size:9px;color:#888;width:100%;text-align:center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
});
await browser.close();

const { size } = await (await import('node:fs/promises')).stat(DST);
console.log(`-> ${DST}  (${(size / 1024).toFixed(1)} KB)`);
