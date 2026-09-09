import { describe, it, expect, vi } from 'vitest';
import { access, mkdtemp, mkdir, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ProjectIRSchema, type ProjectIR, type Workspace } from '@doklo-beta/core';
import { runScan, type ScanDeps } from '../src/commands/scan.js';

async function tmpWorkspaceWithServices(services: Workspace['services']): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-scan-'));
  // Mimic init: write workspace.json + .doklo dirs. Skip hub skeleton — scan
  // just needs the workspace + cache/.
  await mkdir(join(root, '.doklo', 'cache'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services,
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  for (const service of services) {
    if (!service.code_root.includes('..')) {
      const serviceRoot = join(root, service.code_root);
      await mkdir(serviceRoot, { recursive: true });
      if (service.framework === 'nextjs') {
        await writeFile(
          join(serviceRoot, 'package.json'),
          JSON.stringify({ dependencies: { next: '15.4.0' } }),
          'utf-8',
        );
        await mkdir(join(serviceRoot, 'app'), { recursive: true });
        await writeFile(
          join(serviceRoot, 'app/page.tsx'),
          'export default function Page(){ return null }',
          'utf-8',
        );
      }
    }
  }
  return root;
}

function makeIR(overrides: Partial<ProjectIR> = {}): ProjectIR {
  const files = overrides.files ?? ['app/page.tsx'];
  const frameworkSpecific = Object.prototype.hasOwnProperty.call(
    overrides,
    'framework_specific',
  )
    ? overrides.framework_specific
    : {
        file_ledger: files.map((file) => ({
          file,
          status: 'processed',
          stages: ['discovery', 'ast', 'routing'],
          reason: 'OK',
        })),
      };
  return ProjectIRSchema.parse({
    framework: 'nextjs',
    root: '/tmp/x',
    files,
    routes: [{ path: '/', kind: 'page', file: 'app/page.tsx' }],
    components: [],
    stores: [],
    ...overrides,
    framework_specific: frameworkSpecific,
  });
}

async function writeFixtureFiles(root: string, paths: string[]): Promise<void> {
  for (const path of paths) {
    const absolute = join(root, path);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, 'export default function Fixture() { return null; }\n');
  }
}

