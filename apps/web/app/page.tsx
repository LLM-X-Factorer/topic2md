import TopicRunner from './TopicRunner';

const MODEL_OPTIONS = [
  'openrouter/anthropic/claude-sonnet-4-6',
  'openrouter/anthropic/claude-opus-4-7',
  'openrouter/openai/gpt-5',
  'openrouter/google/gemini-2.5-pro',
  'openrouter/deepseek/deepseek-chat',
];

export default function Page() {
  return (
    <main
      style={{
        maxWidth: 880,
        margin: '0 auto',
        padding: '32px 24px',
      }}
    >
      <header style={{ marginBottom: 24 }}>
        <h1 style={{ margin: 0, fontSize: 28 }}>topic2md</h1>
        <p style={{ color: 'var(--muted)', margin: '8px 0 0' }}>
          自然语言话题 → 结构化中文 markdown 文章。
        </p>
      </header>
      <TopicRunner models={MODEL_OPTIONS} />
    </main>
  );
}
