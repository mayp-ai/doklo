import { readFile, stat, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, parse as parsePath, relative, resolve, sep } from 'node:path';
import matter from 'gray-matter';
import {
  parseTemplateManifest,
  type OutputFormat,
  type TemplateManifest,
  type TemplateOutputRecipe,
} from './template-manifest.js';
import { assertSafeTemplateSegment, resolveTemplatePath } from './path-security.js';

export interface ParsedTemplateOutput {
  body: string;
  recipe: TemplateOutputRecipe;
}

export interface ParsedTemplate {
  manifest: TemplateManifest;
  outputs: Map<OutputFormat, ParsedTemplateOutput>;
  /** Deprecated compatibility body for the default recipe. */
  body: string;
  partials: Map<string, string>;
  assetsDir?: string;
  sourcePath: string;
  /** Whether parsed from a single-file frontmatter template (true) or a directory (false). */
  singleFile: boolean;
}

export interface ParseTemplateOptions {
  /** Existing root whose descendants the caller intends to make readable. */
  containmentRoot?: string;
}

export class TemplateParseError extends Error {
  constructor(public path: string, message: string) {
    super(`${message} (at ${path})`);
    this.name = 'TemplateParseError';
  }
}

/**
 * Parse a template from disk. Two layouts supported (spec §4.1, §4.4):
 *
 * - **Directory**: `<path>/doklo-template.json` + `<entry>` body file (+ optional
 *   partials/ + optional assets/). The directory name must equal manifest.name.
 *
 * - **Single file**: `<path>.tpl` (any extension) with YAML frontmatter
 *   containing the manifest, body is the remainder.
 */
export async function parseTemplate(
  path: string,
  options: ParseTemplateOptions = {},
): Promise<ParsedTemplate> {
  const abs = await resolveTemplateInput(path, options, 'template path');
  let stats;
  try {
    stats = await stat(abs);
  } catch (error) {
    if (isMissingPathError(error)) {
      throw new TemplateParseError(abs, 'Template path does not exist');
    }
    throw error;
  }
  if (stats.isDirectory()) {
    return parseDirectoryTemplate(abs);
  }
  return parseSingleFileTemplate(abs);
}

async function resolveTemplateInput(
  path: string,
  options: ParseTemplateOptions,
  label: string,
): Promise<string> {
  const declaredRoot = options.containmentRoot === undefined
    ? undefined
    : resolve(options.containmentRoot);
  const lexicalPath = declaredRoot === undefined
    ? resolve(path)
    : resolve(declaredRoot, path);
  const containmentRoot = declaredRoot ?? defaultContainmentRoot(lexicalPath);
  return resolveTemplatePath(
    containmentRoot,
    relative(containmentRoot, lexicalPath),
    label,
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
}

function defaultContainmentRoot(lexicalPath: string): string {
  // This only selects a runtime-owned declared root. Core remains responsible
  // for every lexical/physical containment and symlink decision below it.
  const knownRoots = [resolve(process.cwd()), resolve(tmpdir())]
    .sort((a, b) => b.length - a.length);
  return knownRoots.find((root) => isLexicallyBelow(root, lexicalPath))
    ?? parsePath(lexicalPath).root;
}

function isLexicallyBelow(root: string, target: string): boolean {
  const fromRoot = relative(root, target);
  return fromRoot === '' || (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot)
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function parseDirectoryTemplate(dir: string): Promise<ParsedTemplate> {
  const manifestPath = await resolveTemplatePath(
    dir,
    'doklo-template.json',
    'template manifest',
    { allowMissingLeaf: true },
  );
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(manifestPath, 'utf-8'));
  } catch (err) {
    throw new TemplateParseError(
      manifestPath,
      `Could not read doklo-template.json: ${(err as Error).message}`,
    );
  }
  const manifest = parseTemplateManifest(raw);
  assertSafeTemplateSegment(manifest.name, 'template name');
  if (manifest.name !== basename(dir)) {
    throw new TemplateParseError(
      dir,
      `Directory name '${basename(dir)}' does not match manifest.name '${manifest.name}'`,
    );
  }
  const outputs = await parseDirectoryOutputs(dir, manifest);
  const partials = new Map<string, string>();
  if (manifest.partials) {
    for (const [name, relPath] of Object.entries(manifest.partials)) {
      const pPath = await resolveTemplatePath(
        dir,
        relPath,
        `template partial '${name}'`,
        { allowMissingLeaf: true },
      );
      try {
        partials.set(name, await readFile(pPath, 'utf-8'));
      } catch (err) {
        throw new TemplateParseError(
          pPath,
          `Could not read partial '${name}': ${(err as Error).message}`,
        );
      }
    }
  }
  const resolvedAssetsDir = await resolveTemplatePath(
    dir,
    'assets',
    'template assets',
    { allowMissingLeaf: true },
  );
  const assetsDir = await dirExists(resolvedAssetsDir)
    ? resolvedAssetsDir
    : undefined;
  return {
    manifest,
    outputs,
    body: defaultOutputBody(manifest, outputs, dir),
    partials,
    assetsDir,
    sourcePath: dir,
    singleFile: false,
  };
}

