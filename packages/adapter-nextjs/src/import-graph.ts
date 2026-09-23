import { sourceFileSystem } from './source-filesystem.js';
// Internal-import graph builder.
//
// For a set of entry files (typically Next.js page.tsx files) walks
// each file's import declarations recursively up to maxDepth, building
// a per-file map of "what internal files does this one import?". Only
// internal files (resolvable via tsconfig or jsconfig, including aliases)
// end up in the result. Unresolved internal code imports are diagnosed;
// external packages and non-code assets are omitted.
//
// Designed for the consolidator's downstream use: a feature's "size"
// and "interesting components" are inferred from the BFS-reachable
// set of files starting at its page entry.

import { Project, Node, ts, type SourceFile } from 'ts-morph';
import { existsSync } from 'node:fs';
import { dirname, extname, join, relative, resolve } from 'node:path';
import type { ParserDiagnostic } from './legacy-types.js';

export interface BuildImportGraphOptions {
  /** Absolute path to the project root. */
  rootDir: string;
  /** Page / entry files relative to rootDir. */
  entryFiles: string[];
  /** Shared inventory; imports outside it are diagnosed, never attributed. */
  allowedSourceFiles?: ReadonlySet<string>;
  /** Walk depth cap. Defaults to 4 (page → comp → child → leaf). */
  maxDepth?: number;
  /**
   * Optional config path (relative to rootDir, or absolute), taking precedence.
   * When unset, tries tsconfig.json, then jsconfig.json. Needed
   * for path-alias resolution (e.g., @/components/*).
   */
  tsConfigFilePath?: string;
}

export interface ImportGraph {
  /** source file (relative to rootDir) → set of internal files it imports. */
  edges: Map<string, Set<string>>;
  diagnostics?: ParserDiagnostic[];
  processedFiles?: string[];
  warnings?: ImportGraphWarning[];
}

export type ImportGraphWarning = {
  code: 'PUBLIC_STATIC_IMPORT';
  file: string;
  importPath: string;
  target: string;
} | {
  code: 'UNRESOLVED_INTERNAL_IMPORT' | 'UNSUPPORTED_INTERNAL_DYNAMIC_IMPORT';
  file: string;
  importPath: string;
};

const DEFAULT_MAX_DEPTH = 4;

