import type { Source } from './source.js';
import type { ImageRef } from './image.js';
import type { Article, Frontmatter } from './article.js';
import type { SectionOutline } from './section.js';

export interface BasePlugin {
  readonly name: string;
}

export interface ResearchOptions {
  maxResults?: number;
  signal?: AbortSignal;
}

export interface SourcePlugin extends BasePlugin {
  research(topic: string, opts?: ResearchOptions): Promise<Source[]>;
}

export interface ImageRequest {
  topic: string;
  section: SectionOutline;
  sources: Source[];
}

export interface ImageOptions {
  signal?: AbortSignal;
}

export interface ImagePlugin extends BasePlugin {
  capture(request: ImageRequest, opts?: ImageOptions): Promise<ImageRef | null>;
}

export interface ThemeContext {
  topic: string;
  sources: Source[];
}

export interface ThemePlugin extends BasePlugin {
  decorate(frontmatter: Frontmatter, ctx: ThemeContext): Promise<Frontmatter>;
}

export interface PublishOptions {
  signal?: AbortSignal;
}

export interface PublishResult {
  location: string;
  meta?: Record<string, unknown>;
}

export interface PublishPlugin extends BasePlugin {
  publish(article: Article, opts?: PublishOptions): Promise<PublishResult>;
}

export interface PluginConfig {
  sources: SourcePlugin[];
  images: ImagePlugin[];
  themes: ThemePlugin[];
  publish: PublishPlugin[];
}
