import yaml from 'js-yaml';
import type { Writer } from './types.js';
import { writePlannedArtifact } from '../atomic-output.js';

export class InvalidJsonOutputError extends Error {
  constructor(public templateName: string, source: 'JSON' | 'YAML', message: string) {
    super(`Template '${templateName}' produced invalid ${source} source for JSON output: ${message}`);
    this.name = 'InvalidJsonOutputError';
  }
}

/**
 * Parses the template output according to its declared source syntax and
 * re-serializes as canonical JSON with 2-space indent.
 */
export const jsonWriter: Writer = async (ctx) => {
  let parsed: unknown;
  const source = ctx.source === 'json' ? 'JSON' : 'YAML';
  try {
    parsed = ctx.source === 'json'
      ? JSON.parse(ctx.content)
      : yaml.load(ctx.content);
  } catch (e) {
    throw new InvalidJsonOutputError(ctx.template.name, source, (e as Error).message);
  }
  const serialized = JSON.stringify(parsed, null, 2);
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, serialized);
  return { path, bytes: Buffer.byteLength(serialized), format: 'json' };
};
