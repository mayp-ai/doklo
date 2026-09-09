import yaml from 'js-yaml';
import type { Writer } from './types.js';
import { writePlannedArtifact } from '../atomic-output.js';

export class InvalidYamlOutputError extends Error {
  constructor(public templateName: string, source: 'JSON' | 'YAML', message: string) {
    super(`Template '${templateName}' produced invalid ${source} source for YAML output: ${message}`);
    this.name = 'InvalidYamlOutputError';
  }
}

/**
 * Parses the template output according to its declared source syntax and
 * re-serializes it as YAML.
 * The round-trip validates structural correctness at write time
 * (spec §5.6.e).
 */
export const yamlWriter: Writer = async (ctx) => {
  let parsed: unknown;
  const source = ctx.source === 'json' ? 'JSON' : 'YAML';
  try {
    parsed = ctx.source === 'json'
      ? JSON.parse(ctx.content)
      : yaml.load(ctx.content);
  } catch (e) {
    throw new InvalidYamlOutputError(ctx.template.name, source, (e as Error).message);
  }
  const serialized = yaml.dump(parsed, { lineWidth: 100, noRefs: true });
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, serialized);
  return { path, bytes: Buffer.byteLength(serialized), format: 'yaml' };
};
