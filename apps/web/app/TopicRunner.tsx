'use client';

import { useCallback, useRef, useState } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { WorkflowEvent } from '@topic2md/shared';

type StreamEvent =
  | { kind: 'event'; event: WorkflowEvent }
  | { kind: 'done'; location: string; markdown: string }
  | { kind: 'error'; message: string };

export default function TopicRunner({ models }: { models: string[] }) {
  const [topic, setTopic] = useState('');
  const [model, setModel] = useState(models[0]);
  const [events, setEvents] = useState<WorkflowEvent[]>([]);
  const [markdown, setMarkdown] = useState<string | null>(null);
  const [location, setLocation] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  const run = useCallback(async () => {
    if (!topic.trim() || running) return;
    setRunning(true);
    setEvents([]);
    setMarkdown(null);
    setLocation(null);
    setError(null);
    const ctrl = new AbortController();
    abortRef.current = ctrl;
    try {
      const res = await fetch('/api/run', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ topic, model }),
        signal: ctrl.signal,
      });
      if (!res.body) throw new Error('no response body');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          if (!line.trim()) continue;
          const parsed = JSON.parse(line) as StreamEvent;
          if (parsed.kind === 'event') {
            setEvents((prev) => [...prev, parsed.event]);
          } else if (parsed.kind === 'done') {
            setMarkdown(parsed.markdown);
            setLocation(parsed.location);
          } else if (parsed.kind === 'error') {
            setError(parsed.message);
          }
        }
      }
    } catch (err) {
      if ((err as Error).name !== 'AbortError') {
        setError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  }, [topic, model, running]);

  const cancel = useCallback(() => {
    abortRef.current?.abort();
  }, []);

  return (
    <section>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        <input
          value={topic}
          onChange={(e) => setTopic(e.target.value)}
          placeholder="输入一句话话题，例如：DeepSeek V3.2 发布的技术亮点"
          disabled={running}
          style={{
            flex: '1 1 320px',
            padding: '10px 12px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--panel)',
            color: 'var(--fg)',
          }}
        />
        <select
          value={model}
          onChange={(e) => setModel(e.target.value)}
          disabled={running}
          style={{
            padding: '10px 12px',
            border: '1px solid var(--border)',
            borderRadius: 6,
            background: 'var(--panel)',
            color: 'var(--fg)',
          }}
        >
          {models.map((m) => (
            <option key={m} value={m}>
              {m}
            </option>
          ))}
        </select>
        {running ? (
          <button
            onClick={cancel}
            style={{
              padding: '10px 18px',
              border: '1px solid var(--border)',
              borderRadius: 6,
              background: 'var(--panel)',
              color: 'var(--fg)',
            }}
          >
            取消
          </button>
        ) : (
          <button
            onClick={run}
            disabled={!topic.trim()}
            style={{
              padding: '10px 18px',
              border: 'none',
              borderRadius: 6,
              background: 'var(--accent)',
              color: 'var(--accent-fg)',
              opacity: topic.trim() ? 1 : 0.5,
            }}
          >
            开始
          </button>
        )}
      </div>

      {events.length > 0 && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 6,
            maxHeight: 240,
            overflow: 'auto',
            fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
            fontSize: 13,
          }}
        >
          {events.map((ev, i) => (
            <div key={i}>{formatEvent(ev)}</div>
          ))}
        </div>
      )}

      {error && (
        <div
          style={{
            marginTop: 16,
            padding: 12,
            border: '1px solid #ef4444',
            borderRadius: 6,
            color: '#ef4444',
          }}
        >
          {error}
        </div>
      )}

      {markdown && (
        <article
          style={{
            marginTop: 24,
            padding: 20,
            background: 'var(--panel)',
            border: '1px solid var(--border)',
            borderRadius: 8,
          }}
        >
          {location && (
            <p style={{ color: 'var(--muted)', marginTop: 0, fontSize: 13 }}>
              已写入：<code>{location}</code>
            </p>
          )}
          <ReactMarkdown remarkPlugins={[remarkGfm]}>{markdown}</ReactMarkdown>
        </article>
      )}
    </section>
  );
}

function formatEvent(ev: WorkflowEvent): string {
  switch (ev.type) {
    case 'step.start':
      return `→ ${ev.step}`;
    case 'step.end':
      return `✓ ${ev.step} (${ev.durationMs}ms)`;
    case 'step.error':
      return `✗ ${ev.step}: ${ev.error}`;
    case 'log':
      return `[${ev.level}] ${ev.message}`;
    case 'progress':
      return `· ${ev.step}: ${ev.message}`;
  }
}
