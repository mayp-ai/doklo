import { describe, it, expect } from 'vitest';
import { workspacePaths } from '../src/lib/paths.js';

describe('workspacePaths', () => {
  it('puts workspace.json at the project root', () => {
    const p = workspacePaths('/tmp/proj');
    expect(p.workspaceFile).toBe('/tmp/proj/workspace.json');
  });

  it('places hub artifacts under .doklo/hub', () => {
    const p = workspacePaths('/tmp/proj');
    expect(p.hubRoot).toBe('/tmp/proj/.doklo/hub');
    expect(p.doksDir).toBe('/tmp/proj/.doklo/hub/doks');
    expect(p.rolesFile).toBe('/tmp/proj/.doklo/hub/roles.json');
    expect(p.lexiconFile).toBe('/tmp/proj/.doklo/hub/lexicon.json');
  });

  it('places debug + cache under .doklo (separate from hub)', () => {
    const p = workspacePaths('/tmp/proj');
    expect(p.debugDir).toBe('/tmp/proj/.doklo/debug');
    expect(p.cacheDir).toBe('/tmp/proj/.doklo/cache');
  });

  it('places the allowlist .gitignore at .doklo/.gitignore', () => {
    const p = workspacePaths('/tmp/proj');
    expect(p.gitignoreFile).toBe('/tmp/proj/.doklo/.gitignore');
  });

  it('places versioned Publication definitions under .doklo/livedocs', () => {
    const p = workspacePaths('/tmp/proj');
    expect(p.livedocsDir).toBe('/tmp/proj/.doklo/livedocs');
    expect(p.publicationsDir).toBe('/tmp/proj/.doklo/livedocs/publications');
    expect(p.publicationFile('public-help')).toBe(
      '/tmp/proj/.doklo/livedocs/publications/public-help.json',
    );
  });

  it('exposes per-service mapping/ia paths', () => {
    const p = workspacePaths('/tmp/proj');
    expect(p.serviceCodeMapping('web')).toBe(
      '/tmp/proj/.doklo/hub/services/web/code-mapping.json',
    );
    expect(p.serviceIa('api')).toBe(
      '/tmp/proj/.doklo/hub/services/api/ia.json',
    );
  });

  it('returns absolute paths even when given a relative root', () => {
    const p = workspacePaths('proj');
    // resolve() against cwd — just confirm it became absolute.
    expect(p.workspaceFile.startsWith('/')).toBe(true);
    expect(p.workspaceFile.endsWith('proj/workspace.json')).toBe(true);
  });
});
