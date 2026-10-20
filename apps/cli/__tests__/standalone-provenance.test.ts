import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
// @ts-expect-error Build scripts are native ESM.
import { captureStudioSource, recordStandaloneProvenance, assertFreshStandalone } from '../../studio/scripts/standalone-provenance.mjs';

const roots: string[] = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'studio-provenance-'));
  roots.push(root);
  mkdirSync(join(root, 'apps/studio'), { recursive: true });
  writeFileSync(join(root, '.gitignore'), '.next/\n');
  writeFileSync(join(root, 'apps/studio/page.tsx'), 'original');
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, stdio: 'pipe' }).toString().trim();
  git('init'); git('add', '.');
  git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const standalone = join(root, 'apps/studio/.next/standalone');
  mkdirSync(join(standalone, 'apps/studio/.next'), { recursive: true });
  writeFileSync(join(root, 'apps/studio/.next/BUILD_ID'), 'build-one');
  writeFileSync(join(standalone, 'apps/studio/.next/BUILD_ID'), 'build-one');
  return { root, standalone, git };
}

describe('standalone release provenance', () => {
  it('rejects an existing legacy standalone with no provenance', () => {
    const { root } = fixture();
    expect(() => assertFreshStandalone(root)).toThrow(/provenance.*rebuild/i);
  });
  it('accepts the matching build and records its actual commit and BUILD_ID', () => {
    const { root, standalone, git } = fixture();
    recordStandaloneProvenance(root, captureStudioSource(root));
    expect(() => assertFreshStandalone(root)).not.toThrow();
    expect(JSON.parse(readFileSync(join(standalone, 'doklo-build-provenance.json'), 'utf8'))).toMatchObject({ commit: git('rev-parse', 'HEAD'), buildId: 'build-one' });
  });
  it('rejects a stale commit even when Studio source has not changed', () => {
    const { root, git } = fixture();
    recordStandaloneProvenance(root, captureStudioSource(root));
    git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', '-c', 'commit.gpgsign=false', 'commit', '--allow-empty', '-m', 'next');
    expect(() => assertFreshStandalone(root)).toThrow(/commit.*rebuild/i);
  });
  it.each(['apps/studio/page.tsx', 'apps/studio/new.tsx', 'packages/core/src/new.ts', 'pnpm-lock.yaml'])('rejects changed build input %s', (file) => {
    const { root } = fixture();
    recordStandaloneProvenance(root, captureStudioSource(root));
    mkdirSync(join(root, file, '..'), { recursive: true });
    writeFileSync(join(root, file), 'changed');
    expect(() => assertFreshStandalone(root)).toThrow(/source.*rebuild/i);
  });
  it('allows a fresh rebuild of local edits, but rejects subsequent edits', () => {
    const { root } = fixture();
    writeFileSync(join(root, 'apps/studio/page.tsx'), 'local edit');
    recordStandaloneProvenance(root, captureStudioSource(root));
    expect(() => assertFreshStandalone(root)).not.toThrow();
    writeFileSync(join(root, 'apps/studio/page.tsx'), 'later edit');
    expect(() => assertFreshStandalone(root)).toThrow(/source.*rebuild/i);
  });
  it('refuses to stamp a build whose source changed during compilation', () => {
    const { root } = fixture();
    const before = captureStudioSource(root);
    writeFileSync(join(root, 'apps/studio/page.tsx'), 'during build');
    expect(() => recordStandaloneProvenance(root, before)).toThrow(/source.*rebuild/i);
    expect(() => assertFreshStandalone(root)).toThrow(/provenance/i);
  });
  it('rejects swapped standalone output or a newer root Next build', () => {
    const { root, standalone } = fixture();
    recordStandaloneProvenance(root, captureStudioSource(root));
    writeFileSync(join(standalone, 'apps/studio/.next/BUILD_ID'), 'swapped');
    expect(() => assertFreshStandalone(root)).toThrow(/build.*rebuild/i);
    writeFileSync(join(standalone, 'apps/studio/.next/BUILD_ID'), 'build-one');
    writeFileSync(join(root, 'apps/studio/.next/BUILD_ID'), 'newer');
    expect(() => assertFreshStandalone(root)).toThrow(/build.*rebuild/i);
  });
  it('rejects malformed provenance with a rebuild instruction', () => {
    const { root, standalone } = fixture();
    writeFileSync(join(standalone, 'doklo-build-provenance.json'), '{');
    expect(() => assertFreshStandalone(root)).toThrow(/provenance.*rebuild/i);
  });
});
