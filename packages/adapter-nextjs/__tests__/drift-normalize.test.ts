// Format-only normaliser (judge-gated sync design §4.2) — ported from the
// benchmark harness (`benchmarks/judge-sync/src/normalize.ts`), which measured
// zero false "format-only" verdicts on 32 real changes. The synthetic cases are
// the benchmark plan's §3.3 table plus the conservative-rule traps. Only the
// "format-only" rows may come out format-only; every other row must be a real
// change. A wrong "format-only" is the one error this layer must never make.
import { describe, expect, it } from 'vitest';
import { ts } from 'ts-morph';
import {
  computeLogicHash,
  computeNormalizedLogicHash,
  isDokStale,
  type Dok,
} from '@doklo-beta/core';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  NORMALIZER_ID,
  NORMALIZER_VERSION,
  isFormatOnlyChange,
  normalizeForHash,
  tsTreeNormalizer,
} from '../src/drift/normalize.js';

const BASE_TS = [
  "'use client'",
  '',
  "import { fetchRows } from './api'",
  '',
  'const LIMIT = 10',
  '',
  'export async function loadRows(page: number) {',
  "  const url = 'https://example.com/rows'",
  '  const rows = await fetchRows(url, page, LIMIT)',
  '  if (rows.length === 0) {',
  "    console.error('no rows for page', page)",
  '    return []',
  '  }',
  '  return rows',
  '}',
  '',
].join('\n');

const BASE_TSX = [
  "'use client'",
  '',
  'export default function Panel({ title }: { title: string }) {',
  '  return (',
  "    <section className='panel'>",
  '      <h2>{title}</h2>',
  '      <p>Download the report</p>',
  '      <button type="button">Save</button>',
  '    </section>',
  '  )',
  '}',
  '',
].join('\n');

const formatOnly = isFormatOnlyChange;

describe('normaliser version', () => {
  it('names the algorithm and the TypeScript parser that produced the canonical form', () => {
    expect(NORMALIZER_ID).toBe('ts-tree-v1');
    expect(NORMALIZER_VERSION).toBe(`ts-tree-v1+ts${ts.version}`);
    expect(NORMALIZER_VERSION).not.toContain(':');
    expect(tsTreeNormalizer.version).toBe(NORMALIZER_VERSION);
    expect(tsTreeNormalizer.normalizeForHash).toBe(normalizeForHash);
    expect(Object.isFrozen(tsTreeNormalizer)).toBe(true);
  });
});

describe('plan §3.3 synthetic cases — format-only rows', () => {
  it('whitespace only (indentation, blank lines) → format-only', () => {
    const after = BASE_TS
      .replace('  const url', '    const url')
      .replace('  return rows\n', '\n\n  return rows\n')
      .replace('LIMIT = 10', 'LIMIT   =   10');
    expect(after).not.toBe(BASE_TS);
    expect(formatOnly('lib/rows.ts', BASE_TS, after)).toBe(true);
  });

  it('line endings switched to CRLF → format-only', () => {
    const after = BASE_TS.replace(/\n/g, '\r\n');
    expect(formatOnly('lib/rows.ts', BASE_TS, after)).toBe(true);
    expect(formatOnly('components/Panel.tsx', BASE_TSX, BASE_TSX.replace(/\n/g, '\r\n'))).toBe(true);
  });

  it('comments only (line, block, JSDoc) → format-only', () => {
    const after = BASE_TS
      .replace('const LIMIT = 10', '// page size\nconst LIMIT = 10 /* rows */')
      .replace('export async function', '/**\n * Load one page of rows.\n * @param page 1-based\n */\nexport async function');
    expect(formatOnly('lib/rows.ts', BASE_TS, after)).toBe(true);
  });

  it('JSX re-indentation and a JSX comment between elements → format-only', () => {
    const after = BASE_TSX
      .replace("    <section className='panel'>", "    <section className='panel'>\n      {/* heading */}")
      .replace('      <h2>{title}</h2>', '          <h2>{title}</h2>');
    expect(formatOnly('components/Panel.tsx', BASE_TSX, after)).toBe(true);
  });

  it('comment-only change in a .js file that contains JSX → format-only', () => {
    const before = 'export const A = () => <div>hi</div>\n';
    const after = '// legacy entry\nexport const A = () => <div>hi</div> // inline\n';
    expect(formatOnly('components/A.js', before, after)).toBe(true);
  });

  it('the .jsx, .mjs and .cjs extensions are normalised too', () => {
    expect(formatOnly('components/A.jsx', 'export const A = () => <b>x</b>\n', '/* a */ export const A = () => <b>x</b>\n')).toBe(true);
    expect(formatOnly('lib/a.mjs', 'export const a = 1\n', '// note\nexport const a = 1\n')).toBe(true);
    expect(formatOnly('lib/a.cjs', 'module.exports = 1\n', 'module.exports = 1 // one\n')).toBe(true);
  });
});

