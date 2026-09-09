import type { Writer } from './types.js';
import { writePlannedArtifact } from '../atomic-output.js';

/**
 * Verbatim writer for non-markdown text artifacts (.feature, .env.example,
 * Makefile, …). Unlike markdownWriter it never rewrites the extension —
 * the template's output_path is the artifact's real filename.
 */
export const textWriter: Writer = async (ctx) => {
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, ctx.content);
  return { path, bytes: Buffer.byteLength(ctx.content), format: 'text' };
};
