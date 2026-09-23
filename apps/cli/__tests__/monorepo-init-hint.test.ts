// __tests__/monorepo-init-hint.test.ts
//
// A monorepo root is now admitted through generic analysis. Legacy error
// formatting remains available for compatibility.
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { runInit } from '../src/commands/init.js';
import { UnsupportedFrameworkError } from '../src/lib/runtime-support.js';

function write(root: string, path: string, body: unknown): void {
  const full = join(root, path);
  mkdirSync(join(full, '..'), { recursive: true });
  writeFileSync(full, typeof body === 'string' ? body : JSON.stringify(body));
}

function monorepo(): string {
  const root = mkdtempSync(join(tmpdir(), 'doklo-mono-init-'));
  write(root, 'package.json', { name: 'monorepo', workspaces: ['apps/*'] });
  write(root, 'apps/web/package.json', { name: 'web', dependencies: { next: '16.2.3' } });
  write(root, 'apps/web/app/page.tsx', 'export default function Page() { return null }');
  return root;
}

const initArgs = (root: string) => ({
  root,
  workspaceId: 'mono',
  name: 'Mono',
  defaultLocale: 'en' as const,
  supportedLocales: ['en'],
  serviceId: 'web',
});

describe('UnsupportedFrameworkError', () => {
  it('uses the general unsupported-framework guidance when no apps were found', () => {
    const error = new UnsupportedFrameworkError('unknown');

    expect(error.message).toContain('Next.js (App Router) projects only');
    expect(error.details.monorepoApps).toEqual([]);
  });

  it('names the discovered apps and how to target one', () => {
    const error = new UnsupportedFrameworkError('unknown', ['apps/web', 'apps/admin']);

    expect(error.message).toContain('apps/web');
    expect(error.message).toContain('apps/admin');
    expect(error.message).toContain('--root apps/web');
    expect(error.details.monorepoApps).toEqual(['apps/web', 'apps/admin']);
  });
});

describe('runInit in a monorepo root', () => {
  it.each(['unknown', 'react-native'] as const)('initializes the entire root with %s metadata', async framework => {
    const root = monorepo();
    await expect(runInit({ ...initArgs(root), framework })).resolves.toMatchObject({ framework });
    await access(join(root, '.doklo'));
  });
});