describe('plan §3.3 synthetic cases — real-change rows', () => {
  const realChanges: Array<[string, string, string]> = [
    ['rename (function name)', 'lib/rows.ts', BASE_TS.replace('loadRows', 'fetchPage')],
    ['threshold (10 → 5)', 'lib/rows.ts', BASE_TS.replace('LIMIT = 10', 'LIMIT = 5')],
    ['comment and number together', 'lib/rows.ts', BASE_TS.replace('const LIMIT = 10', '// smaller pages\nconst LIMIT = 5')],
    ['log message (string)', 'lib/rows.ts', BASE_TS.replace("'no rows for page'", "'empty page'")],
    ['only the // inside a string (URL)', 'lib/rows.ts', BASE_TS.replace('https://example.com/rows', 'https://example.org/rows')],
    ['newline after return (ASI)', 'lib/rows.ts', BASE_TS.replace('  return rows\n}', '  return\n    rows\n}')],
    ['JSX text', 'components/Panel.tsx', BASE_TSX.replace('Download the report', 'Export the report')],
    ['quote style only (conservative)', 'lib/rows.ts', BASE_TS.replace("'no rows for page'", '"no rows for page"')],
  ];
  for (const [name, file, after] of realChanges) {
    it(`${name} → real change`, () => {
      const before = file.endsWith('.tsx') ? BASE_TSX : BASE_TS;
      expect(after).not.toBe(before);
      expect(formatOnly(file, before, after)).toBe(false);
    });
  }

  it('.prisma comment only → real change (not a normalised file type)', () => {
    const before = 'model User {\n  id Int @id\n}\n';
    const after = '// users\nmodel User {\n  id Int @id\n}\n';
    expect(normalizeForHash('prisma/schema.prisma', before)).toBeNull();
    expect(formatOnly('prisma/schema.prisma', before, after)).toBe(false);
  });

  it('a file with a syntax error → real change, even for a whitespace-only edit', () => {
    const broken = 'export function f( {\n  return 1\n}\n';
    expect(normalizeForHash('lib/broken.ts', broken)).toBeNull();
    expect(formatOnly('lib/broken.ts', broken, broken.replace('return 1', '  return 1'))).toBe(false);
    // Breaking a file is never format-only either.
    expect(formatOnly('lib/rows.ts', BASE_TS, BASE_TS.replace('return []', 'return ['))).toBe(false);
  });
});

describe('conservative-rule traps (beyond the plan table)', () => {
  it('a JSX comment that splits a text run → real change', () => {
    const before = 'export const A = () => <p>ab</p>\n';
    const after = 'export const A = () => <p>a{/* split */}b</p>\n';
    expect(formatOnly('components/A.tsx', before, after)).toBe(false);
  });

  it('re-indenting a JSX line that carries text → real change (JSX text is never rewritten)', () => {
    const before = 'export const A = () => (\n  <p>\n    Hello\n  </p>\n)\n';
    const after = 'export const A = () => (\n  <p>\n        Hello\n  </p>\n)\n';
    expect(formatOnly('components/A.tsx', before, after)).toBe(false);
  });

  it('CRLF inside a multi-line template literal → real change (token text untouched)', () => {
    const before = 'export const q = `select *\nfrom t`\n';
    const after = 'export const q = `select *\r\nfrom t`\r\n';
    expect(formatOnly('lib/q.ts', before, after)).toBe(false);
  });

  it('a regular-expression literal change → real change', () => {
    const before = 'export const r = /a\\/\\/b/g\n';
    const after = 'export const r = /a\\/\\/c/g\n';
    expect(formatOnly('lib/r.ts', before, after)).toBe(false);
  });

  it('whitespace inside a string literal → real change', () => {
    expect(formatOnly('lib/s.ts', "export const s = 'a b'\n", "export const s = 'a  b'\n")).toBe(false);
  });

  it('adding a trailing comma or dropping a semicolon → real change (token-level, conservative)', () => {
    expect(formatOnly('lib/t.ts', 'export const a = [1, 2]\n', 'export const a = [1, 2,]\n')).toBe(false);
    expect(formatOnly('lib/t.ts', 'export const a = 1;\n', 'export const a = 1\n')).toBe(false);
  });

  it('JSON whitespace → real change (compared raw)', () => {
    expect(normalizeForHash('package.json', '{"a":1}\n')).toBeNull();
    expect(formatOnly('package.json', '{"a":1}\n', '{ "a": 1 }\n')).toBe(false);
  });

  it('unlisted script extensions (.mts, .cts) and extensionless files stay raw', () => {
    expect(normalizeForHash('lib/a.mts', 'export const a = 1\n')).toBeNull();
    expect(normalizeForHash('lib/a.cts', 'export const a = 1\n')).toBeNull();
    expect(normalizeForHash('Dockerfile', 'FROM node\n')).toBeNull();
    expect(normalizeForHash('.ts', 'export const a = 1\n')).toBeNull();
  });

  it('the canonical form is deterministic and comment-free', () => {
    const a = normalizeForHash('lib/rows.ts', BASE_TS);
    expect(a).not.toBeNull();
    expect(normalizeForHash('lib/rows.ts', BASE_TS)).toBe(a);
    expect(normalizeForHash('lib/rows.ts', `/** doc */\n${BASE_TS}`)).toBe(a);
    expect(a).not.toContain('doc');
  });

  it('pins the ts-tree-v1 canonical form: if this changes, bump NORMALIZER_ID', () => {
    // Stored hashes carry the version; a new algorithm under the old id would
    // let an old hash silently match (or miss) a new canonical form. A new
    // TypeScript version changes NORMALIZER_VERSION on its own — if only that
    // moved this golden, update the golden, not the id.
    expect(normalizeForHash('lib/a.ts', 'const a = 1 // one\n')).toBe(
      `(SourceFile (SyntaxList (FirstStatement (VariableDeclarationList ConstKeyword="const" (SyntaxList (VariableDeclaration Identifier="a" FirstAssignment="=" FirstLiteralToken="1" ) ) ) ) ) EndOfFileToken="" ) `,
    );
  });
});

