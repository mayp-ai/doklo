import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execa } from 'execa';
import { describe, expect, it } from 'vitest';
import { computeLogicHash } from '@doklo-beta/core';

const here = dirname(fileURLToPath(import.meta.url));
const cliRoot = join(here, '..');

async function showWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-main-boundary-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'src/auth.ts'), 'export const auth = "changed";');
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [
        { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
      ],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
  );
  await writeFile(
    join(root, '.doklo/hub/doks/AUTH.json'),
    JSON.stringify({
      dok_id: 'AUTH',
      name: 'Sign in',
      status: 'active',
      tags: ['auth'],
      surfaces: ['web'],
      description: 'A test Dok rendered through the real CLI main boundary.',
      user_actions: {
        steps: [
          {
            order: 1,
            actor: { kind: 'system' },
            intent: 'Render sign-in',
            outcome: 'Sign-in is visible',
            variants: [{ platform: 'all', interaction: 'auto' }],
          },
        ],
      },
      business_rules: { rules: [] },
      acceptance_criteria: { criteria: [] },
      _meta: {
        // This fixture models a trusted generated document whose source changed.
        tracking_version: 2,
        source_anchors: [{ file: 'src/auth.ts' }],
        logic_hash: computeLogicHash([
          { file: 'src/auth.ts', content: 'export const auth = "original";' },
        ]),
      },
    }),
  );
  return root;
}

