import { NextResponse } from 'next/server';
import { runTopic2md } from '@topic2md/core';
import type { WorkflowEvent } from '@topic2md/shared';
import { getPluginConfig } from '@/lib/config';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const maxDuration = 600;

interface RunBody {
  topic?: string;
  model?: string;
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as RunBody;
  const topic = body.topic?.trim();
  if (!topic) {
    return NextResponse.json({ error: 'topic is required' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const write = (payload: unknown) => {
        controller.enqueue(encoder.encode(`${JSON.stringify(payload)}\n`));
      };
      const emit = (event: WorkflowEvent) => write({ kind: 'event', event });

      try {
        const config = await getPluginConfig();
        const result = await runTopic2md(
          { topic, model: body.model },
          { plugins: config, emit, signal: req.signal },
        );
        write({ kind: 'done', location: result.location, markdown: result.markdown });
      } catch (err) {
        write({ kind: 'error', message: err instanceof Error ? err.message : String(err) });
      } finally {
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      'content-type': 'application/x-ndjson; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    },
  });
}
