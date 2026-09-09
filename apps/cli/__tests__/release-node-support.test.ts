// Regression: the release stated three different Node.js minimums. The root
// README said "Node.js 20.9+", apps/cli/README.md said `>=20.9.0`, and the
// generated release manifest said `engines.node: ">=20"`. npm enforces the
// manifest, which was the loosest of the three, so an install succeeded on
// 20.0-20.8 — a range the release was never verified on.

import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

import {
  RELEASE_NODE_ENGINE,
  RELEASE_NODE_MINIMUM,
  documentedNodeMinimums,
  normalizeNodeVersion,
} from '../scripts/release-node-support.mjs';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLI_DIR, '..', '..');

const READMES = [
  join(REPO_ROOT, 'README.md'),
  join(REPO_ROOT, 'README.ko.md'),
  join(CLI_DIR, 'README.md'),
];

describe('documentedNodeMinimums', () => {
  it('reads every shape the docs use for a Node.js minimum', () => {
    expect(documentedNodeMinimums('Requires Node.js 20.9+ and one service.')).toEqual(['20.9.0']);
    expect(documentedNodeMinimums('| Node.js | `>=20.9.0` |')).toEqual(['20.9.0']);
    expect(documentedNodeMinimums('Node.js 20.9+가 필요하며')).toEqual(['20.9.0']);
    expect(documentedNodeMinimums('engines: Node.js >=20')).toEqual(['20.0.0']);
  });

  it('ignores version numbers that do not belong to Node.js', () => {
    expect(documentedNodeMinimums('one Next.js 15 App Router service')).toEqual([]);
    expect(documentedNodeMinimums('@mayp/doklo 0.1.0 has not been published')).toEqual([]);
  });

  it('pads a partially stated version to major.minor.patch', () => {
    expect(normalizeNodeVersion('20')).toBe('20.0.0');
    expect(normalizeNodeVersion('20.9')).toBe('20.9.0');
    expect(normalizeNodeVersion('20.9.0')).toBe('20.9.0');
  });
});

describe('release Node.js minimum', () => {
  it('is the range npm will enforce', () => {
    expect(RELEASE_NODE_ENGINE).toBe(`>=${RELEASE_NODE_MINIMUM}`);
    expect(RELEASE_NODE_MINIMUM).toBe('20.9.0');
  });

  it('is the only minimum any README states', () => {
    for (const file of READMES) {
      const stated = documentedNodeMinimums(readFileSync(file, 'utf8'));
      expect(stated.length, `${file} states no Node.js minimum`).toBeGreaterThan(0);
      expect([...new Set(stated)], file).toEqual([RELEASE_NODE_MINIMUM]);
    }
  });

  it('is what the release manifest declares, not a second literal', () => {
    const source = readFileSync(join(CLI_DIR, 'scripts', 'build-release.mjs'), 'utf8');
    expect(source).toContain('engines: { node: RELEASE_NODE_ENGINE }');
    expect(source).not.toMatch(/engines:\s*\{\s*node:\s*['"]/);
  });
});
