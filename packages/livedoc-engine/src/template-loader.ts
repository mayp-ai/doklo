import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { basename, dirname, join, resolve } from 'node:path';
import { stat } from 'node:fs/promises';
import {
  listTemplateDirs,
  parseTemplate,
  type ParsedTemplate,
  TemplateParseError,
} from './template-parser.js';
import { assertSafeTemplateSegment, resolveTemplatePath } from './path-security.js';
import type {
  TemplateManifest,
  TemplateStability,
  TemplateVariableDefinition,
} from './template-manifest.js';

export type TemplateSource = 'workspace' | 'user' | 'builtin';

export interface ResolveOptions {
  workspaceRoot: string;
  userHome?: string;
  builtinRoot?: string;
  preferredSource?: TemplateSource;
  /** Include experimental templates in enumeration. Resolution by explicit name is unchanged. */
  includeExperimental?: boolean;
}

export interface ResolvedTemplate {
  source: TemplateSource;
  path: string;
  parsed: ParsedTemplate;
}

export class TemplateNotFoundError extends Error {
  constructor(public templateName: string, public sourcesSearched: Array<{ source: TemplateSource; path: string }>) {
    const list = sourcesSearched.map((s) => `  - ${s.source}: ${s.path}`).join('\n');
    super(`Template '${templateName}' not found. Searched:\n${list}`);
    this.name = 'TemplateNotFoundError';
  }
}

/**
 * Default built-in root resolves relative to this module file at runtime.
 * Works for both source (src/template-loader.ts) and compiled (dist/template-loader.js)
 * by walking up to the package root, then into `templates/`.
 */
function defaultBuiltinRoot(): string {
  // import.meta.url → .../packages/livedoc-engine/{src,dist}/template-loader.js
  const thisFile = fileURLToPath(import.meta.url);
  // up 2 = packages/livedoc-engine
  const packageRoot = resolve(dirname(thisFile), '..');
  return join(packageRoot, 'templates');
}

interface TemplateRegistryDefinition {
  source: TemplateSource;
  declaredRoot: string;
  relativePath: string;
}

interface ResolvedTemplateRegistry {
  source: TemplateSource;
  root: string;
  exists: boolean;
}

function registryDefinitions(opts: ResolveOptions): TemplateRegistryDefinition[] {
  const builtinRoot = resolve(opts.builtinRoot ?? defaultBuiltinRoot());
  return [
    { source: 'workspace', declaredRoot: opts.workspaceRoot, relativePath: '.doklo/templates' },
    { source: 'user', declaredRoot: opts.userHome ?? homedir(), relativePath: '.doklo/templates' },
    {
      source: 'builtin',
      declaredRoot: dirname(builtinRoot),
      relativePath: basename(builtinRoot) || '.',
    },
  ];
}

function selectedRegistryDefinitions(opts: ResolveOptions): TemplateRegistryDefinition[] {
  const definitions = registryDefinitions(opts);
  return opts.preferredSource
    ? definitions.filter((registry) => registry.source === opts.preferredSource)
    : definitions;
}

async function resolveRegistry(
  definition: TemplateRegistryDefinition,
): Promise<ResolvedTemplateRegistry> {
  const label = `${definition.source} template registry`;
  let root: string;
  try {
    root = await resolveTemplatePath(
      definition.declaredRoot,
      definition.relativePath,
      label,
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
  } catch (error) {
    if (!hasMissingPathCause(error)) throw error;
    return {
      source: definition.source,
      root: resolve(definition.declaredRoot, definition.relativePath),
      exists: false,
    };
  }
  return { source: definition.source, root, exists: await dirExists(root) };
}

/**
 * Resolve a template by name across the 3-source precedence
 * (workspace > user > built-in). preferredSource pins a tier.
 */
export async function resolveTemplate(
  name: string,
  opts: ResolveOptions,
): Promise<ResolvedTemplate> {
  const templateName = assertSafeTemplateSegment(name, 'template name');
  const definitions = selectedRegistryDefinitions(opts);
  const tried: Array<{ source: TemplateSource; path: string }> = [];

  for (const definition of definitions) {
    const registry = await resolveRegistry(definition);
    const candidate = registry.exists
      ? await resolveTemplatePath(
          registry.root,
          templateName,
          'template name',
          { allowMissingLeaf: true },
        )
      : resolve(registry.root, templateName);
    tried.push({ source: registry.source, path: candidate });
    if (registry.exists && await dirExists(candidate)) {
      const parsed = await parseTemplate(candidate, { containmentRoot: registry.root });
      return { source: registry.source, path: candidate, parsed };
    }
  }

  throw new TemplateNotFoundError(name, tried);
}

export interface ListEntry {
  name: string;
  version: string;
  source: TemplateSource;
  path: string;
  stability: TemplateStability;
  audience: TemplateManifest['audience'];
  purpose: TemplateManifest['purpose'];
  job: TemplateManifest['job'];
  requiredInput: TemplateManifest['required_input'];
  variables: Record<string, TemplateVariableDefinition>;
  outputFormats: TemplateManifest['output_formats'];
  /** True when this entry is the one resolveTemplate() would pick (precedence winner). */
  active: boolean;
}

/**
 * Enumerate every template across all 3 sources. The first occurrence
 * (in workspace > user > builtin order) of a given name is marked active.
 */
export async function listTemplates(opts: ResolveOptions): Promise<ListEntry[]> {
  const out: ListEntry[] = [];
  const seenActive = new Set<string>();
  for (const definition of selectedRegistryDefinitions(opts)) {
    const registry = await resolveRegistry(definition);
    if (!registry.exists) continue;
    const dirs = await listTemplateDirs(registry.root, { containmentRoot: registry.root });
    for (const d of dirs) {
      try {
        const parsed = await parseTemplate(d, { containmentRoot: registry.root });
        const name = parsed.manifest.name;
        const isActive = !seenActive.has(name);
        if (isActive) seenActive.add(name);
        if (!opts.includeExperimental && parsed.manifest.stability !== 'stable') continue;
        out.push({
          name,
          version: parsed.manifest.version,
          source: registry.source,
          path: d,
          stability: parsed.manifest.stability,
          audience: parsed.manifest.audience,
          purpose: parsed.manifest.purpose,
          job: parsed.manifest.job,
          requiredInput: parsed.manifest.required_input,
          variables: parsed.manifest.variables,
          outputFormats: parsed.manifest.output_formats,
          active: isActive,
        });
      } catch (err) {
        if (err instanceof TemplateParseError) {
          // skip broken templates; surface as a warning to caller via stderr
          // eslint-disable-next-line no-console
          console.warn(`[livedoc-engine] skipping malformed template at ${d}: ${err.message}`);
        } else {
          throw err;
        }
      }
    }
  }
  return out;
}

function hasMissingPathCause(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  if ('code' in error) {
    const code = (error as { code?: unknown }).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return true;
  }
  return 'cause' in error && hasMissingPathCause((error as { cause?: unknown }).cause);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch (error) {
    if (hasMissingPathCause(error)) return false;
    throw error;
  }
}
