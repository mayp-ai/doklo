import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { actorLabel, RolesFileSchema } from '@doklo-beta/core';
import {
  InvalidRolesFileError,
  mergeRolesFile,
  RolesServiceNotFoundError,
  runRolesRefresh,
  ScanCacheMissingError,
} from '../src/commands/roles.js';

async function tmpInit(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-roles-'));
  await mkdir(join(root, '.doklo', 'hub'), { recursive: true });
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  await writeFile(
    join(root, '.doklo/hub/roles.json'),
    JSON.stringify({ roles: [], version: 1 }),
    'utf-8',
  );
  return root;
}

async function writeAdminScan(root: string): Promise<void> {
  for (const source of [
    'app/admin/users/page.tsx',
    'app/admin/data/page.tsx',
    'app/admin/banner/page.tsx',
  ]) {
    const absolute = join(root, source);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, 'export default function Page() { return null; }\n');
  }
  await writeFile(
    join(root, '.doklo/cache/web.scan.json'),
    JSON.stringify({
      framework: 'nextjs',
      root,
      files: [],
      routes: [
        { path: '/admin/users', kind: 'page', file: 'app/admin/users/page.tsx', dynamic_params: [], layout_chain: [] },
        { path: '/admin/data', kind: 'page', file: 'app/admin/data/page.tsx', dynamic_params: [], layout_chain: [] },
        { path: '/admin/banner', kind: 'page', file: 'app/admin/banner/page.tsx', dynamic_params: [], layout_chain: [] },
      ],
      components: [],
      stores: [],
    }),
    'utf-8',
  );
}

describe('mergeRolesFile', () => {
  it('preserves curated roles and appends new candidates with extraction metadata', () => {
    const existing = RolesFileSchema.parse({
      roles: [{ role_id: 'ROLE-ADMIN', name: 'Curated admin', kind: 'access' }],
      version: 1,
    });

    const merged = mergeRolesFile(existing, [
      {
        role_id: 'ROLE-ADMIN',
        name: 'Generated admin',
        kind: 'access',
        confidence: 'high',
        evidence: ['x'],
      },
      {
        role_id: 'ROLE-MENTOR',
        name: 'Mentor',
        kind: 'actor_type',
        confidence: 'high',
        evidence: ['y'],
      },
    ]);

    expect(merged.file.roles[0]?.name).toBe('Curated admin');
    expect(merged.file.roles[1]).toMatchObject({
      role_id: 'ROLE-MENTOR',
      kind: 'actor_type',
      description: 'Auto-extracted from code (high confidence)',
      extends: [],
      scope: 'global',
      _meta: { extraction: { confidence: 'high', evidence: ['y'] } },
    });
    expect(merged.added).toEqual(['ROLE-MENTOR']);
    expect(merged.kept).toEqual(['ROLE-ADMIN']);
    expect(merged.changed).toBe(true);
  });

  it('reports a semantic no-op when every candidate already exists', () => {
    const existing = RolesFileSchema.parse({
      roles: [{ role_id: 'ROLE-ADMIN', name: 'Curated admin', kind: 'access' }],
      version: 1,
      updated_at: '2026-07-15T00:00:00.000Z',
    });

    const merged = mergeRolesFile(existing, [
      {
        role_id: 'ROLE-ADMIN',
        name: 'Generated admin',
        kind: 'access',
        confidence: 'high',
        evidence: ['x'],
      },
    ]);

    expect(merged.file).toEqual(existing);
    expect(merged.added).toEqual([]);
    expect(merged.kept).toEqual(['ROLE-ADMIN']);
    expect(merged.changed).toBe(false);
  });
});

