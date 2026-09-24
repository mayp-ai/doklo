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
  const content = ctx.preview
    ? `> **Draft preview — Not reviewed or approved for publication.**${ctx.locale.startsWith('ko') ? ' 미검토 초안 — 게시 승인되지 않았습니다.' : ''}\n\n${ctx.content}`
    : ctx.content;
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, content);
  return { path, bytes: Buffer.byteLength(content), format: 'markdown' };
};

export { ensureExt };