describe('runScan', () => {
  it('returns validated in-memory IR in previewOnly mode without creating a cache', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
    ]);
    await rm(join(root, '.doklo/cache'), { recursive: true });

    const result = await runScan(
      { root, previewOnly: true } as never,
      { extractIR: async ({ rootDir }) => makeIR({ root: rootDir }) },
    );

    expect((result.results[0] as unknown as { ir: ProjectIR }).ir.files).toEqual(['app/page.tsx']);
    await expect(readFile(join(root, '.doklo/cache/web.scan.json'), 'utf8')).rejects.toThrow();
  });

  it('writes one .scan.json per service into .doklo/cache/', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
    ]);
    await writeFixtureFiles(root, ['a.tsx', 'b.tsx', 'app/page.tsx']);

    const deps: ScanDeps = {
      extractIR: async ({ rootDir }) => makeIR({ root: rootDir, files: ['a.tsx', 'b.tsx'] }),
    };

    const result = await runScan({ root }, deps);
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.serviceId).toBe('web');

    const written = JSON.parse(
      await readFile(join(root, '.doklo/cache/web.scan.json'), 'utf-8'),
    );
    expect(ProjectIRSchema.parse(written).files).toEqual(['a.tsx', 'b.tsx']);
  });

  it('resolves each service.code_root relative to the workspace root', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'api', type: 'backend', framework: 'nextjs', code_root: 'packages/api' },
    ]);
    await writeFixtureFiles(root, ['packages/api/app/page.tsx']);

    const seen: string[] = [];
    await runScan(
      { root },
      {
        extractIR: async ({ rootDir }) => {
          seen.push(rootDir);
          return makeIR({ root: rootDir });
        },
      },
    );
    expect(seen).toEqual([join(await realpath(root), 'packages/api')]);
  });

  it('scans every nextjs service in the workspace', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
      { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
    ]);
    await writeFixtureFiles(root, [
      'apps/web/app/page.tsx',
      'apps/admin/app/page.tsx',
    ]);

    const result = await runScan(
      { root },
      { extractIR: async ({ rootDir }) => makeIR({ root: rootDir }) },
    );

    expect(result.results.map((r) => r.serviceId).sort()).toEqual(['admin', 'web']);
  });

  it('rejects a declared non-Next service before extraction or cache writes', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'mobile', type: 'mobile', framework: 'react-native', code_root: '.' },
    ]);
    await writeFile(
      join(root, 'package.json'),
      JSON.stringify({ dependencies: { next: '15.4.0' } }),
      'utf-8',
    );
    await mkdir(join(root, 'app'), { recursive: true });
    await writeFile(
      join(root, 'app/page.tsx'),
      'export default function Page(){ return null }',
      'utf-8',
    );
    const extractIR = vi.fn(async ({ rootDir }: { rootDir: string }) => makeIR({ root: rootDir }));

    await expect(runScan({ root }, { extractIR })).rejects.toMatchObject({
      code: 'UNSUPPORTED_FRAMEWORK',
      details: { framework: 'react-native' },
    });
    expect(extractIR).not.toHaveBeenCalled();
    await expect(readFile(join(root, '.doklo/cache/mobile.scan.json'), 'utf-8')).rejects.toThrow();
  });

  it('returns counts (routes, components, stores) for each scanned service', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
    ]);
    await writeFixtureFiles(root, [
      'app/page.tsx',
      'app/about/page.tsx',
      'components/Button.tsx',
    ]);

    const result = await runScan(
      { root },
      {
        extractIR: async () =>
          makeIR({
            routes: [
              { path: '/', kind: 'page', file: 'app/page.tsx' },
              { path: '/about', kind: 'page', file: 'app/about/page.tsx' },
            ],
            components: [{ name: 'Button', file: 'components/Button.tsx', kind: 'component' }],
            stores: [],
          }),
      },
    );
    expect(result.results[0]?.counts).toEqual({ routes: 2, components: 1, stores: 0 });
  });

  it('scans only the explicitly selected service', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
      { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
    ]);
    await writeFixtureFiles(root, ['apps/admin/app/page.tsx']);
    const seen: string[] = [];

    const result = await runScan(
      { root, serviceId: 'admin' },
      {
        extractIR: async ({ rootDir }) => {
          seen.push(rootDir);
          return makeIR({ root: rootDir });
        },
      },
    );

    expect(seen).toEqual([join(await realpath(root), 'apps/admin')]);
    expect(result.results.map((entry) => entry.serviceId)).toEqual(['admin']);
  });

  it('rejects an unknown explicitly selected service with its id in the error', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
    ]);

    await expect(
      runScan(
        { root, serviceId: 'missing' },
        { extractIR: async ({ rootDir }) => makeIR({ root: rootDir }) },
      ),
    ).rejects.toThrow(/missing.*service|service.*missing/i);
  });

  it('rejects a code_root symlink outside the workspace before invoking the adapter', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'service' },
    ]);
    const outside = await mkdtemp(join(tmpdir(), 'doklo-scan-outside-'));
    await rm(join(root, 'service'), { recursive: true });
    await symlink(outside, join(root, 'service'));
    const extractIR = vi.fn(async ({ rootDir }: { rootDir: string }) => makeIR({ root: rootDir }));

    await expect(runScan({ root }, { extractIR })).rejects.toThrow(/outside|contain|root/i);

    expect(extractIR).not.toHaveBeenCalled();
  });

  it('validates every adapter IR before writing any service scan cache', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
      { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
    ]);
    const outside = await mkdtemp(join(tmpdir(), 'doklo-scan-ir-outside-'));
    await writeFixtureFiles(root, ['apps/web/app/page.tsx']);
    await writeFile(join(outside, 'secret.ts'), 'export const secret = true;\n', 'utf-8');
    await symlink(outside, join(root, 'apps/admin/link'));

    await expect(runScan(
      { root },
      {
        extractIR: async ({ rootDir }) => rootDir.endsWith('/apps/admin')
          ? makeIR({ root: rootDir, files: ['link/secret.ts'], routes: [] })
          : makeIR({ root: rootDir }),
      },
    )).rejects.toThrow(/outside|contain|root/i);

    await expect(readFile(join(root, '.doklo/cache/web.scan.json'), 'utf-8')).rejects.toThrow();
    await expect(readFile(join(root, '.doklo/cache/admin.scan.json'), 'utf-8')).rejects.toThrow();
  });

  it('reports each failed ledger entry and preserves the previous scan cache', async () => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
    ]);
    await writeFile(
      join(root, 'apps/web/app/broken.tsx'),
      "export default function Broken() { $('html').addClass(ENABLED)) }\n",
      'utf8',
    );

    const existingCachePath = join(root, '.doklo/cache/web.scan.json');
    const untouchedCacheBytes = '{"trusted":"previous scan"}\n';
    await writeFile(existingCachePath, untouchedCacheBytes, 'utf8');

    await expect(runScan({ root })).rejects.toMatchObject({
      code: 'PARSER_LEDGER_INCOMPLETE',
      details: {
        serviceId: 'web',
        failedFiles: ['app/broken.tsx'],
        failures: [{
          file: 'app/broken.tsx',
          stages: ['ast'],
          reason: expect.stringMatching(/^TS\d+ \d+:\d+ /),
          diagnosticCount: expect.any(Number),
        }],
        preserved: [existingCachePath],
        nextCommand: 'doklo scan --service web',
      },
    });
    expect(await readFile(existingCachePath, 'utf8')).toBe(untouchedCacheBytes);
    await expect(access(join(root, '.doklo/cache/admin.scan.json'))).rejects.toMatchObject({
      code: 'ENOENT',
    });
  });

  it.each([
    ['missing', {}],
    ['non-array', { file_ledger: { file: 'app/page.tsx' } }],
    ['incomplete', { file_ledger: [] }],
    [
      'duplicated',
      {
        file_ledger: [
          {
            file: 'app/page.tsx',
            status: 'processed',
            stages: ['discovery', 'ast', 'routing'],
            reason: 'OK',
          },
          {
            file: 'app/page.tsx',
            status: 'processed',
            stages: ['discovery', 'ast', 'routing'],
            reason: 'OK',
          },
        ],
      },
    ],
    [
      'malformed',
      {
        file_ledger: [
          {
            file: 'app/page.tsx',
            status: 'processed',
            stages: ['not-a-parser-stage'],
            reason: 'OK',
          },
        ],
      },
    ],
  ])('rejects a %s parser ledger without changing any service cache', async (_, frameworkSpecific) => {
    const root = await tmpWorkspaceWithServices([
      { service_id: 'admin', type: 'admin', framework: 'nextjs', code_root: 'apps/admin' },
      { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
    ]);
    const adminCachePath = join(root, '.doklo/cache/admin.scan.json');
    const webCachePath = join(root, '.doklo/cache/web.scan.json');
    const adminCacheBytes = '{"trusted":"admin previous scan"}\n';
    const webCacheBytes = '{"trusted":"web previous scan"}\n';
    await writeFile(adminCachePath, adminCacheBytes, 'utf8');
    await writeFile(webCachePath, webCacheBytes, 'utf8');

    await expect(runScan(
      { root },
      {
        extractIR: async ({ rootDir }) => rootDir.endsWith('/apps/web')
          ? makeIR({ root: rootDir, framework_specific: frameworkSpecific })
          : makeIR({ root: rootDir }),
      },
    )).rejects.toMatchObject({
      code: 'PARSER_LEDGER_INCOMPLETE',
      details: { serviceId: 'web', preserved: [webCachePath] },
    });

    expect(await readFile(adminCachePath, 'utf8')).toBe(adminCacheBytes);
    expect(await readFile(webCachePath, 'utf8')).toBe(webCacheBytes);
  });
});
