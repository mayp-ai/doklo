import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';

export const NEXTJS_SUPPORT = Object.freeze({
  framework: 'nextjs',
  router: 'app-router',
  appRoots: ['app', 'src/app'],
  sourceExtensions: ['.ts', '.tsx', '.js', '.jsx'],
} as const);

export interface NextJsSupportInspection {
  framework: 'nextjs';
  router: 'app-router';
  appRoot: 'app' | 'src/app';
  packageFile: string;
  nextVersion: string | null;
}

export type UnsupportedNextJsProjectReason =
  | 'PACKAGE_JSON_REQUIRED'
  | 'PACKAGE_JSON_INVALID'
  | 'NEXT_PACKAGE_REQUIRED'
  | 'NEXT_PACKAGE_VERSION_INVALID'
  | 'APP_ROUTER_REQUIRED';

export class UnsupportedNextJsProjectError extends Error {
  readonly code = 'UNSUPPORTED_NEXTJS_PROJECT' as const;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reason: UnsupportedNextJsProjectReason, rootDir: string) {
    super(`Unsupported Next.js project at ${rootDir}: ${reason}`);
    this.name = 'UnsupportedNextJsProjectError';
    this.details = Object.freeze({ reason, rootDir });
  }
}

function unsupported(
  reason: UnsupportedNextJsProjectReason,
  rootDir: string,
): UnsupportedNextJsProjectError {
  return new UnsupportedNextJsProjectError(reason, rootDir);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export async function inspectNextJsSupport(
  rootDir: string,
): Promise<NextJsSupportInspection> {
  const packageFile = resolve(rootDir, 'package.json');
  let packageContents: string;
  try {
    packageContents = await readFile(packageFile, 'utf8');
  } catch {
    throw unsupported('PACKAGE_JSON_REQUIRED', rootDir);
  }

  let pkg: unknown;
  try {
    pkg = JSON.parse(packageContents);
  } catch {
    throw unsupported('PACKAGE_JSON_INVALID', rootDir);
  }
  if (!isRecord(pkg)) {
    throw unsupported('PACKAGE_JSON_INVALID', rootDir);
  }

  const dependencies = isRecord(pkg.dependencies) ? pkg.dependencies : {};
  const devDependencies = isRecord(pkg.devDependencies) ? pkg.devDependencies : {};
  const nextVersionValue = dependencies.next ?? devDependencies.next ?? null;
  if (nextVersionValue === null) {
    throw unsupported('NEXT_PACKAGE_REQUIRED', rootDir);
  }
  if (typeof nextVersionValue !== 'string' || nextVersionValue.trim() === '') {
    throw unsupported('NEXT_PACKAGE_VERSION_INVALID', rootDir);
  }
  const nextVersion = nextVersionValue;

  for (const appRoot of NEXTJS_SUPPORT.appRoots) {
    if ((await stat(resolve(rootDir, appRoot)).catch(() => null))?.isDirectory()) {
      return {
        framework: 'nextjs',
        router: 'app-router',
        appRoot,
        packageFile,
        nextVersion,
      };
    }
  }

  throw unsupported('APP_ROUTER_REQUIRED', rootDir);
}