export function buildImportGraph(options: BuildImportGraphOptions): ImportGraph {
  const { rootDir, entryFiles } = options;
  const maxDepth = options.maxDepth ?? DEFAULT_MAX_DEPTH;

  const fileSystem = options.allowedSourceFiles
    ? sourceFileSystem(rootDir, options.allowedSourceFiles) : undefined;
  const candidateConfig = resolveTsConfig(rootDir, options.tsConfigFilePath);
  const tsConfigFilePath = candidateConfig && (!fileSystem || fileSystem.fileExistsSync(candidateConfig))
    ? candidateConfig : undefined;
  const project = new Project({
    ...(fileSystem ? { fileSystem } : {}),
    ...(tsConfigFilePath ? { tsConfigFilePath } : {}),
    skipAddingFilesFromTsConfig: true,
    skipFileDependencyResolution: true,
  });

  // Fill only missing settings so config options (including inherited values)
  // retain precedence over scanner defaults.
  const compilerOptions = project.getCompilerOptions();
  project.compilerOptions.set({
    allowJs: compilerOptions.allowJs ?? true,
    jsx: compilerOptions.jsx ?? ts.JsxEmit.Preserve,
  });
  const aliases = Object.keys(compilerOptions.paths ?? {});

  const edges = new Map<string, Set<string>>();
  const diagnostics: ParserDiagnostic[] = [];
  const warnings: ImportGraphWarning[] = [];
  const warningKeys = new Set<string>();
  const visited = new Set<string>();

  const walk = (relPath: string, depth: number): void => {
    if (depth > maxDepth) return;
    if (visited.has(relPath)) return;
    visited.add(relPath);

    const abs = join(rootDir, relPath);
    if (!existsSync(abs)) return;

    let source: SourceFile;
    try {
      source =
        project.getSourceFile(abs) ?? project.addSourceFileAtPath(abs);
    } catch (error) {
      diagnostics.push({
        filePath: relPath,
        stage: 'import-graph',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    const importedHere = new Set<string>();
    try {
      for (const decl of [...source.getImportDeclarations(), ...source.getExportDeclarations()]) {
        const importPath = decl.getModuleSpecifierValue();
        if (importPath === undefined) continue;
        const publicTarget = resolveRootPublicImport(rootDir, relPath, importPath);
        if (publicTarget !== null) {
          const key = `${relPath}\0${importPath}\0${publicTarget}`;
          if (!warningKeys.has(key)) {
            warningKeys.add(key);
            warnings.push({
              code: 'PUBLIC_STATIC_IMPORT',
              file: relPath,
              importPath,
              target: publicTarget,
            });
          }
          continue; // Static public files stay outside the source graph.
        }
        const target = decl.getModuleSpecifierSourceFile();
        if (!target) {
          if (isInternalCodeImport(importPath, aliases, compilerOptions.baseUrl)) {
            const key = `${relPath}\0${importPath}`;
            if (!warningKeys.has(key)) {
              warningKeys.add(key);
              warnings.push({ code: 'UNRESOLVED_INTERNAL_IMPORT', file: relPath, importPath });
              diagnostics.push({
                filePath: relPath,
                stage: 'import-graph',
                message: `Unresolved internal code import: ${importPath}`,
              });
            }
          }
          continue;
        }
        const targetPath = target.getFilePath();
        if (targetPath.includes('node_modules')) continue;
        const rel = relative(rootDir, targetPath);
        if (rel.startsWith('..')) continue; // outside project
        if (options.allowedSourceFiles && !options.allowedSourceFiles.has(rel)) {
          diagnostics.push({ filePath: relPath, stage: 'import-graph', message: `Internal import targets excluded source: ${importPath}` });
          continue;
        }
        importedHere.add(rel);
      }
      for (const call of source.getDescendantsOfKind(ts.SyntaxKind.CallExpression)) {
        if (call.getExpression().getKind() !== ts.SyntaxKind.ImportKeyword) continue;
        const argument = call.getArguments()[0];
        if (!argument || (!Node.isStringLiteral(argument) && !Node.isNoSubstitutionTemplateLiteral(argument))) continue;
        const importPath = argument.getLiteralText();
        if (!isInternalCodeImport(importPath, aliases, compilerOptions.baseUrl)) continue;
        const key = `dynamic\0${relPath}\0${importPath}`;
        if (warningKeys.has(key)) continue;
        warningKeys.add(key);
        warnings.push({ code: 'UNSUPPORTED_INTERNAL_DYNAMIC_IMPORT', file: relPath, importPath });
        diagnostics.push({ filePath: relPath, stage: 'import-graph', message: `Unsupported internal dynamic import: ${importPath}` });
      }
    } catch (error) {
      diagnostics.push({
        filePath: relPath,
        stage: 'import-graph',
        message: error instanceof Error ? error.message : String(error),
      });
      return;
    }

    edges.set(relPath, importedHere);

    for (const next of importedHere) {
      walk(next, depth + 1);
    }
  };

  for (const entry of entryFiles) {
    walk(entry, 0);
  }

  return { edges, diagnostics, processedFiles: [...visited].sort(), warnings };
}

function resolveRootPublicImport(
  rootDir: string,
  sourceFile: string,
  importPath: string,
): string | null {
  if (!importPath.startsWith('.')) return null;
  const target = resolve(rootDir, dirname(sourceFile), importPath);
  if (!existsSync(target)) return null;
  const rel = relative(rootDir, target);
  return rel.startsWith('public/') ? rel : null;
}

function resolveTsConfig(rootDir: string, override?: string): string | undefined {
  if (override) return resolve(rootDir, override);
  return ['tsconfig.json', 'jsconfig.json']
    .map((name) => join(rootDir, name))
    .find((candidate) => existsSync(candidate));
}

function isInternalCodeImport(importPath: string, aliases: string[], baseUrl?: string): boolean {
  const extension = extname(importPath.split(/[?#]/, 1)[0]!).toLowerCase();
  // Unknown suffixes may be dotted source stems (e.g. auth.config.ts).
  if (/^\.(?:css|scss|sass|less|styl|svg|png|jpe?g|gif|webp|avif|ico|bmp|woff2?|ttf|otf|eot|mp[34]|wav|ogg|webm|pdf|json|wasm)$/.test(extension)) return false;
  const knownBaseUrlPath = baseUrl !== undefined && existsSync(join(baseUrl, importPath.split('/')[0]!));
  return importPath.startsWith('./') || importPath.startsWith('../') || knownBaseUrlPath || aliases.some((alias) => {
    const wildcard = alias.indexOf('*');
    if (wildcard < 0) return alias === importPath;
    return importPath.startsWith(alias.slice(0, wildcard)) &&
      importPath.endsWith(alias.slice(wildcard + 1));
  });
}

/**
 * Serialize an ImportGraph into a plain JSON-friendly shape so it can
 * ride along inside ProjectIR.framework_specific.import_graph and round-trip
 * through .doklo/cache/<svc>.scan.json. Edges per file are sorted for
 * stable diffs.
 */
export function serializeImportGraph(graph: ImportGraph): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const [file, deps] of graph.edges) {
    out[file] = [...deps].sort();
  }
  return out;
}

/** Inverse of serializeImportGraph — restores Map/Set shape for in-memory use. */
export function deserializeImportGraph(data: Record<string, string[]>): ImportGraph {
  const edges = new Map<string, Set<string>>();
  for (const [file, deps] of Object.entries(data)) {
    edges.set(file, new Set(deps));
  }
  return { edges };
}

/**
 * BFS over the import graph from an entry. Returns the set of files
 * reachable within maxDepth steps, INCLUDING the entry itself.
 *
 * Use this in feature attribution: every page entry's reachable set is
 * the candidate "files belonging to this feature" before shared-file
 * deduplication.
 */
export function reachableFiles(
  graph: ImportGraph,
  entry: string,
  maxDepth: number = DEFAULT_MAX_DEPTH,
): Set<string> {
  const seen = new Set<string>([entry]);
  const queue: { file: string; depth: number }[] = [{ file: entry, depth: 0 }];
  while (queue.length > 0) {
    const { file, depth } = queue.shift()!;
    if (depth >= maxDepth) continue;
    const next = graph.edges.get(file);
    if (!next) continue;
    for (const n of next) {
      if (seen.has(n)) continue;
      seen.add(n);
      queue.push({ file: n, depth: depth + 1 });
    }
  }
  return seen;
}
