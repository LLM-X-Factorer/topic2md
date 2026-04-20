import type { PluginConfig } from '@topic2md/shared';
import { createMockSource } from './mock-source.js';
import { createMockImage } from './mock-image.js';
import { createMockPublish, type MockPublishHandle } from './mock-publish.js';

export { createMockLLM } from './mock-llm.js';
export { createMockSource } from './mock-source.js';
export { createMockImage } from './mock-image.js';
export {
  createMockPublish,
  type MockPublishHandle,
  type MockPublishState,
} from './mock-publish.js';
export { runSmoke } from './smoke.js';

export interface MockPluginBundle {
  config: PluginConfig;
  publish: MockPublishHandle;
}

export function createMockPluginConfig(): MockPluginBundle {
  const publish = createMockPublish();
  return {
    config: {
      sources: [createMockSource()],
      images: [createMockImage()],
      themes: [],
      publish: [publish],
    },
    publish,
  };
}
