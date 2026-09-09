import type { Writer } from './types.js';
import { writePlannedArtifact } from '../atomic-output.js';

function ensureExt(path: string, ext: string): string {
  if (path.toLowerCase().endsWith(ext)) return path;
  // Replace any trailing extension with the desired one
  const dot = path.lastIndexOf('.');
  const slash = path.lastIndexOf('/');
  if (dot > slash) return path.slice(0, dot) + ext;
  return path + ext;
}

export const markdownWriter: Writer = async (ctx) => {
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, ctx.content);
  return { path, bytes: Buffer.byteLength(ctx.content), format: 'markdown' };
};

export { ensureExt };