async function parseSingleFileTemplate(filePath: string): Promise<ParsedTemplate> {
  let raw: string;
  try {
    raw = await readFile(filePath, 'utf-8');
  } catch (err) {
    throw new TemplateParseError(
      filePath,
      `Could not read template file: ${(err as Error).message}`,
    );
  }
  const parsed = matter(raw);
  if (!parsed.data || Object.keys(parsed.data).length === 0) {
    throw new TemplateParseError(
      filePath,
      'Single-file template has no YAML frontmatter — wrap manifest in --- ... --- at top',
    );
  }
  rejectSingleFileEntries(parsed.data, filePath);
  const manifest = parseTemplateManifest(parsed.data);
  const outputs = new Map<OutputFormat, ParsedTemplateOutput>();
  for (const format of manifest.output_formats) {
    const recipe = manifest.outputs[format]!;
    outputs.set(format, {
      recipe,
      body: recipe.source === 'binary' ? '' : parsed.content,
    });
  }
  return {
    manifest,
    outputs,
    body: defaultOutputBody(manifest, outputs, filePath),
    partials: new Map(),
    sourcePath: filePath,
    singleFile: true,
  };
}

async function parseDirectoryOutputs(
  dir: string,
  manifest: TemplateManifest,
): Promise<Map<OutputFormat, ParsedTemplateOutput>> {
  const outputs = new Map<OutputFormat, ParsedTemplateOutput>();
  const bodyByPath = new Map<string, string>();

  for (const format of manifest.output_formats) {
    const recipe = manifest.outputs[format]!;
    if (recipe.source === 'binary') {
      if (recipe.entry !== undefined) {
        await resolveTemplatePath(
          dir,
          recipe.entry,
          'template entry',
          { allowMissingLeaf: true },
        );
      }
      outputs.set(format, { recipe, body: '' });
      continue;
    }
    if (recipe.entry === undefined) {
      throw new TemplateParseError(
        dir,
        `Output '${format}' requires a template entry file`,
      );
    }
    const entryPath = await resolveTemplatePath(
      dir,
      recipe.entry,
      'template entry',
      { allowMissingLeaf: true },
    );
    let body = bodyByPath.get(entryPath);
    if (body === undefined) {
      try {
        body = await readFile(entryPath, 'utf-8');
      } catch (err) {
        throw new TemplateParseError(
          entryPath,
          `Could not read entry file: ${(err as Error).message}`,
        );
      }
      bodyByPath.set(entryPath, body);
    }
    outputs.set(format, { recipe, body });
  }

  return outputs;
}

function defaultOutputBody(
  manifest: TemplateManifest,
  outputs: Map<OutputFormat, ParsedTemplateOutput>,
  sourcePath: string,
): string {
  const output = outputs.get(manifest.default_format);
  if (output === undefined) {
    throw new TemplateParseError(sourcePath, `Missing default output '${manifest.default_format}'`);
  }
  return output.body;
}

function rejectSingleFileEntries(raw: unknown, filePath: string): void {
  if (!isRecord(raw)) return;
  if (Object.hasOwn(raw, 'entry')) {
    throw new TemplateParseError(filePath, 'Single-file templates cannot declare an entry file');
  }
  if (!isRecord(raw.outputs)) return;
  for (const [format, recipe] of Object.entries(raw.outputs)) {
    if (isRecord(recipe) && Object.hasOwn(recipe, 'entry')) {
      throw new TemplateParseError(
        filePath,
        `Single-file output '${format}' cannot declare an entry file`,
      );
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

/**
 * Walk a directory and return every immediate subdir that contains a
 * `doklo-template.json`. Used by `template add` to install bundles + by
 * `template list` to enumerate built-in / user / workspace templates.
 */
export async function listTemplateDirs(
  parent: string,
  options: ParseTemplateOptions = {},
): Promise<string[]> {
  const out: string[] = [];
  const resolvedParent = await resolveTemplateInput(parent, options, 'template directory root');
  let entries;
  try {
    entries = await readdir(resolvedParent, { withFileTypes: true });
  } catch (error) {
    if (isMissingPathError(error)) return out;
    throw error;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const child = await resolveTemplatePath(resolvedParent, e.name, 'template directory');
    const manifestPath = await resolveTemplatePath(
      child,
      'doklo-template.json',
      'template manifest',
      { allowMissingLeaf: true },
    );
    if (await fileExists(manifestPath)) {
      out.push(child);
    }
  }
  return out;
}

async function fileExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}
