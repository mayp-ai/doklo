import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { buildImportGraph, reachableFiles } from '../src/import-graph.js';

const roots: string[] = [];
async function fixture(files: Record<string, string>) {
  const root = await mkdtemp(join(tmpdir(), 'doklo-context-')); roots.push(root);
  for (const [file, content] of Object.entries(files)) {
    await mkdir(dirname(join(root, file)), { recursive: true });
    await writeFile(join(root, file), content);
  }
  return root;
}
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });

it('imports helper behavior without attributing the exporting screen or its unrelated dependencies', async () => {
  const root = await fixture({
    'ChildRecordsPage.tsx': "import { completedMonths as age } from './ChatPage';\nexport function ChildRecordsPage() { return <div>{age(12)}</div>; }",
    'ChatPage.tsx': "import { monthSize } from './calendar';\nimport { uploadPhoto } from './photos';\nconst scale = monthSize;\nexport function completedMonths(days: number) { return Math.floor(days / scale); }\nexport function ChatPage() { return <button onClick={uploadPhoto}>Retry chat</button>; }",
    'calendar.ts': 'export const monthSize = 30;',
    'photos.ts': 'export function uploadPhoto() { return "photo attachment"; }',
  });
  const graph = buildImportGraph({ rootDir: root, entryFiles: ['ChildRecordsPage.tsx'] });
  expect([...reachableFiles(graph, 'ChildRecordsPage.tsx')]).toContain('photos.ts');
  const context = graph.contextByEntry?.['ChildRecordsPage.tsx'];
  expect(context).toBeDefined();
  const rendered = await Promise.all(context!.map(async item => {
    const lines = (await readFile(join(root, item.file), 'utf8')).split('\n');
    return item.ranges.map(range => lines.slice(range.start - 1, range.end).join('\n')).join('\n');
  }));
  expect(rendered.join('\n')).toContain('Math.floor(days / scale)');
  expect(rendered.join('\n')).toContain('monthSize = 30');
  expect(rendered.join('\n')).not.toContain('Retry chat');
  expect(rendered.join('\n')).not.toContain('photo attachment');
  expect(context?.find(item => item.file === 'ChatPage.tsx')).toMatchObject({ kind: 'imported-symbol', symbols: ['completedMonths'], ranges: [{ start: 1, end: 1 }, { start: 3, end: 4 }] });
});

it('retains used shared components through aliased barrel exports without unrelated screens', async () => {
  const root = await fixture({
    'page.tsx': "import { Widget as Shared } from './barrel';\nexport default () => <Shared/>;",
    'barrel.ts': "export { default as Widget } from './widget';\nexport { ChatPage } from './chat';",
    'widget.tsx': "import { format } from './format';\nexport default function Widget() { return <div>{format('shared behavior')}</div>; }",
    'format.ts': 'export function format(value: string) { return value.toUpperCase(); }',
    'chat.tsx': 'export function ChatPage() { return <div>Unrelated chat</div>; }',
  });
  const graph = buildImportGraph({ rootDir: root, entryFiles: ['page.tsx'] });
  const context = graph.contextByEntry!['page.tsx']!;
  expect(context.map(item => item.file)).toEqual(expect.arrayContaining(['page.tsx', 'barrel.ts', 'widget.tsx', 'format.ts']));
  expect(context.map(item => item.file)).not.toContain('chat.tsx');
  expect(context.find(item => item.file === 'barrel.ts')?.ranges).toEqual([{ start: 1, end: 1 }]);
});

it('retains namespace-import behavior and terminates a shared helper cycle', async () => {
  const root = await fixture({
    'page.ts': "import * as tools from './tools';\nexport const run = () => tools.a();",
    'tools.ts': "import { b } from './other';\nexport function a() { return b(); }",
    'other.ts': "import { a } from './tools';\nexport function b() { return a(); }",
  });
  const context = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!;
  expect(context.map(item => item.file).sort()).toEqual(['other.ts', 'page.ts', 'tools.ts']);
  expect(context.find(item => item.file === 'tools.ts')?.kind).toBe('module');
});

