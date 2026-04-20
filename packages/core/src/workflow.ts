import { createWorkflow } from '@mastra/core';
import { researchStep } from './steps/research.js';
import { outlineStep } from './steps/outline.js';
import { sectionsStep } from './steps/sections.js';
import { imagesStep } from './steps/images.js';
import { assembleStep } from './steps/assemble.js';
import { publishStep } from './steps/publish.js';
import { PublishOutputSchema, WorkflowInputSchema } from './steps/schemas.js';

export function createTopic2mdWorkflow() {
  return createWorkflow({
    id: 'topic2md',
    description: 'Topic → researched markdown article with images and citations.',
    inputSchema: WorkflowInputSchema,
    outputSchema: PublishOutputSchema,
  })
    .then(researchStep)
    .then(outlineStep)
    .then(sectionsStep)
    .then(imagesStep)
    .then(assembleStep)
    .then(publishStep)
    .commit();
}

export type Topic2mdWorkflow = ReturnType<typeof createTopic2mdWorkflow>;
