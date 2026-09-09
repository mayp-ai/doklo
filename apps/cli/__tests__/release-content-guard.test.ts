import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { findForbiddenReleaseContent } from '../scripts/release-content-guard.mjs';

/**
 * The published `@mayp/doklo` tarball is the only artefact that leaves this
 * private repo. `scripts/publish-snapshot.sh` guards the *repo* snapshot; this
 * guard is its counterpart for the *npm* artefact, and it runs inside
 * build-release.mjs before the staged tree is published.
 */

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((r) => rm(r, { recursive: true, force: true })));
});

async function stage(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-release-guard-'));
  roots.push(root);
  for (const [rel, body] of Object.entries(files)) {
    const target = join(root, rel);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, body);
  }
  return root;
}

/** A minimal tree shaped like a real release bundle, with nothing forbidden. */
const CLEAN_TREE: Record<string, string> = {
  'package.json': '{"name":"@mayp/doklo","version":"0.1.0"}\n',
  'README.md': '# Doklo\n\nTurn your codebase into product context.\n',
  'CHANGELOG.md': '# Changelog\n',
  'LICENSE': 'MIT\n',
  'dist/index.js': '#!/usr/bin/env node\nconsole.log("doklo");\n',
  'i18n/en.json': '{"hello":"Hello"}\n',
  'templates/help-page/doklo-template.json': '{"$schema":"https://doklo.dev/x.json"}\n',
  'studio/apps/studio/server.js': 'require("./.next/server.js");\n',
};

describe('findForbiddenReleaseContent', () => {
  it('passes a clean release tree', async () => {
    const root = await stage(CLEAN_TREE);
    expect(await findForbiddenReleaseContent(root)).toEqual([]);
  });

  it('rejects a bundled demo workspace', async () => {
    const root = await stage({
      ...CLEAN_TREE,
      'studio/apps/studio/demo/workspace.json': '{"workspace_id":"doklo-studio-demo"}\n',
      'studio/apps/studio/demo/.doklo/hub/roles.json': '{"roles":[]}\n',
    });
    const findings = await findForbiddenReleaseContent(root);
    expect(findings.map((f) => f.path).sort()).toEqual([
      'studio/apps/studio/demo/.doklo/hub/roles.json',
      'studio/apps/studio/demo/workspace.json',
    ]);
    expect(findings.every((f) => f.rule === 'demo-workspace')).toBe(true);
  });

  it('rejects a vendored client golden set', async () => {
    const root = await stage({
      ...CLEAN_TREE,
      'fixtures/golden/agms-mentor/workspace.json': '{"workspace_id":"agms-mentor"}\n',
    });
    const findings = await findForbiddenReleaseContent(root);
    expect(findings.length).toBeGreaterThan(0);
    expect(findings.some((f) => f.rule === 'golden-fixture')).toBe(true);
  });

  it('rejects internal-only documents', async () => {
    const root = await stage({ ...CLEAN_TREE, 'PLAN.md': '# 내부 계획\n' });
    const findings = await findForbiddenReleaseContent(root);
    expect(findings.some((f) => f.rule === 'internal-doc' && f.path === 'PLAN.md')).toBe(true);
  });

  it('rejects a dotenv file', async () => {
    const root = await stage({ ...CLEAN_TREE, '.env': 'ANTHROPIC_API_KEY=x\n' });
    const findings = await findForbiddenReleaseContent(root);
    expect(findings.some((f) => f.rule === 'dotenv')).toBe(true);
  });

  it('rejects every private client name anywhere in shipped text', async () => {
    for (const client of ['agms', 'ImpactSquare', 'Impactology', 'SOVAC', 'ProjectLoopSocial']) {
      const root = await stage({
        ...CLEAN_TREE,
        'README.md': `# Doklo\n\n${client} customer walkthrough\n`,
      });
      const findings = await findForbiddenReleaseContent(root);
      expect(
        findings.some((f) => f.rule === 'client-name' && f.path === 'README.md'),
        client,
      ).toBe(true);
    }
  });

  it('rejects private client names in the bundled CLI output', async () => {
    const root = await stage({
      ...CLEAN_TREE,
      // esbuild strips comments today, so this can only appear by regression.
      'dist/index.js': '// agms-mentor calls it directly\nconsole.log(1);\n',
    });
    const findings = await findForbiddenReleaseContent(root);
    expect(findings.some((f) => f.rule === 'client-name' && f.path === 'dist/index.js')).toBe(true);
  });

  it('rejects a high-confidence Anthropic key shape', async () => {
    const root = await stage({
      ...CLEAN_TREE,
      'dist/index.js': 'const k = "sk-ant-api03-AAAAAAAAAAAAAAAAAAAAAAAAAA";\n',
    });
    const findings = await findForbiddenReleaseContent(root);
    expect(findings.some((f) => f.rule === 'secret-shape')).toBe(true);
  });

  it('does not report the secret value it found', async () => {
    const root = await stage({
      ...CLEAN_TREE,
      'dist/index.js': 'const k = "sk-ant-api03-SUPERSECRETVALUE0123456";\n',
    });
    const findings = await findForbiddenReleaseContent(root);
    const serialised = JSON.stringify(findings);
    expect(serialised).not.toContain('SUPERSECRETVALUE0123456');
  });

  it('ignores vendored node_modules, which carry no policy signal', async () => {
    const root = await stage({
      ...CLEAN_TREE,
      'studio/node_modules/next/dist/compiled/validator.js': 'var x="programs agms";\n',
    });
    expect(await findForbiddenReleaseContent(root)).toEqual([]);
  });
});
