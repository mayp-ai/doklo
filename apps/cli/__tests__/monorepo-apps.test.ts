// __tests__/monorepo-apps.test.ts
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findNextjsApps } from '../src/lib/monorepo-apps.js';

function repo(files: Record<string, unknown>): string {
  const root = mkdtempSync(join(tmpdir(), 'doklo-monorepo-'));
  for (const [path, body] of Object.entries(files)) {
    const full = join(root, path);
    mkdirSync(join(full, '..'), { recursive: true });
    writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
  }
  return root;
}

const nextPkg = (name: string) => ({ name, dependencies: { next: '16.2.3' } });

describe('findNextjsApps', () => {
  it('finds a Next.js app declared through npm/yarn workspaces', () => {
    // cal.com's shape: the root has no `next`, the app does.
    const root = repo({
      'package.json': { name: 'monorepo', workspaces: ['apps/*'] },
      'apps/web/package.json': nextPkg('web'),
      'apps/web/app/page.tsx': 'export default function Page() { return null }',
    });

    expect(findNextjsApps(root)).toEqual(['apps/web']);
  });

  it('finds apps declared through pnpm-workspace.yaml', () => {
    const root = repo({
      'package.json': { name: 'monorepo' },
      'pnpm-workspace.yaml': 'packages:\n  - "apps/*"\n  - "packages/*"\n',
      'apps/web/package.json': nextPkg('web'),
      'apps/web/app/page.tsx': 'x',
    });

    expect(findNextjsApps(root)).toEqual(['apps/web']);
  });

  it('returns every Next.js app, sorted', () => {
    const root = repo({
      'package.json': { name: 'monorepo', workspaces: ['apps/*'] },
      'apps/web/package.json': nextPkg('web'),
      'apps/web/app/page.tsx': 'x',
      'apps/admin/package.json': nextPkg('admin'),
      'apps/admin/src/app/page.tsx': 'x',
    });

    expect(findNextjsApps(root)).toEqual(['apps/admin', 'apps/web']);
  });

  it('skips workspace packages that are not Next.js', () => {
    const root = repo({
      'package.json': { name: 'monorepo', workspaces: ['apps/*', 'packages/*'] },
      'apps/web/package.json': nextPkg('web'),
      'apps/web/app/page.tsx': 'x',
      'packages/ui/package.json': { name: 'ui', dependencies: { react: '19' } },
    });

    expect(findNextjsApps(root)).toEqual(['apps/web']);
  });

  it('skips a Next.js package with no app router directory', () => {
    // The adapter requires an app router; listing a pages-only app as a
    // candidate would just move the failure one command later.
    const root = repo({
      'package.json': { name: 'monorepo', workspaces: ['apps/*'] },
      'apps/legacy/package.json': nextPkg('legacy'),
      'apps/legacy/pages/index.tsx': 'x',
    });

    expect(findNextjsApps(root)).toEqual([]);
  });

  it('returns empty for a plain single-package repo', () => {
    const root = repo({ 'package.json': { name: 'solo' } });

    expect(findNextjsApps(root)).toEqual([]);
  });

  it('survives a malformed workspace package.json', () => {
    const root = repo({
      'package.json': { name: 'monorepo', workspaces: ['apps/*'] },
      'apps/broken/package.json': '{ not json',
      'apps/web/package.json': nextPkg('web'),
      'apps/web/app/page.tsx': 'x',
    });

    expect(findNextjsApps(root)).toEqual(['apps/web']);
  });

  it('never walks into node_modules', () => {
    const root = repo({
      'package.json': { name: 'monorepo', workspaces: ['*'] },
      'node_modules/some-dep/package.json': nextPkg('some-dep'),
      'node_modules/some-dep/app/page.tsx': 'x',
    });

    expect(findNextjsApps(root)).toEqual([]);
  });
});
