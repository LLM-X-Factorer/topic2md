import { runTopic2md } from '../runner.js';
import { createMockLLM, createMockPluginConfig } from './index.js';

export async function runSmoke(topic = 'DeepSeek V3.2 发布'): Promise<{
  location: string;
  markdown: string;
  length: number;
}> {
  const { config, publish } = createMockPluginConfig();
  const result = await runTopic2md(
    { topic },
    {
      plugins: config,
      llm: createMockLLM(),
      emit: (event) => {
        if (event.type === 'step.start' || event.type === 'step.end') {
          // eslint-disable-next-line no-console
          console.log(`[smoke] ${event.type} ${event.step}`);
        }
      },
    },
  );
  if (publish.state.calls.length !== 1) {
    throw new Error(`expected 1 publish call, got ${publish.state.calls.length}`);
  }
  return { ...result, length: result.markdown.length };
}
