import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  extractIR,
  type ParserFileLedgerEntry,
} from '../src/index.js';

const FIXTURE = join(
  dirname(fileURLToPath(import.meta.url)),
  'fixtures/app-router-golden',
);

interface GoldenExpectation {
  routes: string[];
  candidate_status: Record<string, ParserFileLedgerEntry['status']>;
  required_processed: string[];
}

function readFileLedger(ir: Awaited<ReturnType<typeof extractIR>>): ParserFileLedgerEntry[] {
  const ledger = ir.framework_specific?.['file_ledger'];
  if (!Array.isArray(ledger)) {
    throw new Error('framework_specific.file_ledger is required');
  }
  return ledger as ParserFileLedgerEntry[];
}

function normalize(
  ir: Awaited<ReturnType<typeof extractIR>>,
  ledger: ParserFileLedgerEntry[],
  expected: GoldenExpectation,
): GoldenExpectation {
  return {
    routes: [...new Set(
      ir.routes
        .filter((route) => route.kind !== 'layout')
        .map((route) => route.path),
    )].sort(),
    candidate_status: Object.fromEntries(
      Object.keys(expected.candidate_status).map((file) => [
        file,
        ledger.find((entry) => entry.file === file)?.status,
      ]),
    ) as GoldenExpectation['candidate_status'],
    required_processed: expected.required_processed.filter((file) =>
      ledger.some((entry) => entry.file === file && entry.status === 'processed'),
    ),
  };
}

// Full TypeScript project scans can exceed Vitest's 5s default on shared CI runners.
const GOLDEN_SCAN_TIMEOUT_MS = 30_000;

describe('App Router golden fixture', () => {
  it('accounts for every first-party parser candidate', async () => {
    const expected = JSON.parse(
      await readFile(join(FIXTURE, 'expected.json'), 'utf8'),
    ) as GoldenExpectation;

    const ir = await extractIR({ rootDir: FIXTURE, includeImportGraph: true });
    const ledger = readFileLedger(ir);

    expect(normalize(ir, ledger, expected)).toEqual(expected);
    expect(ledger.filter((entry) => entry.status === 'failed')).toEqual([]);
    expect(new Set(ledger.map((entry) => entry.file)).size).toBe(ledger.length);
  }, GOLDEN_SCAN_TIMEOUT_MS);

  it('reports specialized stages only for files those parsers visit', async () => {
    const withImportGraph = readFileLedger(
      await extractIR({ rootDir: FIXTURE, includeImportGraph: true }),
    );
    const withoutImportGraph = readFileLedger(
      await extractIR({ rootDir: FIXTURE, includeImportGraph: false }),
    );

    const stagesFor = (ledger: ParserFileLedgerEntry[], file: string) =>
      ledger.find((entry) => entry.file === file)?.stages;

    expect(stagesFor(withImportGraph, 'app/admin/page.tsx')).toEqual([
      'discovery',
      'ast',
      'routing',
      'import-graph',
    ]);
    expect(stagesFor(withImportGraph, 'app/api/users/route.ts')).toEqual([
      'discovery',
      'ast',
      'routing',
    ]);
    expect(stagesFor(withImportGraph, 'stores/session.ts')).toEqual([
      'discovery',
      'ast',
      'routing',
      'state',
    ]);
    expect(stagesFor(withoutImportGraph, 'app/admin/page.tsx')).toEqual([
      'discovery',
      'ast',
      'routing',
    ]);
  }, GOLDEN_SCAN_TIMEOUT_MS);
});