describe('workspace role display locale', () => {
  it.each([
    ['en', 'User', 'Administrator'],
    ['ko', '사용자', '관리자'],
  ])('seeds %s display names without changing role references', async (locale, userName, adminName) => {
    const root = await tmpInit();
    const workspacePath = join(root, 'workspace.json');
    const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
    await writeFile(workspacePath, JSON.stringify({ ...workspace, default_locale: locale }));
    await writeAdminScan(root);

    const result = await runRolesRefresh({ root, apply: true });
    const roles = RolesFileSchema.parse(JSON.parse(await readFile(join(root, '.doklo/hub/roles.json'), 'utf8')));
    expect(roles.roles.map(role => [role.role_id, role.name])).toEqual([
      ['ROLE-ADMIN', adminName], ['ROLE-USER', userName],
    ]);
    expect(result.candidates.find(role => role.role_id === 'ROLE-USER')?.name).toBe(userName);
    expect(actorLabel({ kind: 'role', role_ref: 'ROLE-USER' }, {
      locale, primaryLocale: locale, lexicon: { terms: [], version: 1 }, roles,
    }).text).toBe(userName);
  });

  it('preserves a curated Korean role name, relationships, and evidence when refreshing', async () => {
    const root = await tmpInit();
    const workspacePath = join(root, 'workspace.json');
    const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
    await writeFile(workspacePath, JSON.stringify({ ...workspace, default_locale: 'ko' }));
    await writeAdminScan(root);
    const curated = { role_id: 'ROLE-ADMIN', name: '운영 담당자', kind: 'access', extends: ['ROLE-USER'], scope: 'global', description: '직접 검토한 이름' };
    await writeFile(join(root, '.doklo/hub/roles.json'), JSON.stringify({ roles: [curated], version: 1 }));
    await runRolesRefresh({ root, apply: true });
    const roles = JSON.parse(await readFile(join(root, '.doklo/hub/roles.json'), 'utf8')).roles;
    expect(roles.find((role: { role_id: string }) => role.role_id === 'ROLE-ADMIN')).toMatchObject(curated);
    expect(roles.find((role: { role_id: string }) => role.role_id === 'ROLE-USER').name).toBe('사용자');
    expect(roles.map((role: { role_id: string }) => role.role_id).sort()).toEqual(['ROLE-ADMIN', 'ROLE-USER']);
  });
});

