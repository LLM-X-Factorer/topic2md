import type {
  PluginConfig,
  SourcePlugin,
  ImagePlugin,
  ThemePlugin,
  PublishPlugin,
} from '@topic2md/shared';

export class PluginConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PluginConfigError';
  }
}

export function assertPluginConfig(cfg: PluginConfig): void {
  if (cfg.sources.length === 0) {
    throw new PluginConfigError(
      'PluginConfig.sources is empty — enable at least one research source plugin (e.g. @topic2md/source-tavily).',
    );
  }
  if (cfg.publish.length === 0) {
    throw new PluginConfigError(
      'PluginConfig.publish is empty — enable at least one publish target (e.g. @topic2md/publish-file).',
    );
  }
}

export function primarySource(cfg: PluginConfig): SourcePlugin {
  const src = cfg.sources[0];
  if (!src) throw new PluginConfigError('PluginConfig.sources is empty.');
  return src;
}

export function primaryPublish(cfg: PluginConfig): PublishPlugin {
  const pub = cfg.publish[0];
  if (!pub) throw new PluginConfigError('PluginConfig.publish is empty.');
  return pub;
}

export function imagePlugins(cfg: PluginConfig): ImagePlugin[] {
  return cfg.images;
}

export function themePlugins(cfg: PluginConfig): ThemePlugin[] {
  return cfg.themes;
}

export function emptyPluginConfig(): PluginConfig {
  return { sources: [], images: [], themes: [], publish: [] };
}
