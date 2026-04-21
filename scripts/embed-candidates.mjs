#!/usr/bin/env node
// Embed section queries + image candidates via Replicate jina-clip-v2.
//
// Usage:
//   node scripts/embed-candidates.mjs
//
// Reads:   out/debug/candidates.jsonl
// Writes:  out/debug/embeddings.jsonl (append-only; re-running skips done items)
//
// Requires REPLICATE_API_TOKEN env var.

import { readFile, appendFile, stat } from 'node:fs/promises';
import { URL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const CANDIDATES = `${ROOT}out/debug/candidates.jsonl`;
const EMBEDDINGS = `${ROOT}out/debug/embeddings.jsonl`;

const MODEL_VERSION = '5050c3108bab23981802011a3c76ee327cc0dbfdd31a2f4ef1ee8ef0d3f0b448';
const TOKEN = process.env.REPLICATE_API_TOKEN;
if (!TOKEN) {
  console.error('missing REPLICATE_API_TOKEN');
  process.exit(1);
}

async function loadJsonl(path) {
  try { await stat(path); } catch { return []; }
  const raw = await readFile(path, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function sectionQueryText(rec) {
  // Mirror what visionRerank sees on the text side — title, points, imageHint.
  const bits = [rec.sectionTitle];
  if (rec.imageHint?.purpose) bits.push(rec.imageHint.purpose);
  if (rec.imageHint?.keywords?.length) bits.push(rec.imageHint.keywords.join(', '));
  if (rec.points?.length) bits.push(rec.points.slice(0, 4).join('; '));
  return bits.join(' | ');
}

async function callReplicate(input, attempt = 1) {
  const res = await fetch('https://api.replicate.com/v1/predictions', {
    method: 'POST',
    headers: {
      Authorization: `Token ${TOKEN}`,
      'Content-Type': 'application/json',
      Prefer: 'wait=60',
    },
    body: JSON.stringify({ version: MODEL_VERSION, input }),
  });
  if (res.status === 429 || res.status >= 500) {
    if (attempt >= 4) throw new Error(`replicate ${res.status} after ${attempt} attempts`);
    await new Promise((r) => setTimeout(r, 2 ** attempt * 1000));
    return callReplicate(input, attempt + 1);
  }
  const body = await res.json();
  if (body.status !== 'succeeded') {
    throw new Error(`replicate returned status=${body.status} error=${JSON.stringify(body.error)}`);
  }
  return body.output; // array of base64 float32 strings
}

function decodeEmbedding(base64) {
  const buf = Buffer.from(base64, 'base64');
  const arr = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  return Array.from(arr);
}

async function appendEmbedding(rec) {
  await appendFile(EMBEDDINGS, JSON.stringify(rec) + '\n', 'utf8');
}

async function main() {
  const cands = await loadJsonl(CANDIDATES);
  const done = await loadJsonl(EMBEDDINGS);
  const doneTextKeys = new Set(done.filter((e) => e.kind === 'text').map((e) => e.key));
  const doneImageKeys = new Set(done.filter((e) => e.kind === 'image').map((e) => e.key));

  // Enumerate work items
  const textQueue = [];
  const imageQueue = [];
  const seenImage = new Set();
  for (const rec of cands) {
    const textKey = `${rec.topic}::${rec.sectionId}`;
    if (!doneTextKeys.has(textKey)) {
      textQueue.push({ key: textKey, query: sectionQueryText(rec), sectionId: rec.sectionId, topic: rec.topic });
    }
    for (const c of rec.candidates) {
      if (seenImage.has(c.url)) continue;
      seenImage.add(c.url);
      if (!doneImageKeys.has(c.url)) imageQueue.push({ key: c.url });
    }
  }

  console.log(`texts pending: ${textQueue.length} (already done: ${doneTextKeys.size})`);
  console.log(`images pending: ${imageQueue.length} (already done: ${doneImageKeys.size})`);

  let failures = 0;
  for (let i = 0; i < textQueue.length; i++) {
    const item = textQueue[i];
    try {
      const out = await callReplicate({ text: item.query });
      const embedding = decodeEmbedding(out[0]);
      await appendEmbedding({
        kind: 'text',
        key: item.key,
        sectionId: item.sectionId,
        topic: item.topic,
        query: item.query,
        dim: embedding.length,
        embedding,
      });
      console.log(`  [text ${i + 1}/${textQueue.length}] dim=${embedding.length} | ${item.sectionId}`);
    } catch (err) {
      failures++;
      console.error(`  [text ${i + 1}/${textQueue.length}] FAILED: ${err.message} | ${item.sectionId}`);
    }
  }

  for (let i = 0; i < imageQueue.length; i++) {
    const item = imageQueue[i];
    try {
      const out = await callReplicate({ image: item.key });
      const embedding = decodeEmbedding(out[0]);
      await appendEmbedding({
        kind: 'image',
        key: item.key,
        dim: embedding.length,
        embedding,
      });
      console.log(`  [image ${i + 1}/${imageQueue.length}] dim=${embedding.length} | ${item.key.slice(0, 80)}`);
    } catch (err) {
      failures++;
      console.error(`  [image ${i + 1}/${imageQueue.length}] FAILED: ${err.message} | ${item.key.slice(0, 80)}`);
    }
  }

  console.log(`\ndone. failures=${failures}`);
}

await main();