describe('tsTreeNormalizer with core’s normalised logic hash', () => {
  const files = [
    { file: 'lib/rows.ts', content: BASE_TS },
    { file: 'components/Panel.tsx', content: BASE_TSX },
    { file: 'prisma/schema.prisma', content: 'model A {\n  id Int @id\n}\n' },
  ];

  it('is stable: the same files give the same version-prefixed hash in any order', () => {
    const h = computeNormalizedLogicHash(files, tsTreeNormalizer);
    expect(h).toMatch(new RegExp(`^${NORMALIZER_VERSION.replace(/[.+]/g, '\\$&')}:[0-9a-f]{64}$`));
    expect(computeNormalizedLogicHash(files, tsTreeNormalizer)).toBe(h);
    expect(computeNormalizedLogicHash([...files].reverse(), tsTreeNormalizer)).toBe(h);
  });

  it('a comment-only edit keeps the normalised hash; a real edit or a raw-file edit moves it', () => {
    const h = computeNormalizedLogicHash(files, tsTreeNormalizer);
    const commented = [{ file: 'lib/rows.ts', content: `// header\n${BASE_TS}` }, files[1]!, files[2]!];
    expect(computeLogicHash(commented)).not.toBe(computeLogicHash(files));
    expect(computeNormalizedLogicHash(commented, tsTreeNormalizer)).toBe(h);
    const real = [{ file: 'lib/rows.ts', content: BASE_TS.replace('LIMIT = 10', 'LIMIT = 5') }, files[1]!, files[2]!];
    expect(computeNormalizedLogicHash(real, tsTreeNormalizer)).not.toBe(h);
    const prisma = [files[0]!, files[1]!, { file: 'prisma/schema.prisma', content: '// c\nmodel A {\n  id Int @id\n}\n' }];
    expect(computeNormalizedLogicHash(prisma, tsTreeNormalizer)).not.toBe(h);
  });

  it('drives isDokStale to format-only for a comment edit and changed for a real one', () => {
    const root = mkdtempSync(join(tmpdir(), 'doklo-normalize-'));
    try {
      for (const { file, content } of files) {
        mkdirSync(dirname(join(root, file)), { recursive: true });
        writeFileSync(join(root, file), content);
      }
      const dok = {
        dok_id: 'ROWS',
        name: 'Rows',
        description: 'Rows',
        status: 'active',
        tags: [],
        surfaces: [],
        _meta: {
          version: 1,
          history: [],
          tracking_version: 2,
          logic_hash: computeLogicHash(files),
          logic_hash_normalized: computeNormalizedLogicHash(files, tsTreeNormalizer),
          logic_files: files.map(({ file }) => ({ file })),
        },
      } as unknown as Dok;
      expect(isDokStale(dok, root, { normalize: tsTreeNormalizer })).toEqual({ stale: false });
      writeFileSync(join(root, 'lib/rows.ts'), BASE_TS.replace(/\n/g, '\r\n').replace('const LIMIT', '/* rows */ const LIMIT'));
      expect(isDokStale(dok, root, { normalize: tsTreeNormalizer })).toEqual({ stale: false, reason: 'format-only' });
      writeFileSync(join(root, 'lib/rows.ts'), BASE_TS.replace('LIMIT = 10', 'LIMIT = 5'));
      expect(isDokStale(dok, root, { normalize: tsTreeNormalizer })).toEqual({ stale: true, reason: 'changed' });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
