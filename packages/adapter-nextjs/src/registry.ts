import type { ProjectIR } from '@doklo-beta/core';
import { extractIR } from './index.js';
import { extractGenericIR } from './generic.js';
import { inspectNextJsSupport, UnsupportedNextJsProjectError } from './support.js';

export interface ProjectParser {
  id: string;
  matches(rootDir: string, allowedSourceFiles?: ReadonlySet<string>): Promise<boolean>;
  extract(options: { rootDir: string; allowedSourceFiles?: ReadonlySet<string> }): Promise<ProjectIR>;
}

export const PROJECT_PARSERS: readonly ProjectParser[] = [{
  id: 'nextjs-app-router',
  async matches(rootDir, allowedSourceFiles) {
    if (allowedSourceFiles && !allowedSourceFiles.has('package.json')) return false;
    try { await inspectNextJsSupport(rootDir); return true; }
    catch (error) {
      if (error instanceof UnsupportedNextJsProjectError) return false;
      throw error;
    }
  },
  extract: extractIR,
}];

/** A missing specialist falls back; a selected specialist's failure never does. */
export async function extractProjectIR(
  options: { rootDir: string },
  parsers: readonly ProjectParser[] = PROJECT_PARSERS,
): Promise<ProjectIR> {
  // Inventory first so specialist matching cannot bypass source containment.
  const generic = await extractGenericIR(options);
  for (const parser of parsers) {
    if (!await parser.matches(options.rootDir, new Set(generic.files))) continue;
    const specialized = await parser.extract({ ...options, allowedSourceFiles: new Set(generic.files) });
    const ledger = specialized.framework_specific?.['file_ledger'] as Array<{ file: string; status: string }> | undefined;
    if (!specialized.routes.some(route => route.kind === 'page')) {
      // API-only/worker projects still need candidates. Keep specialist metadata,
      // but use file inventory as the analysis and tracking baseline.
      const failures = new Map((ledger ?? []).filter(entry => entry.status === 'failed').map(entry => [entry.file, entry]));
      return {
        ...generic, framework: specialized.framework, routes: specialized.routes,
        components: specialized.components, stores: specialized.stores, role_signals: specialized.role_signals,
        framework_specific: {
          ...specialized.framework_specific, ...generic.framework_specific,
          file_ledger: (generic.framework_specific?.['file_ledger'] as Array<{ file: string }>).map(entry => failures.get(entry.file) ?? entry),
        },
      };
    }
    const accounted = new Set([...(ledger ?? []).map(entry => entry.file), ...specialized.files, 'package.json']);
    const extras = generic.files.filter(file => !accounted.has(file));
    if (!extras.length) return specialized;
    const extraSet = new Set(extras);
    return {
      ...specialized,
      files: [...new Set([...specialized.files, ...extras])].sort(),
      analysis_units: (generic.analysis_units ?? []).map(unit => ({ ...unit, files: unit.files.filter(file => extraSet.has(file)) })).filter(unit => unit.files.length > 0),
      framework_specific: {
        ...specialized.framework_specific,
        file_ledger: [...(ledger ?? []), ...(generic.framework_specific?.['file_ledger'] as Array<{ file: string }>).filter(entry => extraSet.has(entry.file))],
      },
    };
  }
  return generic;
}
