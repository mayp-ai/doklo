import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { extractIR, inspectNextJsSupport } from '../src/index.js';

async function fixture(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-nextjs-support-'));
  for (const [relativePath, contents] of Object.entries(files)) {
    const path = join(root, relativePath);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, contents, 'utf8');
  }
  return root;
}

describe('inspectNextJsSupport', () => {
  it('accepts a Next.js App Router project', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'src/app/page.tsx': 'export default function Page(){ return null }',
    });

    await expect(inspectNextJsSupport(root)).resolves.toMatchObject({
      framework: 'nextjs',
      router: 'app-router',
      appRoot: 'src/app',
    });
  });

  it.each([
    {
      files: {
        'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
        'pages/index.tsx': 'export default function Page(){ return null }',
      },
      reason: 'APP_ROUTER_REQUIRED',
    },
    {
      files: {
        'package.json': JSON.stringify({ dependencies: { react: '19.0.0' } }),
        'app/page.tsx': 'export default function Page(){ return null }',
      },
      reason: 'NEXT_PACKAGE_REQUIRED',
    },
  ])('rejects an unsupported project', async ({ files, reason }) => {
    const root = await fixture(files);

    await expect(inspectNextJsSupport(root)).rejects.toMatchObject({
      code: 'UNSUPPORTED_NEXTJS_PROJECT',
      details: { reason },
    });
  });

  it.each([
    { files: {}, reason: 'PACKAGE_JSON_REQUIRED' },
    { files: { 'package.json': '{not json' }, reason: 'PACKAGE_JSON_INVALID' },
    { files: { 'package.json': '[]' }, reason: 'PACKAGE_JSON_INVALID' },
  ])('normalizes an invalid package manifest', async ({ files, reason }) => {
    const root = await fixture(files);

    await expect(inspectNextJsSupport(root)).rejects.toMatchObject({
      code: 'UNSUPPORTED_NEXTJS_PROJECT',
      details: { reason, rootDir: root },
    });
  });

  it.each([42, '', '   '])('rejects an invalid next package version', async (nextVersion) => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: nextVersion } }),
      'app/page.tsx': 'export default function Page(){ return null }',
    });

    await expect(inspectNextJsSupport(root)).rejects.toMatchObject({
      code: 'UNSUPPORTED_NEXTJS_PROJECT',
      details: { reason: 'NEXT_PACKAGE_VERSION_INVALID', rootDir: root },
    });
  });
});

describe('extractIR', () => {
  it('rejects a Pages-only project before scanning', async () => {
    const root = await fixture({
      'package.json': JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'pages/index.tsx': 'export default function Page(){ return null }',
    });

    await expect(extractIR({ rootDir: root, includeImportGraph: false })).rejects.toMatchObject({
      code: 'UNSUPPORTED_NEXTJS_PROJECT',
      details: { reason: 'APP_ROUTER_REQUIRED', rootDir: root },
    });
  });
});
