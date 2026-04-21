#!/usr/bin/env node
// Local HTTP labeler for image candidate pools.
//
// Usage:
//   node scripts/label-candidates.mjs
//
// Reads:   out/debug/candidates.jsonl
// Writes:  out/debug/labels.jsonl  (append-only; survives restarts)
//
// Opens http://localhost:7070/ — one candidate per page with the actual
// image + section context. Click Relevant / Irrelevant / Skip and move on.

import http from 'node:http';
import { readFile, appendFile, stat } from 'node:fs/promises';
import { URL } from 'node:url';

const PORT = 7070;
const ROOT = new URL('..', import.meta.url).pathname;
const CANDIDATES = `${ROOT}out/debug/candidates.jsonl`;
const LABELS = `${ROOT}out/debug/labels.jsonl`;

async function loadJsonl(path) {
  try {
    await stat(path);
  } catch {
    return [];
  }
  const raw = await readFile(path, 'utf8');
  return raw
    .trim()
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

function candidateKey(sectionId, candidateUrl) {
  return `${sectionId}::${candidateUrl}`;
}

async function buildQueue() {
  const records = await loadJsonl(CANDIDATES);
  const labels = await loadJsonl(LABELS);
  const labeled = new Set(labels.map((l) => candidateKey(l.sectionId, l.url)));
  const queue = [];
  for (const rec of records) {
    for (const cand of rec.candidates) {
      const key = candidateKey(rec.sectionId, cand.url);
      if (labeled.has(key)) continue;
      queue.push({ rec, cand });
    }
  }
  return { queue, total: records.reduce((n, r) => n + r.candidates.length, 0), done: labeled.size };
}

function escapeHtml(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function renderPage({ rec, cand, progress }) {
  const { done, total } = progress;
  const points = rec.points.map((p) => `<li>${escapeHtml(p)}</li>`).join('');
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>Label ${done}/${total}</title>
<style>
  body { font: 14px/1.5 system-ui; max-width: 900px; margin: 20px auto; padding: 0 16px; }
  img { max-width: 100%; max-height: 500px; border: 1px solid #ddd; display: block; margin: 8px 0; }
  .meta { background: #f5f5f5; padding: 12px; border-radius: 6px; margin-bottom: 12px; }
  .meta dt { font-weight: 600; margin-top: 6px; }
  .meta dd { margin: 2px 0 0 16px; color: #444; }
  .actions { display: flex; gap: 8px; margin-top: 12px; }
  .actions button { font-size: 18px; padding: 12px 24px; border: 0; border-radius: 6px; cursor: pointer; }
  .relevant { background: #22c55e; color: white; }
  .irrelevant { background: #ef4444; color: white; }
  .skip { background: #6b7280; color: white; }
  .progress { color: #666; font-size: 12px; }
  .small { color: #666; font-size: 12px; word-break: break-all; }
</style>
</head><body>
<div class="progress">Progress: ${done} / ${total} labeled</div>
<h2>${escapeHtml(rec.topic)}</h2>
<h3>Section: ${escapeHtml(rec.sectionTitle)}</h3>
<ul>${points}</ul>
<div class="meta">
  <dt>alt</dt><dd>${escapeHtml(cand.alt) || '<em>(empty)</em>'}</dd>
  <dt>caption</dt><dd>${escapeHtml(cand.caption) || '<em>(empty)</em>'}</dd>
  <dt>surroundingText</dt><dd>${escapeHtml(cand.surroundingText) || '<em>(empty)</em>'}</dd>
  <dt>source page</dt><dd class="small"><a href="${escapeHtml(cand.sourceUrl || '#')}" target="_blank">${escapeHtml(cand.sourceUrl) || '(none)'}</a></dd>
  <dt>plugin</dt><dd>${escapeHtml(cand.pluginName || '?')} / kind=${escapeHtml(cand.kind)}</dd>
  <dt>image url</dt><dd class="small"><a href="${escapeHtml(cand.url)}" target="_blank">${escapeHtml(cand.url)}</a></dd>
</div>
<img src="${escapeHtml(cand.url)}" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{textContent:'(image failed to load — still labelable)',style:'padding:20px;background:#fee;border:1px dashed #c00'}))"/>
<form method="POST" action="/label" class="actions">
  <input type="hidden" name="sectionId" value="${escapeHtml(rec.sectionId)}"/>
  <input type="hidden" name="url" value="${escapeHtml(cand.url)}"/>
  <input type="hidden" name="topic" value="${escapeHtml(rec.topic)}"/>
  <button class="relevant" name="label" value="relevant" accesskey="r">Relevant (R)</button>
  <button class="irrelevant" name="label" value="irrelevant" accesskey="i">Irrelevant (I)</button>
  <button class="skip" name="label" value="skip" accesskey="s">Skip (S)</button>
</form>
<script>
  document.addEventListener('keydown', (e) => {
    if (e.target.tagName === 'INPUT') return;
    if (e.key === 'r' || e.key === 'R') document.querySelector('.relevant').click();
    if (e.key === 'i' || e.key === 'I') document.querySelector('.irrelevant').click();
    if (e.key === 's' || e.key === 'S') document.querySelector('.skip').click();
  });
</script>
</body></html>`;
}

function renderDone({ total }) {
  return `<!doctype html><html><body style="font:16px system-ui;padding:40px">
<h2>All done — ${total} candidates labeled.</h2>
<p>Results in <code>out/debug/labels.jsonl</code>. You can close this tab.</p>
</body></html>`;
}

async function parseForm(req) {
  const chunks = [];
  for await (const c of req) chunks.push(c);
  const body = Buffer.concat(chunks).toString('utf8');
  const out = {};
  for (const pair of body.split('&')) {
    const [k, v] = pair.split('=');
    out[decodeURIComponent(k)] = decodeURIComponent((v ?? '').replace(/\+/g, ' '));
  }
  return out;
}

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === 'GET' && req.url === '/') {
      const { queue, total, done } = await buildQueue();
      if (queue.length === 0) {
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
        res.end(renderDone({ total }));
        return;
      }
      const { rec, cand } = queue[0];
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(renderPage({ rec, cand, progress: { done, total } }));
      return;
    }
    if (req.method === 'POST' && req.url === '/label') {
      const form = await parseForm(req);
      const record = {
        at: new Date().toISOString(),
        topic: form.topic,
        sectionId: form.sectionId,
        url: form.url,
        label: form.label,
      };
      await appendFile(LABELS, JSON.stringify(record) + '\n', 'utf8');
      res.writeHead(303, { location: '/' });
      res.end();
      return;
    }
    res.writeHead(404);
    res.end('not found');
  } catch (err) {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(String(err?.stack ?? err));
  }
});

const { total, done } = await buildQueue();
server.listen(PORT, () => {
  console.log(`labeler listening on http://localhost:${PORT}/`);
  console.log(`progress: ${done}/${total} already labeled`);
});
