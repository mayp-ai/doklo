import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject } from '../src/ast.js';
import { buildFileLedger } from '../src/file-ledger.js';

describe('buildFileLedger', () => {
  it('classifies each candidate once and promotes parser diagnostics to failed', () => {
    const ledger = buildFileLedger(
      [
        { file: 'app/page.tsx', included: true, exclusionReason: null },
        {
          file: 'app/page.test.tsx',
          included: false,
          exclusionReason: 'TEST_FILE',
        },
      ],
      [{ filePath: 'app/page.tsx', stage: 'ast', message: 'parse failed' }],
    );

    expect(ledger).toEqual([
      {
        file: 'app/page.tsx',
        status: 'failed',
        stages: ['ast'],
        reason: 'parse failed',
        diagnosticCount: 1,
      },
      {
        file: 'app/page.test.tsx',
        status: 'excluded',
        stages: ['discovery'],
        reason: 'TEST_FILE',
      },
    ]);
    expect(new Set(ledger.map((entry) => entry.file)).size).toBe(ledger.length);
  });

  it('records only the parser stages actually executed for each processed file', () => {
    const ledger = buildFileLedger(
      [
        { file: 'app/page.tsx', included: true, exclusionReason: null },
        { file: 'components/Card.tsx', included: true, exclusionReason: null },
      ],
      [],
      new Map([
        ['app/page.tsx', ['discovery', 'ast', 'routing', 'import-graph'] as const],
        ['components/Card.tsx', ['discovery', 'ast', 'routing'] as const],
      ]),
    );

    expect(ledger.map(({ file, stages }) => ({ file, stages }))).toEqual([
      {
        file: 'app/page.tsx',
        stages: ['discovery', 'ast', 'routing', 'import-graph'],
      },
      {
        file: 'components/Card.tsx',
        stages: ['discovery', 'ast', 'routing'],
      },
    ]);
  });

  it('keeps parser code and source position for a malformed JavaScript candidate', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-ledger-diagnostic-'));
    const file = 'broken.js';
    await writeFile(
      join(root, file),
      `${'\n'.repeat(666)}      $('html').addClass(ENABLED))\n`,
      'utf-8',
    );
    const candidate = { file, included: true, exclusionReason: null } as const;

    const parsed = parseProject({
      rootDir: root,
      files: [file],
      candidates: [candidate],
      summary: { matched: 1, excluded: 0, symlinksAudited: 0 },
    });
    const ledger = buildFileLedger([candidate], parsed.diagnostics);

    expect(ledger).toEqual([{
      file,
      status: 'failed',
      stages: ['ast'],
      reason: "TS1005 667:34 ';' expected.",
      diagnosticCount: 1,
    }]);
  });
});
