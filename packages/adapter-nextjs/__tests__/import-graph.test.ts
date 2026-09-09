import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import {
  buildImportGraph,
  deserializeImportGraph,
  reachableFiles,
  serializeImportGraph,
  type ImportGraph,
} from '../src/import-graph.js';
import { extractIR } from '../src/index.js';

async function tmpProject(files: Record<string, string>, tsconfig?: object): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-graph-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    await writeFile(abs, content, 'utf-8');
  }
  const tsc = tsconfig ?? {
    compilerOptions: {
      jsx: 'preserve',
      module: 'esnext',
      moduleResolution: 'bundler',
      target: 'esnext',
      strict: false,
      paths: { '@/*': ['./*'] },
    },
    include: ['**/*.ts', '**/*.tsx'],
  };
  await writeFile(join(root, 'tsconfig.json'), JSON.stringify(tsc, null, 2), 'utf-8');
  return root;
}

describe('buildImportGraph', () => {
  it('returns an empty graph when given no entry files', async () => {
    const root = await tmpProject({});
    const g = buildImportGraph({ rootDir: root, entryFiles: [] });
    expect(g.edges.size).toBe(0);
  });

  it('records direct imports from a single entry file', async () => {
    const root = await tmpProject({
      'app/page.tsx': `
        import Button from './Button';
        import { useFoo } from './hooks';
        export default function Page() { return <Button/>; }
      `,
      'app/Button.tsx': `export default function Button() { return <button/>; }`,
      'app/hooks.ts': `export function useFoo() {}`,
    });

    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });
    const fromPage = g.edges.get('app/page.tsx');
    expect(fromPage).toBeDefined();
    expect([...fromPage!]).toEqual(
      expect.arrayContaining(['app/Button.tsx', 'app/hooks.ts']),
    );
  });

  it('skips external (node_modules) imports', async () => {
    const root = await tmpProject({
      'app/page.tsx': `
        import { useState } from 'react';
        import Button from './Button';
        export default function Page() { useState(); return <Button/>; }
      `,
      'app/Button.tsx': `export default function Button(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });
    const imports = [...(g.edges.get('app/page.tsx') ?? [])];
    expect(imports).toEqual(['app/Button.tsx']); // react not in result
  });

  it('resolves tsconfig path aliases (@/* → root-relative)', async () => {
    const root = await tmpProject({
      'app/page.tsx': `
        import Card from '@/components/Card';
        export default function Page(){ return <Card/>; }
      `,
      'components/Card.tsx': `export default function Card(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });
    const imports = [...(g.edges.get('app/page.tsx') ?? [])];
    expect(imports).toEqual(['components/Card.tsx']);
  });

  it('resolves JSX aliases from jsconfig without overriding explicit compiler options', async () => {
    const root = await tmpProject({
      'app/page.jsx': "import Uploader from '@/components/Uploader'; export default () => <Uploader/>;",
      'components/Uploader.jsx': 'export default () => <input/>;',
      'jsconfig.json': JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['./*'] } } }),
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
    });
    await unlink(join(root, 'tsconfig.json'));
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.jsx'] });
    expect([...(graph.edges.get('app/page.jsx') ?? [])]).toEqual(['components/Uploader.jsx']);
    expect(graph.diagnostics).toEqual([]);
    const ir = await extractIR({ rootDir: root });
    expect(ir.framework_specific?.['import_graph']).toMatchObject({ 'app/page.jsx': ['components/Uploader.jsx'] });
    expect(ir.framework_specific?.['import_graph_tracking_version']).toBe(2);
  });

  it('uses JSX and JavaScript defaults without any config', async () => {
    const root = await tmpProject({
      'app/page.jsx': "import Child from './Child'; export default () => <Child/>;",
      'app/Child.jsx': 'export default () => <div/>;',
    });
    await unlink(join(root, 'tsconfig.json'));
    expect([...(buildImportGraph({ rootDir: root, entryFiles: ['app/page.jsx'] }).edges.get('app/page.jsx') ?? [])])
      .toEqual(['app/Child.jsx']);
  });

  it('prefers tsconfig to jsconfig and an explicit config to both', async () => {
    const config = (folder: string) => JSON.stringify({ compilerOptions: { paths: { '@/*': [`./${folder}/*`] } } });
    const root = await tmpProject({
      'app/page.ts': "import value from '@/value';",
      'typescript/value.ts': 'export default 1;',
      'javascript/value.ts': 'export default 2;',
      'explicit/value.ts': 'export default 3;',
      'jsconfig.json': config('javascript'),
      'custom.json': config('explicit'),
    }, JSON.parse(config('typescript')));
    expect([...(buildImportGraph({ rootDir: root, entryFiles: ['app/page.ts'] }).edges.get('app/page.ts') ?? [])])
      .toEqual(['typescript/value.ts']);
    expect([...(buildImportGraph({ rootDir: root, entryFiles: ['app/page.ts'], tsConfigFilePath: 'custom.json' }).edges.get('app/page.ts') ?? [])])
      .toEqual(['explicit/value.ts']);
  });

  it('retains inherited aliases and explicit JavaScript restrictions from extends', async () => {
    const root = await tmpProject({
      'app/page.ts': "import value from '@/value'; import Child from './Child';",
      'src/value.ts': 'export default 1;',
      'app/Child.jsx': 'export default () => <div/>;',
      'base.json': JSON.stringify({ compilerOptions: {
        paths: { '@/*': ['./src/*'] }, allowJs: false, jsx: 'react-jsx',
      } }),
    }, { extends: './base.json' });
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.ts'] });
    expect([...(graph.edges.get('app/page.ts') ?? [])]).toEqual(['src/value.ts']);
    expect(graph.warnings).toEqual([
      { code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/page.ts', importPath: './Child' },
    ]);
  });

  it('preserves an explicit allowJs false instead of replacing it with defaults', async () => {
    const root = await tmpProject({
      'app/page.tsx': "import Child from './Child'; export default () => <Child/>;",
      'app/Child.jsx': 'export default () => <div/>;',
    }, { compilerOptions: { allowJs: false, jsx: 'react-jsx' } });
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });
    expect([...(graph.edges.get('app/page.tsx') ?? [])]).toEqual([]);
    expect(graph.warnings).toContainEqual({ code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/page.tsx', importPath: './Child' });
  });

  it('reports unresolved relative and known-alias code imports through graph and IR', async () => {
    const root = await tmpProject({
      'app/page.tsx': `import Missing from './Missing';
        import Other from '@/components/Other.jsx';
        import './Missing';
        import './theme.css'; import '@/theme.scss'; import './logo.svg';
        import 'react'; import '@external/library';
        export default () => null;`,
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
    });
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });
    expect(graph.warnings).toEqual([
      { code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/page.tsx', importPath: './Missing' },
      { code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/page.tsx', importPath: '@/components/Other.jsx' },
    ]);
    expect(graph.diagnostics).toHaveLength(2);
    expect(graph.diagnostics).toEqual(expect.arrayContaining([
      expect.objectContaining({ filePath: 'app/page.tsx', stage: 'import-graph', message: expect.stringContaining('./Missing') }),
    ]));
    const ir = await extractIR({ rootDir: root });
    expect(ir.framework_specific?.['import_warnings']).toEqual(graph.warnings);
    expect(ir.framework_specific?.['import_diagnostics']).toEqual(graph.diagnostics);
    expect(ir.framework_specific?.['file_ledger']).toEqual(expect.arrayContaining([
      expect.objectContaining({ file: 'app/page.tsx', status: 'failed', stages: ['import-graph'] }),
    ]));
  });

  it('follows barrel re-exports and diagnoses unresolved export targets', async () => {
    const root = await tmpProject({
      'app/page.ts': "import { value } from './barrel';",
      'app/barrel.ts': "export { value } from './leaf'; export * from './missing';",
      'app/leaf.ts': 'export const value = 1;',
    });
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.ts'] });
    expect([...(graph.edges.get('app/barrel.ts') ?? [])]).toEqual(['app/leaf.ts']);
    expect(graph.warnings).toContainEqual({ code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/barrel.ts', importPath: './missing' });
  });

  it('diagnoses dotted code stems and known baseUrl directories without package noise', async () => {
    const root = await tmpProject({
      'app/page.ts': "import value from './auth.config'; import Missing from 'components/Missing'; import external from 'react';",
      'components/Existing.ts': 'export default 1;',
    }, { compilerOptions: { baseUrl: '.' } });
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.ts'] });
    expect(graph.warnings).toEqual([
      { code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/page.ts', importPath: './auth.config' },
      { code: 'UNRESOLVED_INTERNAL_IMPORT', file: 'app/page.ts', importPath: 'components/Missing' },
    ]);
  });

  it('reports unsupported static internal dynamic imports without claiming graph coverage', async () => {
    const root = await tmpProject({
      'app/page.ts': "const child = import('./leaf'); const external = import('react');",
      'app/leaf.ts': 'export default 1;',
    });
    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.ts'] });
    expect(graph.diagnostics).toEqual([expect.objectContaining({ filePath: 'app/page.ts', stage: 'import-graph', message: expect.stringContaining('./leaf') })]);
    expect(graph.warnings).toEqual([{ code: 'UNSUPPORTED_INTERNAL_DYNAMIC_IMPORT', file: 'app/page.ts', importPath: './leaf' }]);
  });

  it('walks transitively up to maxDepth', async () => {
    const root = await tmpProject({
      'app/page.tsx': `import A from './A'; export default function P(){ return <A/>; }`,
      'app/A.tsx': `import B from './B'; export default function A(){ return <B/>; }`,
      'app/B.tsx': `import C from './C'; export default function B(){ return <C/>; }`,
      'app/C.tsx': `export default function C(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'], maxDepth: 4 });
    expect(g.edges.has('app/page.tsx')).toBe(true);
    expect(g.edges.has('app/A.tsx')).toBe(true);
    expect(g.edges.has('app/B.tsx')).toBe(true);
    expect(g.edges.has('app/C.tsx')).toBe(true);
  });

  it('respects maxDepth (stops walking past the limit)', async () => {
    const root = await tmpProject({
      'app/page.tsx': `import A from './A'; export default function P(){ return <A/>; }`,
      'app/A.tsx': `import B from './B'; export default function A(){ return <B/>; }`,
      'app/B.tsx': `export default function B(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'], maxDepth: 1 });
    expect(g.edges.has('app/page.tsx')).toBe(true);
    expect(g.edges.has('app/A.tsx')).toBe(true);
    // B was depth 2 — beyond maxDepth=1 → not walked into
    expect(g.edges.has('app/B.tsx')).toBe(false);
  });

  it('handles import cycles without infinite recursion', async () => {
    const root = await tmpProject({
      'app/page.tsx': `import A from './A'; export default function P(){ return <A/>; }`,
      'app/A.tsx': `import B from './B'; export default function A(){ return null; }`,
      'app/B.tsx': `import A from './A'; export default function B(){ return null; }`, // cycle
    });
    // Should terminate in finite time.
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'], maxDepth: 5 });
    expect(g.edges.has('app/A.tsx')).toBe(true);
    expect(g.edges.has('app/B.tsx')).toBe(true);
    // A imports B, B imports A — both edges recorded.
    expect([...(g.edges.get('app/B.tsx') ?? [])]).toContain('app/A.tsx');
  });

  it('walks from multiple entries, sharing visited state across them', async () => {
    const root = await tmpProject({
      'app/page1.tsx': `import S from './Shared'; export default function P1(){ return <S/>; }`,
      'app/page2.tsx': `import S from './Shared'; export default function P2(){ return <S/>; }`,
      'app/Shared.tsx': `export default function S(){ return null; }`,
    });
    const g = buildImportGraph({
      rootDir: root,
      entryFiles: ['app/page1.tsx', 'app/page2.tsx'],
    });
    expect([...(g.edges.get('app/page1.tsx') ?? [])]).toContain('app/Shared.tsx');
    expect([...(g.edges.get('app/page2.tsx') ?? [])]).toContain('app/Shared.tsx');
  });

  it('does not crash when an entry file is missing on disk', async () => {
    const root = await tmpProject({
      'app/exists.tsx': `export default function E(){ return null; }`,
    });
    const g = buildImportGraph({
      rootDir: root,
      entryFiles: ['app/exists.tsx', 'app/missing.tsx'],
    });
    expect(g.edges.has('app/exists.tsx')).toBe(true);
    expect(g.edges.has('app/missing.tsx')).toBe(false);
  });

  it('ignores type-only side-effect imports it can\'t resolve', async () => {
    const root = await tmpProject({
      'app/page.tsx': `
        import './nonexistent.css';
        import Button from './Button';
        export default function P(){ return <Button/>; }
      `,
      'app/Button.tsx': `export default function B(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });
    expect([...(g.edges.get('app/page.tsx') ?? [])]).toEqual(['app/Button.tsx']);
  });

  it('warns once when source imports a root public asset without failing the graph', async () => {
    const root = await tmpProject({
      'app/page.tsx': `
        import '../public/common/js/x.js';
        export default function Page(){ return null; }
      `,
      'public/common/js/x.js': 'window.example = true;\n',
      'package.json': JSON.stringify({ dependencies: { next: '15.0.0' } }),
    });

    const graph = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'] });

    expect(graph.warnings).toEqual([{
      code: 'PUBLIC_STATIC_IMPORT',
      file: 'app/page.tsx',
      importPath: '../public/common/js/x.js',
      target: 'public/common/js/x.js',
    }]);
    expect(graph.diagnostics).toEqual([]);
    expect([...(graph.edges.get('app/page.tsx') ?? [])]).not.toContain('public/common/js/x.js');

    const ir = await extractIR({ rootDir: root });
    expect(ir.framework_specific?.['import_warnings']).toEqual(graph.warnings);
    expect(ir.files).not.toContain('public/common/js/x.js');
    expect(ir.framework_specific?.['file_ledger']).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ file: 'public/common/js/x.js' })]),
    );
  });
});

describe('reachableFiles', () => {
  it('returns the BFS-reachable set from an entry, including the entry', async () => {
    const root = await tmpProject({
      'app/page.tsx': `import A from './A'; export default function P(){ return <A/>; }`,
      'app/A.tsx': `import B from './B'; export default function A(){ return <B/>; }`,
      'app/B.tsx': `export default function B(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'], maxDepth: 5 });
    const r = reachableFiles(g, 'app/page.tsx');
    expect([...r].sort()).toEqual(['app/A.tsx', 'app/B.tsx', 'app/page.tsx']);
  });

  it('returns just the entry when no edges exist', async () => {
    const g = { edges: new Map() };
    const r = reachableFiles(g, 'app/orphan.tsx');
    expect([...r]).toEqual(['app/orphan.tsx']);
  });

  it('serialize/deserialize roundtrip preserves the graph', () => {
    const original: ImportGraph = {
      edges: new Map([
        ['a.tsx', new Set(['c.tsx', 'b.tsx'])],
        ['b.tsx', new Set(['c.tsx'])],
      ]),
    };
    const data = serializeImportGraph(original);
    // Edges per file are sorted for stable diffs.
    expect(data['a.tsx']).toEqual(['b.tsx', 'c.tsx']);
    expect(data['b.tsx']).toEqual(['c.tsx']);

    const restored = deserializeImportGraph(data);
    expect([...restored.edges.get('a.tsx')!].sort()).toEqual(['b.tsx', 'c.tsx']);
    expect([...restored.edges.get('b.tsx')!].sort()).toEqual(['c.tsx']);
  });

  it('respects maxDepth in reachable BFS', async () => {
    const root = await tmpProject({
      'app/page.tsx': `import A from './A'; export default function P(){ return <A/>; }`,
      'app/A.tsx': `import B from './B'; export default function A(){ return <B/>; }`,
      'app/B.tsx': `export default function B(){ return null; }`,
    });
    const g = buildImportGraph({ rootDir: root, entryFiles: ['app/page.tsx'], maxDepth: 5 });
    const r = reachableFiles(g, 'app/page.tsx', 1);
    // page → A is depth 1; B is depth 2 → excluded.
    expect([...r].sort()).toEqual(['app/A.tsx', 'app/page.tsx']);
  });
});
