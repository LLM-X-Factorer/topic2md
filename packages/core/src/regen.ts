import type {
  Article,
  Frontmatter,
  ImagePlugin,
  PluginConfig,
  Source,
  SectionContent,
} from '@topic2md/shared';
import type {
  AssembleOutput,
  ImagesOutput,
  OutlineOutput,
  ResearchOutput,
  SectionsOutput,
} from './steps/schemas.js';
import { createLLM, type LLM } from './llm.js';
import { noopEmit, type EmitFn } from './logger.js';
import { toArticle } from './markdown.js';
import {
  completeRun,
  createRun,
  getRun,
  openDatabase,
  saveStage,
  type DatabaseType,
} from './persistence.js';
import { assertPluginConfig, imagePlugins, primaryPublish, themePlugins } from './registry.js';
import { assignSources, reorderWithAssigned, resolveImages } from './steps/images.js';
import { writeSection } from './steps/sections.js';

export interface RegenSectionInput {
  runId: string;
  sectionIndex: number;
}

export interface RegenSectionOptions {
  plugins: PluginConfig;
  llm?: LLM;
  emit?: EmitFn;
  signal?: AbortSignal;
  model?: string;
  record?: boolean | DatabaseType;
  databaseUrl?: string;
}

export interface RegenSectionResult {
  runId: string | null;
  sourceRunId: string;
  sectionIndex: number;
  location: string;
  markdown: string;
  article: Article;
}

export async function regenSection(
  input: RegenSectionInput,
  options: RegenSectionOptions,
): Promise<RegenSectionResult> {
  assertPluginConfig(options.plugins);

  const emit = options.emit ?? noopEmit;
  const llm = options.llm ?? createLLM({ defaultModel: options.model });

  const { db, ownedDb } = openRecordDb(options);
  try {
    const source = db ? getRun(db, input.runId) : null;
    if (!source) {
      throw new Error(`regenSection: no stored run with id ${input.runId}`);
    }
    if (source.run.status !== 'success') {
      throw new Error(
        `regenSection: source run ${input.runId} status is "${source.run.status}" — only successful runs can be regenerated`,
      );
    }

    const model = options.model ?? source.run.model ?? llm.defaultModel;
    const { research, outline, sections, images, assemble } = requireStages(source.stages);

    if (input.sectionIndex < 0 || input.sectionIndex >= outline.outline.sections.length) {
      throw new Error(
        `regenSection: sectionIndex ${input.sectionIndex} is out of range (0..${outline.outline.sections.length - 1})`,
      );
    }

    const newRunId = db
      ? createRun(db, {
          topic: source.run.topic,
          model,
          sourceRunId: source.run.id,
          sourceStage: 'sections',
        })
      : null;

    if (db && newRunId) {
      saveStage(db, newRunId, 'research', research);
      saveStage(db, newRunId, 'outline', outline);
    }

    const targetOutline = outline.outline.sections[input.sectionIndex];
    if (!targetOutline) {
      throw new Error(`regenSection: outline has no section at index ${input.sectionIndex}`);
    }
    const rewritten = await writeSection(
      targetOutline,
      research.sources,
      llm,
      model,
      emit,
      options.signal,
    );

    const nextSections: SectionContent[] = sections.sections.map((s, i) =>
      i === input.sectionIndex ? rewritten : s,
    );
    const sectionsOutput: SectionsOutput = {
      topic: sections.topic,
      sources: sections.sources,
      title: sections.title,
      digest: sections.digest,
      sections: nextSections,
    };
    if (db && newRunId) saveStage(db, newRunId, 'sections', sectionsOutput);

    const imagesOutput = await rerunImages(
      sectionsOutput,
      images,
      options.plugins,
      emit,
      options.signal,
    );
    if (db && newRunId) saveStage(db, newRunId, 'images', imagesOutput);

    const article = await assembleArticle(
      assemble.article.frontmatter,
      imagesOutput,
      options.plugins,
      model,
    );
    const assembleOutput: AssembleOutput = { topic: imagesOutput.topic, article };
    if (db && newRunId) saveStage(db, newRunId, 'assemble', assembleOutput);

    const publishResult = await primaryPublish(options.plugins).publish(article, {
      signal: options.signal,
    });
    if (db && newRunId) {
      saveStage(db, newRunId, 'publish', {
        location: publishResult.location,
        markdown: article.markdown,
      });
      completeRun(db, newRunId, { status: 'success', location: publishResult.location });
    }

    return {
      runId: newRunId,
      sourceRunId: source.run.id,
      sectionIndex: input.sectionIndex,
      location: publishResult.location,
      markdown: article.markdown,
      article,
    };
  } finally {
    if (ownedDb && db) db.close();
  }
}

interface RequiredStages {
  research: ResearchOutput;
  outline: OutlineOutput;
  sections: SectionsOutput;
  images: ImagesOutput;
  assemble: AssembleOutput;
}

function requireStages(stages: Partial<Record<string, unknown>>): RequiredStages {
  const names = ['research', 'outline', 'sections', 'images', 'assemble'] as const;
  const missing = names.filter((n) => !stages[n]);
  if (missing.length > 0) {
    throw new Error(`regenSection: source run is missing stages: ${missing.join(', ')}`);
  }
  return {
    research: stages.research as ResearchOutput,
    outline: stages.outline as OutlineOutput,
    sections: stages.sections as SectionsOutput,
    images: stages.images as ImagesOutput,
    assemble: stages.assemble as AssembleOutput,
  };
}

function openRecordDb(options: RegenSectionOptions): {
  db: DatabaseType | null;
  ownedDb: boolean;
} {
  const record = options.record ?? true;
  if (record === false) return { db: null, ownedDb: false };
  if (typeof record === 'object' && record !== null) return { db: record, ownedDb: false };
  try {
    return { db: openDatabase(options.databaseUrl), ownedDb: true };
  } catch {
    return { db: null, ownedDb: false };
  }
}

async function rerunImages(
  sections: SectionsOutput,
  previous: ImagesOutput,
  plugins: PluginConfig,
  emit: EmitFn,
  signal: AbortSignal | undefined,
): Promise<ImagesOutput> {
  const plugs = imagePlugins(plugins);
  if (plugs.length === 0) {
    return preserveImagesFromPrevious(sections, previous);
  }

  const assignments = assignSources(sections.sections, sections.sources);
  const next = await Promise.all(
    sections.sections.map((section, i) =>
      resolveImages(
        section,
        reorderWithAssigned(sections.sources, assignments[i] ?? null),
        sections.topic,
        plugs as ImagePlugin[],
        emit,
        signal,
      ),
    ),
  );
  return { ...sections, sections: next };
}

function preserveImagesFromPrevious(
  sections: SectionsOutput,
  previous: ImagesOutput,
): ImagesOutput {
  const byId = new Map(previous.sections.map((s) => [s.id, s.images] as const));
  return {
    ...sections,
    sections: sections.sections.map((s) => ({ ...s, images: byId.get(s.id) ?? s.images })),
  };
}

async function assembleArticle(
  sourceFrontmatter: Frontmatter,
  images: ImagesOutput,
  plugins: PluginConfig,
  model: string,
): Promise<Article> {
  let frontmatter: Frontmatter = {
    ...sourceFrontmatter,
    date: new Date().toISOString().slice(0, 10),
    model,
    title: images.title,
    digest: images.digest,
  };
  for (const theme of themePlugins(plugins)) {
    frontmatter = await theme.decorate(frontmatter, {
      topic: images.topic,
      sources: images.sources as Source[],
    });
  }
  return toArticle(frontmatter, images.sections, images.sources as Source[]);
}
