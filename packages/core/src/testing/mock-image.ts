import type { ImagePlugin } from '@topic2md/shared';

export function createMockImage(): ImagePlugin {
  return {
    name: 'mock-image',
    async capture({ section, sources }) {
      const src = sources[0];
      return {
        url: `https://placehold.co/800x400?text=${encodeURIComponent(section.title)}`,
        alt: section.title,
        sourceUrl: src?.url,
        caption: section.imageHint?.purpose,
        kind: 'inline',
        width: 800,
        height: 400,
      };
    },
  };
}
