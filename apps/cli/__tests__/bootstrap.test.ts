import { describe, it, expect } from 'vitest';
import { mkdtemp, readFile, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WorkspaceSchema, RolesFileSchema, LexiconFileSchema } from '@doklo-beta/core';
import { bootstrapWorkspace, WorkspaceAlreadyInitializedError } from '../src/lib/bootstrap.js';

async function emptyDir(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'doklo-bs-'));
}

const sampleService = {
  service_id: 'web' as const,
  type: 'frontend' as const,
  framework: 'nextjs' as const,
  code_root: '.',
  description: 'Next.js single-codebase web app',
};

describe('bootstrapWorkspace', () => {
  it('writes a workspace.json that validates against WorkspaceSchema', async () => {
    const root = await emptyDir();
    await bootstrapWorkspace({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en', 'ko'],
      services: [sampleService],
    });

    const raw = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf-8'));
    const parsed = WorkspaceSchema.parse(raw);
    expect(parsed.workspace_id).toBe('demo');
    expect(parsed.services[0]?.framework).toBe('nextjs');
    expect(parsed.default_locale).toBe('en');
    expect(parsed.supported_locales).toEqual(['en', 'ko']);
  });

  it('creates the .doklo/hub skeleton (doks/, services/<id>/, debug/, cache/)', async () => {
    const root = await emptyDir();
    await bootstrapWorkspace({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      services: [sampleService],
    });

    const dirs = [
      '.doklo/hub/doks',
      '.doklo/hub/services/web',
      '.doklo/cache',
      '.doklo/debug',
    ];
    for (const d of dirs) {
      const s = await stat(join(root, d));
      expect(s.isDirectory(), `${d} should exist`).toBe(true);
    }
  });

  it('writes empty roles.json + lexicon.json that validate against schemas', async () => {
    const root = await emptyDir();
    await bootstrapWorkspace({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      services: [sampleService],
    });

    const roles = JSON.parse(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8'));
    const lex = JSON.parse(await readFile(join(root, '.doklo/hub/lexicon.json'), 'utf-8'));

    expect(RolesFileSchema.parse(roles).roles).toEqual([]);
    expect(LexiconFileSchema.parse(lex).terms).toEqual([]);
  });

  it('refuses to overwrite an existing workspace.json', async () => {
    const root = await emptyDir();
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({ workspace_id: 'pre-existing', name: 'X', services: [] }),
      'utf-8',
    );

    await expect(
      bootstrapWorkspace({
        root,
        workspaceId: 'demo',
        name: 'Demo',
        defaultLocale: 'en',
        supportedLocales: ['en'],
        services: [sampleService],
      }),
    ).rejects.toThrowError(WorkspaceAlreadyInitializedError);
  });

  it('stamps created_at + updated_at on the workspace', async () => {
    const root = await emptyDir();
    await bootstrapWorkspace({
      root,
      workspaceId: 'demo',
      name: 'Demo',
      defaultLocale: 'en',
      supportedLocales: ['en'],
      services: [sampleService],
    });
    const raw = JSON.parse(await readFile(join(root, 'workspace.json'), 'utf-8'));
    expect(raw.created_at).toBeTruthy();
    expect(raw.updated_at).toBeTruthy();
    // ISO 8601 — Date.parse should not return NaN
    expect(Number.isNaN(Date.parse(raw.created_at))).toBe(false);
  });
});
