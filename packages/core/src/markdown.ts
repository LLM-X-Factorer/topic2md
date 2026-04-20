import type { Article, Frontmatter, ImageRef, SectionContent, Source } from '@topic2md/shared';

export function toMarkdown(
  frontmatter: Frontmatter,
  sections: SectionContent[],
  citations: Source[],
): string {
  return [
    renderFrontmatter(frontmatter),
    '',
    `# ${frontmatter.title}`,
    '',
    ...sections.map(renderSection),
    renderCitations(citations),
  ]
    .filter((s) => s !== null)
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trimEnd()
    .concat('\n');
}

function renderFrontmatter(fm: Frontmatter): string {
  const entries: [string, unknown][] = Object.entries(fm);
  const body = entries
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}: ${serialize(v)}`)
    .join('\n');
  return `---\n${body}\n---`;
}

function serialize(v: unknown): string {
  if (Array.isArray(v)) {
    return `[${v.map((x) => JSON.stringify(x)).join(', ')}]`;
  }
  if (typeof v === 'string') {
    return needsQuote(v) ? JSON.stringify(v) : v;
  }
  return JSON.stringify(v);
}

function needsQuote(s: string): boolean {
  return /[:#\n"']/.test(s) || s.trim() !== s;
}

function renderSection(section: SectionContent): string {
  const body = section.markdown.trim();
  const images = section.images.map(renderImage).join('\n\n');
  return [`## ${section.title}`, '', body, images].filter(Boolean).join('\n\n');
}

function renderImage(img: ImageRef): string {
  const caption = img.caption ? ` *${img.caption}*` : '';
  const source = img.sourceUrl ? `\n\n> 图片来源：${img.sourceUrl}` : '';
  return `![${img.alt}](${img.url})${caption}${source}`;
}

function renderCitations(citations: Source[]): string {
  if (citations.length === 0) return '';
  const items = citations
    .map((c, i) => `${i + 1}. [${c.title}](${c.url})${c.publishedAt ? ` — ${c.publishedAt}` : ''}`)
    .join('\n');
  return ['## 引用', '', items].join('\n');
}

export function toArticle(
  frontmatter: Frontmatter,
  sections: SectionContent[],
  citations: Source[],
): Article {
  return {
    frontmatter,
    sections,
    citations,
    markdown: toMarkdown(frontmatter, sections, citations),
  };
}
