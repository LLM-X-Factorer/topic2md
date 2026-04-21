#!/usr/bin/env node
// Analyze: does cos(section_query, candidate_image) separate relevant from
// irrelevant labels? Outputs score distribution + ROC + suggested threshold.
//
// Reads:  out/debug/candidates.jsonl
//         out/debug/labels.jsonl
//         out/debug/embeddings.jsonl
// Writes: out/debug/scored.jsonl  (per-candidate with score + label)

import { readFile, writeFile, stat } from 'node:fs/promises';
import { URL } from 'node:url';

const ROOT = new URL('..', import.meta.url).pathname;
const CANDIDATES = `${ROOT}out/debug/candidates.jsonl`;
const LABELS = `${ROOT}out/debug/labels.jsonl`;
const EMBEDDINGS = `${ROOT}out/debug/embeddings.jsonl`;
const SCORED = `${ROOT}out/debug/scored.jsonl`;

async function loadJsonl(path) {
  try { await stat(path); } catch { return []; }
  const raw = await readFile(path, 'utf8');
  return raw.trim().split('\n').filter(Boolean).map((l) => JSON.parse(l));
}

function cos(a, b) {
  let dot = 0, na = 0, nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function percentile(sorted, p) {
  const idx = Math.max(0, Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p)));
  return sorted[idx];
}

function rocAuc(points) {
  // points: [{score, label}] where label === 1 (relevant) or 0 (irrelevant)
  const pos = points.filter((p) => p.label === 1);
  const neg = points.filter((p) => p.label === 0);
  if (pos.length === 0 || neg.length === 0) return null;
  let wins = 0, ties = 0;
  for (const p of pos) for (const n of neg) {
    if (p.score > n.score) wins++;
    else if (p.score === n.score) ties++;
  }
  return (wins + ties / 2) / (pos.length * neg.length);
}

function prAtThreshold(points, th) {
  const above = points.filter((p) => p.score >= th);
  if (above.length === 0) return { precision: null, recall: 0, kept: 0 };
  const tp = above.filter((p) => p.label === 1).length;
  const pos = points.filter((p) => p.label === 1).length;
  return {
    precision: tp / above.length,
    recall: pos === 0 ? null : tp / pos,
    kept: above.length,
  };
}

async function main() {
  const cands = await loadJsonl(CANDIDATES);
  const labels = await loadJsonl(LABELS);
  const embs = await loadJsonl(EMBEDDINGS);

  const textEmb = new Map();
  const imgEmb = new Map();
  for (const e of embs) {
    if (e.kind === 'text') textEmb.set(e.key, e.embedding);
    if (e.kind === 'image') imgEmb.set(e.key, e.embedding);
  }

  const labelMap = new Map();
  for (const l of labels) labelMap.set(`${l.sectionId}::${l.url}`, l.label);

  const rows = [];
  for (const rec of cands) {
    const textKey = `${rec.topic}::${rec.sectionId}`;
    const qEmb = textEmb.get(textKey);
    if (!qEmb) continue;
    for (const c of rec.candidates) {
      const iEmb = imgEmb.get(c.url);
      if (!iEmb) continue;
      const score = cos(qEmb, iEmb);
      const label = labelMap.get(`${rec.sectionId}::${c.url}`) ?? 'unknown';
      rows.push({
        topic: rec.topic,
        sectionId: rec.sectionId,
        sectionTitle: rec.sectionTitle,
        url: c.url,
        alt: c.alt,
        score,
        label,
      });
    }
  }

  await writeFile(SCORED, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  console.log(`wrote ${rows.length} rows to scored.jsonl`);

  // Filter to labeled (drop skip + unknown) for ROC
  const usable = rows.filter((r) => r.label === 'relevant' || r.label === 'irrelevant');
  const points = usable.map((r) => ({ score: r.score, label: r.label === 'relevant' ? 1 : 0 }));
  const auc = rocAuc(points);

  const pos = points.filter((p) => p.label === 1).map((p) => p.score).sort((a, b) => a - b);
  const neg = points.filter((p) => p.label === 0).map((p) => p.score).sort((a, b) => a - b);

  console.log('\n=== Score distribution ===');
  console.log(`relevant (n=${pos.length}): min=${pos[0]?.toFixed(3)} p25=${percentile(pos,0.25)?.toFixed(3)} median=${percentile(pos,0.5)?.toFixed(3)} p75=${percentile(pos,0.75)?.toFixed(3)} max=${pos[pos.length-1]?.toFixed(3)}`);
  console.log(`irrelevant (n=${neg.length}): min=${neg[0]?.toFixed(3)} p25=${percentile(neg,0.25)?.toFixed(3)} median=${percentile(neg,0.5)?.toFixed(3)} p75=${percentile(neg,0.75)?.toFixed(3)} max=${neg[neg.length-1]?.toFixed(3)}`);
  console.log(`\nROC AUC: ${auc?.toFixed(4)}`);

  console.log('\n=== Precision/Recall at candidate thresholds ===');
  const allScores = [...new Set(points.map((p) => p.score))].sort((a, b) => a - b);
  const header = 'threshold    precision    recall    kept';
  console.log(header);
  console.log('-'.repeat(header.length));
  for (const s of [0.10, 0.15, 0.20, 0.25, 0.30]) {
    const pr = prAtThreshold(points, s);
    console.log(`${s.toFixed(3).padEnd(12)} ${(pr.precision ?? 0).toFixed(3).padEnd(12)} ${(pr.recall ?? 0).toFixed(3).padEnd(9)} ${pr.kept}/${points.length}`);
  }
  // Find threshold at precision >= 0.9
  let best = null;
  for (const s of allScores) {
    const pr = prAtThreshold(points, s);
    if (pr.precision != null && pr.precision >= 0.9) { best = { th: s, ...pr }; break; }
  }
  if (best) {
    console.log(`\n>>> first threshold with precision >= 0.9: ${best.th.toFixed(3)} (recall=${best.recall.toFixed(3)}, keeps ${best.kept}/${points.length})`);
  } else {
    console.log('\n>>> no threshold reaches precision >= 0.9 — embedding signal alone is insufficient');
  }

  // Also show histogram in the 0-0.4 range
  console.log('\n=== Histogram (relevant=R, irrelevant=X) ===');
  const buckets = new Array(20).fill(0).map(() => ({ r: 0, x: 0 }));
  for (const p of points) {
    const b = Math.min(19, Math.max(0, Math.floor(p.score * 40))); // 0..0.5 mapped to 0..19
    if (p.label === 1) buckets[b].r++;
    else buckets[b].x++;
  }
  for (let i = 0; i < 20; i++) {
    const lo = (i / 40).toFixed(3);
    const { r, x } = buckets[i];
    if (r === 0 && x === 0) continue;
    console.log(`${lo}: ${'R'.repeat(r)}${'X'.repeat(x)}  (R=${r} X=${x})`);
  }
}

await main();
