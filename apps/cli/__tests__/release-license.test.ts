import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLI_DIR, '..', '..');
const RELEASE_LICENSE = 'Apache-2.0';
const RELEASE_STATEMENT =
  'Licensed under the Apache License, Version 2.0';
const RING_ONE_DIRS = [
  join(REPO_ROOT, 'packages', 'core', 'src', 'schemas'),
  join(CLI_DIR, 'src', 'mcp'),
];

describe('release licensing', () => {
  it('uses the exact Apache SPDX identifier in the generated release manifest', () => {
    const source = readFileSync(join(CLI_DIR, 'scripts', 'build-release.mjs'), 'utf8');

    expect(source).toContain(`const RELEASE_LICENSE = '${RELEASE_LICENSE}';`);
    expect(source).toContain('license: RELEASE_LICENSE');
    expect(source).toContain("'LICENSE', 'NOTICE', 'CHANGELOG.md'");
    expect(source).toMatch(/'LICENSE',\s*'NOTICE',/);
    expect(source).not.toContain("license: 'MIT'");
  });

  it('installs the Apache terms with the release copyright notice', () => {
    const license = readFileSync(join(REPO_ROOT, 'LICENSE'), 'utf8');

    expect(license).toContain('Apache License');
    expect(license).toContain('Version 2.0, January 2004');
    expect(readFileSync(join(REPO_ROOT, 'NOTICE'), 'utf8')).toContain('Copyright 2026 MAYP');
    expect(license).not.toContain('Competing Use');
  });

  it('states the release license consistently in both public READMEs', () => {
    for (const [name, heading, label] of [
      ['README.md', '## License', 'License'],
      ['README.ko.md', '## 라이선스', '라이선스'],
    ]) {
      const readme = readFileSync(join(REPO_ROOT, name), 'utf8');
      expect(readme, name).toContain(`${heading}\n\n${label}: **${RELEASE_LICENSE}**`);
      expect(readme, name).toContain(RELEASE_STATEMENT);
      expect(readme, name).toContain('href="./LICENSE"');
      expect(readme, name).not.toContain('License: MIT');
    }
  });

  it('preserves existing scoped Apache notices', () => {
    const licenses = RING_ONE_DIRS.map((dir) =>
      readFileSync(join(dir, 'LICENSE-APACHE'), 'utf8'),
    );

    expect(new Set(licenses).size).toBe(1);
    expect(licenses[0]).toContain('Apache License');
    expect(licenses[0]).toContain('Version 2.0, January 2004');
    for (const dir of RING_ONE_DIRS) {
      expect(readFileSync(join(dir, 'NOTICE'), 'utf8')).toContain('Copyright 2026 MAYP');
    }
  });
});