describe('runRolesRefresh', () => {
  it('throws ScanCacheMissingError when no service has a scan', async () => {
    const root = await tmpInit();
    await expect(runRolesRefresh({ root, apply: true })).rejects.toThrowError(
      ScanCacheMissingError,
    );
  });

  it('returns candidates without writing when apply=false', async () => {
    const root = await tmpInit();
    await writeAdminScan(root);

    const result = await runRolesRefresh({ root, apply: false });
    const ids = result.candidates.map((c) => c.role_id).sort();
    expect(ids).toEqual(['ROLE-ADMIN', 'ROLE-USER']);

    // roles.json must be untouched (still empty).
    const raw = JSON.parse(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8'));
    expect(raw.roles).toEqual([]);
    expect(result.written).toBe(false);
  });

  it('writes a schema-valid roles.json when apply=true', async () => {
    const root = await tmpInit();
    await writeAdminScan(root);

    const result = await runRolesRefresh({ root, apply: true });
    expect(result.written).toBe(true);

    const contents = await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8');
    const raw = JSON.parse(contents);
    const parsed = RolesFileSchema.parse(raw);
    expect(parsed.roles.map((r) => r.role_id).sort()).toEqual(['ROLE-ADMIN', 'ROLE-USER']);
    expect(result.added.sort()).toEqual(['ROLE-ADMIN', 'ROLE-USER']);
    expect(result.kept).toEqual([]);
    expect(contents).toBe(`${JSON.stringify(parsed, null, 2)}\n`);
  });

  it('does not rewrite roles.json when a second apply is a semantic no-op', async () => {
    const root = await tmpInit();
    await writeAdminScan(root);

    const first = await runRolesRefresh({ root, apply: true });
    const rolesPath = join(root, '.doklo/hub/roles.json');
    const before = await readFile(rolesPath);
    const second = await runRolesRefresh({ root, apply: true });
    const after = await readFile(rolesPath);

    expect(first.written).toBe(true);
    expect(second.written).toBe(false);
    expect(after).toEqual(before);
  });

  it.each([
    ['schema-invalid JSON', `${JSON.stringify({ bad: true })}\n`],
    ['unparseable JSON', '{ bad json\n'],
  ])('rejects %s without changing its bytes', async (_label, invalidContents) => {
    const root = await tmpInit();
    await writeAdminScan(root);
    const rolesPath = join(root, '.doklo/hub/roles.json');
    await writeFile(rolesPath, invalidContents, 'utf-8');
    const before = await readFile(rolesPath);

    await expect(runRolesRefresh({ root, apply: true })).rejects.toThrowError(
      InvalidRolesFileError,
    );

    expect(await readFile(rolesPath)).toEqual(before);
  });

  it('creates a missing roles parent directory before the first actual write', async () => {
    const root = await tmpInit();
    await writeAdminScan(root);
    await rm(join(root, '.doklo', 'hub'), { recursive: true });

    const result = await runRolesRefresh({ root, apply: true });
    const contents = await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8');

    expect(result.written).toBe(true);
    expect(contents.endsWith('\n')).toBe(true);
    expect(RolesFileSchema.parse(JSON.parse(contents)).roles).toHaveLength(2);
  });

  it('preserves existing role entries (user edits never overwritten)', async () => {
    const root = await tmpInit();
    await writeAdminScan(root);

    // Pre-populate roles.json with a customized entry.
    await writeFile(
      join(root, '.doklo/hub/roles.json'),
      JSON.stringify({
        roles: [
          {
            role_id: 'ROLE-USER',
            name: '사용자',
            description: 'Custom user description',
            extends: [],
            scope: 'global',
          },
        ],
        version: 1,
      }),
      'utf-8',
    );

    const result = await runRolesRefresh({ root, apply: true });
    const raw = JSON.parse(await readFile(join(root, '.doklo/hub/roles.json'), 'utf-8'));
    const user = raw.roles.find((r: { role_id: string }) => r.role_id === 'ROLE-USER');
    expect(user.name).toBe('사용자');
    expect(user.description).toBe('Custom user description');

    expect(result.kept).toContain('ROLE-USER');
    expect(result.added).toContain('ROLE-ADMIN');
    expect(result.added).not.toContain('ROLE-USER');
  });

  it('limits to a specific service when serviceId is set', async () => {
    const root = await tmpInit();
    // Write workspace with two services, one scan cache.
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
          { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeAdminScan(root);
    // No scan cache for "admin" service.

    const result = await runRolesRefresh({ root, apply: false, serviceId: 'web' });
    expect(result.candidates.length).toBeGreaterThan(0);
    expect(result.skipped).toEqual([]);
  });

  it('distinguishes an unknown service from a missing scan cache', async () => {
    const root = await tmpInit();

    await expect(
      runRolesRefresh({ root, apply: false, serviceId: 'missing' }),
    ).rejects.toBeInstanceOf(RolesServiceNotFoundError);
  });

  it('reports services without a scan cache in result.skipped (no throw)', async () => {
    const root = await tmpInit();
    // Two services declared; only one has a scan cache.
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
          { service_id: 'api', type: 'backend', framework: 'nextjs', code_root: 'apps/api' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    await writeAdminScan(root);

    const result = await runRolesRefresh({ root, apply: false });
    expect(result.skipped.map((s) => s.serviceId)).toEqual(['api']);
  });

  it('merges duplicate candidates across services with deterministic evidence', async () => {
    const root = await tmpInit();
    await mkdir(join(root, 'apps/api'), { recursive: true });
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({
        workspace_id: 'demo',
        name: 'Demo',
        services: [
          { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
          { service_id: 'api', type: 'backend', framework: 'nextjs', code_root: 'apps/api' },
        ],
        default_locale: 'en',
        supported_locales: ['en'],
      }),
      'utf-8',
    );
    for (const [serviceId, roleSignal] of [
      [
        'web',
        {
          value: 'mentor',
          kind: 'actor_type',
          source: 'explicit',
          file: 'web.ts',
          line: 1,
          detector: 'identity-union',
        },
      ],
      [
        'api',
        {
          value: 'mentor',
          kind: 'actor_type',
          source: 'middleware',
          file: 'api.ts',
          line: 2,
          detector: 'auth-comparison',
        },
      ],
    ] as const) {
      const sourcePath = serviceId === 'web'
        ? join(root, 'web.ts')
        : join(root, 'apps/api/api.ts');
      await writeFile(sourcePath, 'export const mentor = true;\n');
      await writeFile(
        join(root, `.doklo/cache/${serviceId}.scan.json`),
        JSON.stringify({
          framework: 'nextjs',
          root,
          files: [],
          routes: [],
          components: [],
          stores: [],
          role_signals: [roleSignal],
        }),
        'utf-8',
      );
    }

    const result = await runRolesRefresh({ root, apply: false });
    const mentor = result.candidates.find((candidate) => candidate.role_id === 'ROLE-MENTOR');

    expect(mentor).toMatchObject({
      kind: 'actor_type',
      confidence: 'high',
      evidence: [
        'api.ts:2 — auth-comparison (middleware)',
        'web.ts:1 — identity-union (explicit)',
      ],
    });
  });
});
