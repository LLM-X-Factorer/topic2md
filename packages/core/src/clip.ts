import { log, type EmitFn } from './logger.js';

// jina-clip-v2 on Replicate. Pin by version hash so cache keys remain valid
// across deploys; bump only when we deliberately change models (and clear
// cached embeddings — the schema keys on model_version).
export const CLIP_MODEL_VERSION =
  '5050c3108bab23981802011a3c76ee327cc0dbfdd31a2f4ef1ee8ef0d3f0b448';
export const CLIP_DEFAULT_THRESHOLD = 0.3;

export async function clipEmbed(
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
    if (Date.now() > deadline)
      throw new Error(`replicate poll timeout (last status=${body.status})`);
    await new Promise((r) => setTimeout(r, 1000));
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

export function cosSim(a: number[], b: number[]): number {
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

export function embeddingToBuffer(emb: number[]): Buffer {
  const f32 = new Float32Array(emb);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}

export function bufferToEmbedding(buf: Buffer): number[] {
  // Copy into a standalone Float32Array — the node Buffer's underlying
  // ArrayBuffer may be larger than byteLength (shared pool), which would
  // otherwise include stale floats when sliced.
  const f32 = new Float32Array(buf.byteLength / 4);
  for (let i = 0; i < f32.length; i++) f32[i] = buf.readFloatLE(i * 4);
  return Array.from(f32);
}

// Fire-and-forget: kick off a trivial text embedding so the Replicate
// container is warm by the time the images step actually needs it. Cuts
// ~60-80s off end-to-end latency on cold-start runs. Safe to await or ignore.
export async function warmClipModel(emit: EmitFn, signal?: AbortSignal): Promise<void> {
  const token = process.env.REPLICATE_API_TOKEN;
  if (!token || process.env.CLIP_GATE === 'disabled') return;
  const started = Date.now();
  try {
    await clipEmbed({ text: '.' }, token, signal);
    log(emit, 'info', `CLIP model warmed in ${Date.now() - started}ms`);
  } catch (err) {
    log(
      emit,
      'warn',
      `CLIP warm-up failed (images step will cold-start): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}