it('bounds a helper precisely when an unrelated screen is declared on the same line', async () => {
  const root = await fixture({
    'page.ts': "import { age } from './mixed';\nexport const childAge = age();",
    'mixed.tsx': 'export const age = () => 12; export const ChatPage = () => <div>Retry chat</div>;',
  });
  const context = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!;
  const slice = context.find(item => item.file === 'mixed.tsx')!;
  const line = await readFile(join(root, 'mixed.tsx'), 'utf8');
  const range = slice.ranges[0]!;
  expect(line.slice((range.startColumn ?? 1) - 1, range.endColumn ? range.endColumn - 1 : undefined)).toBe('export const age = () => 12;');
});

it('slices only the requested variable in a declaration with multiple exports', async () => {
  const root = await fixture({
    'page.ts': "import { age } from './mixed';\nexport const childAge = age();",
    'mixed.tsx': 'export const age = () => 12, ChatPage = () => <div>Retry chat</div>;',
  });
  const context = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!;
  const slice = context.find(item => item.file === 'mixed.tsx')!;
  const line = await readFile(join(root, 'mixed.tsx'), 'utf8');
  const range = slice.ranges[0]!;
  expect(line.slice((range.startColumn ?? 1) - 1, range.endColumn ? range.endColumn - 1 : undefined)).toBe('age = () => 12');
});

it('retains imported-module initialization and side-effect imports without unrelated screen declarations', async () => {
  const root = await fixture({
    'page.ts': "import { submit } from './actions';\nexport const send = () => submit();",
    'actions.ts': "import './register';\nlet ready = false;\nfunction initialize() { ready = true; }\ninitialize();\nexport function submit() { return ready; }\nexport function UnrelatedScreen() { return 'unrelated screen'; }",
    'register.ts': "globalThis.registrationReady = true;\nexport function OtherScreen() { return 'other screen'; }",
  });
  const context = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!;
  const excerpts = await Promise.all(context.map(async item => {
    const lines = (await readFile(join(root, item.file), 'utf8')).split('\n');
    return item.ranges.map(range => lines.slice(range.start - 1, range.end).join('\n')).join('\n');
  }));
  expect(excerpts.join('\n')).toContain('initialize();');
  expect(excerpts.join('\n')).toContain('ready = true');
  expect(excerpts.join('\n')).toContain('globalThis.registrationReady = true');
  expect(excerpts.join('\n')).not.toContain('unrelated screen');
  expect(excerpts.join('\n')).not.toContain('other screen');
});

it.each(['', '\uFEFF'])('binds every range to the full UTF-8 source identity, including declarations outside the slice (%j)', async (bom) => {
  const { createHash } = await import('node:crypto');
  const source = bom + 'export function age() { return 12; }\nexport const unused = "아이";\n';
  const root = await fixture({ 'page.ts': "import { age } from './shared';", 'shared.ts': source });
  const context = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!;
  expect(context.find(item => item.file === 'shared.ts')?.content_hash).toBe(createHash('sha256').update(source, 'utf8').digest('hex'));
  for (const item of context) expect(item.content_hash).toMatch(/^[a-f0-9]{64}$/);
});

it('retains executing initializers but does not execute deferred default or object-method screen bodies', async () => {
  const root = await fixture({
    'page.ts': "import { submit } from './actions';\nexport const send = () => submit();",
    'actions.tsx': "function register() { globalThis.ready = true; }\nconst registration = register();\nexport function submit() { return globalThis.ready; }\nexport default () => <div>Unrelated default screen</div>;\nexport const screens = { chat() { return fetch('unrelated-screen'); } };",
  });
  const context = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!;
  const item = context.find(item => item.file === 'actions.tsx')!;
  const lines = (await readFile(join(root, item.file), 'utf8')).split('\n');
  const excerpt = item.ranges.map(range => lines.slice(range.start - 1, range.end).join('\n')).join('\n');
  expect(excerpt).toContain('const registration = register();');
  expect(excerpt).toContain('globalThis.ready = true');
  expect(excerpt).not.toContain('Unrelated default screen');
  expect(excerpt).not.toContain('unrelated-screen');
});

it('does not attribute runtime initialization reached only by type-only named imports', async () => {
  const root = await fixture({
    'page.ts': "import { type User } from './types';\nexport const greet = (user: User) => user.name;",
    'types.ts': "export type User = { name: string };\nglobalThis.unrelatedInitialization = true;",
  });
  const item = buildImportGraph({ rootDir: root, entryFiles: ['page.ts'] }).contextByEntry!['page.ts']!.find(item => item.file === 'types.ts')!;
  expect(item.ranges).toEqual([{ start: 1, end: 1 }]);
});
