import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listTemplates,
  resolveTemplate,
  TemplateNotFoundError,
} from '../src/template-loader.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, 'fixtures', '3-source');
const workspaceRoot = join(root, 'workspace');
const userHome = join(root, 'user');
const builtinRoot = join(root, 'builtin');

const opts = { workspaceRoot, userHome, builtinRoot };

describe('resolveTemplate', () => {
  it('workspace wins when name exists in all three sources', async () => {
    const r = await resolveTemplate('shared', opts);
    expect(r.source).toBe('workspace');
    expect(r.parsed.manifest.version).toBe('1.0.0');
  });

  it('falls through to user when only user + builtin', async () => {
    const r = await resolveTemplate('user-only', opts);
    expect(r.source).toBe('user');
  });

  it('falls through to builtin when only builtin', async () => {
    const r = await resolveTemplate('builtin-only', opts);
    expect(r.source).toBe('builtin');
  });

  it('preferredSource=builtin returns builtin even when workspace has it', async () => {
    const r = await resolveTemplate('shared', { ...opts, preferredSource: 'builtin' });
    expect(r.source).toBe('builtin');
    expect(r.parsed.manifest.version).toBe('0.9.0');
  });

  it('throws TemplateNotFoundError listing all 3 sources', async () => {
    try {
      await resolveTemplate('does-not-exist', opts);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TemplateNotFoundError);
      const e = err as TemplateNotFoundError;
      expect(e.sourcesSearched.map((s) => s.source).sort()).toEqual(['builtin', 'user', 'workspace']);
    }
  });
});

describe('listTemplates', () => {
  it('aggregates across sources and marks the active winner', async () => {
    const entries = await listTemplates({ ...opts, includeExperimental: true });
    const sharedRows = entries.filter((e) => e.name === 'shared');
    expect(sharedRows).toHaveLength(3);
    const activeShared = sharedRows.find((r) => r.active);
    expect(activeShared?.source).toBe('workspace');

    const userOnly = entries.find((e) => e.name === 'user-only');
    expect(userOnly?.source).toBe('user');
    expect(userOnly?.active).toBe(true);

    const builtinOnly = entries.find((e) => e.name === 'builtin-only');
    expect(builtinOnly?.source).toBe('builtin');
    expect(builtinOnly?.active).toBe(true);
  });

  it('pins enumeration to preferredSource with the same winner semantics as resolution', async () => {
    const resolved = await resolveTemplate('shared', { ...opts, preferredSource: 'builtin' });
    const entries = await listTemplates({
      ...opts,
      preferredSource: 'builtin',
      includeExperimental: true,
    });

    expect(resolved.source).toBe('builtin');
    expect(entries.every((entry) => entry.source === 'builtin')).toBe(true);
    expect(entries.find((entry) => entry.name === 'shared')).toMatchObject({
      source: 'builtin',
      active: true,
    });
  });

  it('computes precedence before hiding an experimental winner', async () => {
    const temp = await mkdtemp(join(tmpdir(), 'livedoc-loader-precedence-'));
    try {
      const localWorkspace = join(temp, 'workspace');
      const localBuiltin = join(temp, 'builtin');
      const manifest = (stability: 'stable' | 'experimental') => JSON.stringify({
        name: 'help-page',
        version: '1.0.0',
        stability,
        audience: { en: 'Customers' },
        purpose: { en: 'Explain a product task.' },
        job: { en: 'Complete the product task.' },
        required_input: { en: 'Reviewed product context' },
        variables: {},
        output_formats: ['markdown'],
        scope: 'workspace',
        output_path: 'help.md',
        supported_locales: ['en'],
        default_locale: 'en',
      });
      for (const [directory, stability] of [
        [join(localWorkspace, '.doklo', 'templates', 'help-page'), 'experimental'],
        [join(localBuiltin, 'help-page'), 'stable'],
      ] as const) {
        await mkdir(directory, { recursive: true });
        await writeFile(join(directory, 'doklo-template.json'), manifest(stability));
        await writeFile(join(directory, 'template.md.tpl'), 'Safe help.');
      }

      const resolved = await resolveTemplate('help-page', {
        workspaceRoot: localWorkspace,
        userHome: join(temp, 'user'),
        builtinRoot: localBuiltin,
      });
      expect(resolved.source).toBe('workspace');

      const visible = await listTemplates({
        workspaceRoot: localWorkspace,
        userHome: join(temp, 'user'),
        builtinRoot: localBuiltin,
      });
      expect(visible).toHaveLength(1);
      expect(visible[0]).toMatchObject({ source: 'builtin', stability: 'stable', active: false });
    } finally {
      await rm(temp, { recursive: true, force: true });
    }
  });
});
