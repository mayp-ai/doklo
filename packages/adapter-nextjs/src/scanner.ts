// ============================================
// Scanner: 프로젝트 파일 탐색
// ============================================

import { glob } from 'glob';
import { lstat, readdir, realpath } from 'node:fs/promises';
import path from 'path';
import type { ScanResult, SourceCandidate } from './legacy-types.js';

const HARD_IGNORE = [
  'out/**',
  'public/**',
  '**/node_modules/**',
  '**/.next/**',
  '**/.git/**',
  '**/.claude/**',
  '**/.codex/**',
  '**/.agents/**',
  '**/.worktrees/**',
  '**/dist/**',
  '**/build/**',
  '**/coverage/**',
];

const AUDIT_SKIP_DIRECTORY_NAMES = new Set([
  'node_modules',
]);

/** 지원하는 파일 확장자 */
const SUPPORTED_EXTENSIONS = ['ts', 'tsx', 'js', 'jsx'];

// Files read directly by routing/import-graph extraction rather than through
// the glob result. Validate them at the same pre-parse boundary so a symlinked
// package/config/env file cannot smuggle workspace-external content into IR.
const DIRECT_READ_FILES = [
  'package.json',
  'tsconfig.json',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'middleware.ts',
  'middleware.js',
  'src/middleware.ts',
  'src/middleware.js',
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.example',
] as const;

export class ScanPathOutsideRootError extends Error {
  constructor(
    public readonly root: string,
    public readonly candidate: string,
  ) {
    super(`Scan path "${candidate}" resolves outside scan root "${root}".`);
    this.name = 'ScanPathOutsideRootError';
  }
}

/**
 * 프로젝트 디렉토리를 스캔하여 분석 대상 파일 목록을 반환
 */
export async function scanProject(rootDir: string): Promise<ScanResult> {
  const absoluteRoot = path.resolve(rootDir);
  const physicalRoot = await realpath(absoluteRoot);
  
  const pattern = `**/*.{${SUPPORTED_EXTENSIONS.join(',')}}`;
  
  const candidateFiles = await glob(pattern, {
    cwd: absoluteRoot,
    absolute: false,
    dot: true,
    ignore: HARD_IGNORE,
    nodir: true,
  });
  const candidates = candidateFiles.sort().map(classifyCandidate);
  const files = candidates
    .filter((candidate) => candidate.included)
    .map((candidate) => candidate.file);

  // This must happen before any parser sees the discovered paths. Glob keeps
  // symlink spellings relative to cwd, while ts-morph and the routing parser
  // follow them when opening files.
  for (const candidate of new Set<string>([...files, ...DIRECT_READ_FILES])) {
    await assertContainedIfPresent(absoluteRoot, physicalRoot, candidate);
  }

  // A directory symlink may not appear in the source glob, yet ts-morph can
  // still follow it while resolving imports. Audit link entries themselves,
  // including links nested under ignored build/metadata trees: an explicit
  // source import can still make ts-morph resolve those paths. node_modules is
  // the sole exception because package-manager layouts routinely link it
  // outside the project and the import graph excludes dependency targets.
  const symlinksAudited = await auditSymlinkEntries(absoluteRoot, physicalRoot);

  return {
    rootDir: absoluteRoot,
    files,
    candidates,
    summary: {
      matched: candidates.length,
      excluded: candidates.filter((candidate) => !candidate.included).length,
      symlinksAudited,
    },
  };
}

function classifyCandidate(file: string): SourceCandidate {
  const testFile = /(^|\/)(__tests__|__mocks__)(\/|$)/.test(file)
    || /\.(test|spec)\.(ts|tsx|js|jsx)$/.test(file);
  if (testFile) {
    return { file, included: false, exclusionReason: 'TEST_FILE' };
  }

  const generatedDeclaration = file === 'next-env.d.ts'
    || file.endsWith('/next-env.d.ts')
    || /\.generated\.d\.ts$/.test(file)
    || /(^|\/)(generated|__generated__)\/.*\.d\.ts$/.test(file);
  if (generatedDeclaration) {
    return {
      file,
      included: false,
      exclusionReason: 'GENERATED_DECLARATION',
    };
  }

  return { file, included: true, exclusionReason: null };
}

async function auditSymlinkEntries(
  lexicalRoot: string,
  physicalRoot: string,
): Promise<number> {
  const pending = [''];
  let symlinksAudited = 0;
  while (pending.length > 0) {
    const directory = pending.pop()!;
    const entries = await readdir(path.resolve(lexicalRoot, directory), {
      withFileTypes: true,
    });
    for (const entry of entries) {
      const candidate = path.join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        // Package-manager layouts routinely link node_modules outside the
        // project. The import-graph walker excludes any node_modules target.
        if (entry.name !== 'node_modules') {
          await assertContainedIfPresent(lexicalRoot, physicalRoot, candidate);
          symlinksAudited += 1;
        }
        continue;
      }
      if (
        entry.isDirectory()
        && !AUDIT_SKIP_DIRECTORY_NAMES.has(entry.name)
      ) {
        pending.push(candidate);
      }
    }
  }
  return symlinksAudited;
}

async function assertContainedIfPresent(
  lexicalRoot: string,
  physicalRoot: string,
  candidate: string,
): Promise<void> {
  const lexicalTarget = path.resolve(lexicalRoot, candidate);
  if (!isContained(lexicalRoot, lexicalTarget)) {
    throw new ScanPathOutsideRootError(lexicalRoot, candidate);
  }

  let physicalTarget: string;
  try {
    physicalTarget = await realpath(lexicalTarget);
  } catch (error) {
    if (!isMissingPathError(error)) throw error;
    try {
      await lstat(lexicalTarget);
    } catch (lstatError) {
      if (isMissingPathError(lstatError)) return;
      throw lstatError;
    }
    // An entry that lstats but cannot be realpathed is a dangling symlink.
    throw new ScanPathOutsideRootError(lexicalRoot, candidate);
  }

  if (!isContained(physicalRoot, physicalTarget)) {
    throw new ScanPathOutsideRootError(lexicalRoot, candidate);
  }
}

function isContained(root: string, target: string): boolean {
  const fromRoot = path.relative(root, target);
  return fromRoot === '' || (
    fromRoot !== '..'
    && !fromRoot.startsWith(`..${path.sep}`)
    && !path.isAbsolute(fromRoot)
  );
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * 스캔 결과를 콘솔에 출력
 */
export function printScanSummary(result: ScanResult): void {
  console.log('\n📁 Scan Summary');
  console.log('─'.repeat(40));
  console.log(`   Root: ${result.rootDir}`);
  console.log(`   Matched candidates: ${result.summary.matched}`);
  console.log(`   Excluded candidates: ${result.summary.excluded}`);
  console.log(`   Symlinks audited: ${result.summary.symlinksAudited}`);
}