describe('CLI main result boundary', () => {
  it('turns show --json into exactly one terminal JSONL result envelope', async () => {
    const root = await showWorkspace();
    const child = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'show', 'AUTH', '--root', root, '--json'],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode, child.stderr || child.stdout).toBe(0);
    expect(child.stderr).toBe('');
    const lines = child.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      stage: 'result',
      result: {
        schema_version: 1,
        command: 'show',
        status: 'success',
        data: { dok_id: 'AUTH', name: 'Sign in' },
        diagnostics: [],
      },
    });
  }, 30_000);

  it('labels evaluate as a structural score and prints separate review signals', async () => {
    const root = await showWorkspace();
    const child = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'evaluate', '--root', root],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode, child.stderr || child.stdout).toBe(0);
    expect(child.stderr).toBe('');
    expect(child.stdout).toContain('Structural score:');
    expect(child.stdout).toContain('Recorded review signals:');
    expect(child.stdout).toContain('recorded metadata and may predate manual prose edits');
    expect(child.stdout).toContain('content review missing: 1');
    expect(child.stdout).toContain('Current lifecycle:');
    expect(child.stdout).toContain('active 1');
    expect(child.stdout).toContain('This score is not content approval.');
  }, 30_000);

  it('includes evaluate review state in the terminal JSON result', async () => {
    const root = await showWorkspace();
    const child = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'evaluate', '--root', root, '--json'],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode, child.stderr || child.stdout).toBe(0);
    expect(child.stderr).toBe('');
    const lines = child.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      stage: 'result',
      result: {
        command: 'evaluate',
        status: 'success',
        data: {
          score_scope: 'structural',
          report: { maxTotal: 500, totalDoks: 1 },
          review: {
            scope: 'recorded_metadata',
            content: { missing_doks: 1, unreported_doks: 0, reported_doks: 0, unknown_doks: 0 },
          },
          lifecycle: {
            scope: 'current_state',
            status: { active: 1, draft: 0 },
          },
        },
      },
    });
  }, 30_000);

  it.each([
    ['show', ['show', '--help']],
    ['live-docs render', ['live-docs', 'render', '--help']],
  ])('%s --json help describes the terminal JSONL result envelope', async (
    _command,
    args,
  ) => {
    const child = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', ...args],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode, child.stderr || child.stdout).toBe(0);
    expect(child.stdout).toContain('terminal JSONL result envelope');
    expect(child.stdout).not.toMatch(/raw Dok JSON|manifest summary as JSON/);
  }, 30_000);

  it('exposes saved Publication commands through the real Live Docs CLI tree', async () => {
    const parent = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'live-docs', '--help'],
      { cwd: cliRoot, reject: false },
    );
    const publication = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'live-docs', 'publication', '--help'],
      { cwd: cliRoot, reject: false },
    );
    const capture = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'live-docs', 'capture', '--help'],
      { cwd: cliRoot, reject: false },
    );

    expect(parent.exitCode, parent.stderr || parent.stdout).toBe(0);
    expect(parent.stderr).toBe('');
    expect(parent.stdout).toContain('render [options] <template>');
    expect(parent.stdout).not.toContain('capture [options] <dokId>');
    expect(parent.stdout).toContain('publication');
    expect(publication.exitCode, publication.stderr || publication.stdout).toBe(0);
    expect(publication.stderr).toBe('');
    expect(publication.stdout).toContain('create [options] <name>');
    expect(publication.stdout).toContain('list [options]');
    expect(publication.stdout).toContain('inspect [options] <name>');
    expect(publication.stdout).toContain('render [options] <name>');
    expect(capture.exitCode, capture.stderr || capture.stdout).toBe(0);
    expect(capture.stdout).toContain('[experimental] unavailable');
    expect(capture.stdout).toContain('path-pinned writer');
    expect(capture.stdout).not.toContain('Drive Playwright');
  }, 30_000);

  it('lists saved Publications as exactly one terminal JSON result at the real CLI boundary', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-publication-main-boundary-'));
    const child = await execa(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'live-docs',
        'publication',
        'list',
        '--root',
        root,
        '--json',
      ],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode, child.stderr || child.stdout).toBe(0);
    expect(child.stderr).toBe('');
    const lines = child.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toEqual({
      stage: 'result',
      result: {
        schema_version: 1,
        command: 'live-docs.publication.list',
        status: 'success',
        data: [],
        diagnostics: [],
      },
    });
  }, 30_000);

  it('attributes Publication failures to the nested real CLI command', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-publication-main-boundary-'));
    const child = await execa(
      process.execPath,
      [
        '--import',
        'tsx',
        'src/index.ts',
        'live-docs',
        'publication',
        'inspect',
        'missing',
        '--root',
        root,
        '--json',
      ],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode).toBe(1);
    expect(child.stderr).toBe('');
    const lines = child.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      stage: 'result',
      result: {
        schema_version: 1,
        command: 'live-docs.publication.inspect',
        status: 'failed',
        data: null,
        diagnostics: [{ code: 'PUBLICATION_NOT_FOUND' }],
      },
    });
  }, 30_000);

  it('keeps human sync warnings on stderr and publishes structured partial diagnostics', async () => {
    const root = await showWorkspace();
    const child = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'sync', '--check', '--root', root],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode).toBe(1);
    expect(child.stdout).not.toContain('AUTH');
    expect(child.stderr).toContain('SYNC_STALE_DOK');
    expect(child.stderr).toContain('AUTH');
  }, 30_000);

  it('emits a complete sync partial result with diagnostics and exit 1 in machine mode', async () => {
    const root = await showWorkspace();
    const child = await execa(
      process.execPath,
      ['--import', 'tsx', 'src/index.ts', 'sync', '--check', '--root', root, '--json'],
      { cwd: cliRoot, reject: false },
    );

    expect(child.exitCode).toBe(1);
    expect(child.stderr).toBe('');
    const lines = child.stdout.split('\n').filter(Boolean);
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!)).toMatchObject({
      stage: 'result',
      result: {
        schema_version: 1,
        command: 'sync',
        status: 'partial',
        data: {
          checked: 1,
          stale: [{ dokId: 'AUTH', reason: 'changed', humanEdited: false }],
        },
        diagnostics: [
          {
            code: 'SYNC_STALE_DOK',
            nextCommand: 'doklo sync --yes',
          },
        ],
      },
    });
  }, 30_000);
});
