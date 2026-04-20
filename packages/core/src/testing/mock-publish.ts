import type { Article, PublishPlugin, PublishResult } from '@topic2md/shared';

export interface MockPublishState {
  calls: { article: Article; at: number }[];
  lastMarkdown: string | null;
}

export interface MockPublishHandle extends PublishPlugin {
  state: MockPublishState;
  reset(): void;
}

export function createMockPublish(): MockPublishHandle {
  const state: MockPublishState = { calls: [], lastMarkdown: null };
  return {
    name: 'mock-publish',
    state,
    reset() {
      state.calls = [];
      state.lastMarkdown = null;
    },
    async publish(article: Article): Promise<PublishResult> {
      state.calls.push({ article, at: Date.now() });
      state.lastMarkdown = article.markdown;
      return { location: `memory://mock-publish/${state.calls.length}` };
    },
  };
}
