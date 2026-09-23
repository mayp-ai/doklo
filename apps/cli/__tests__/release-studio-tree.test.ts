import { afterEach, describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
// @ts-expect-error release script is a plain Node module
import { hoistStudioTree } from '../scripts/release-studio-tree.mjs';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'doklo-studio-tree-'));
  roots.push(root);
  const source = join(root, 'standalone');
  const output = join(root, 'release');
  const pkg = (name: string, version: string, code: string, dependencies = {}) => {
    const path = join(source, 'node_modules/.pnpm', `${name.replace('/', '+')}@${version}`, 'node_modules', name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name, version, main: 'index.js', dependencies }));
    writeFileSync(join(path, 'index.js'), code);
    return path;
  };
  const link = (consumer: string, name: string, dependency: string) => {
    const ownName = JSON.parse(readFileSync(join(consumer, 'package.json'), 'utf8')).name as string;
    const siblings = ownName.startsWith('@') ? dirname(dirname(consumer)) : dirname(consumer);
    const path = join(siblings, name);
    mkdirSync(dirname(path), { recursive: true });
    symlinkSync(relative(dirname(path), dependency), path);
  };
  const requireOutput = createRequire(join(output, 'check.cjs'));
  return { source, output, pkg, link, requireOutput };
}

describe('standalone dependency versions', () => {
  it('preserves the older subpath required by a dependency alongside a newer hoisted version', () => {
    const f = fixture();
    const oldStream = f.pkg('stream-lib', '2.0.0', 'module.exports = 2;');
    writeFileSync(join(oldStream, 'passthrough.js'), 'module.exports = "legacy-passthrough";');
    f.pkg('stream-lib', '3.0.0', 'module.exports = 3;');
    const consumer = f.pkg('lazy-consumer', '1.0.0', 'module.exports = require("stream-lib/passthrough");', { 'stream-lib': '^2.0.0' });
    f.link(consumer, 'stream-lib', oldStream);
    hoistStudioTree(f.source, f.output);
    expect(f.requireOutput('lazy-consumer')).toBe('legacy-passthrough');
    expect(f.requireOutput('stream-lib')).toBe(3);
  });

  it('preserves transitive scoped dependency versions', () => {
    const f = fixture();
    const oldLeaf = f.pkg('@scope/leaf', '1.0.0', 'module.exports = "old-leaf";');
    f.pkg('@scope/leaf', '2.0.0', 'module.exports = "new-leaf";');
    const oldMiddle = f.pkg('middle', '1.0.0', 'module.exports = require("@scope/leaf");', { '@scope/leaf': '1.0.0' });
    f.link(oldMiddle, '@scope/leaf', oldLeaf);
    f.pkg('middle', '2.0.0', 'module.exports = "new-middle";');
    const consumer = f.pkg('consumer', '1.0.0', 'module.exports = require("middle");', { middle: '1.0.0' });
    f.link(consumer, 'middle', oldMiddle);
    hoistStudioTree(f.source, f.output);
    expect(f.requireOutput('consumer')).toBe('old-leaf');
    expect(f.requireOutput('middle')).toBe('new-middle');
  });

  it('reuses the matching ancestor for a circular dependency', () => {
    const f = fixture();
    const alpha = f.pkg('alpha', '1.0.0', 'exports.name = "alpha"; exports.beta = require("beta").name;', { beta: '1.0.0' });
    const beta = f.pkg('beta', '1.0.0', 'exports.name = "beta-old"; exports.alpha = require("alpha").name;', { alpha: '1.0.0' });
    f.pkg('beta', '2.0.0', 'exports.name = "beta-new";');
    f.link(alpha, 'beta', beta);
    f.link(beta, 'alpha', alpha);
    hoistStudioTree(f.source, f.output);
    expect(f.requireOutput('alpha').beta).toBe('beta-old');
  });

  it('rejects dependency symlinks outside the standalone trace', () => {
    const f = fixture();
    const outside = join(dirname(f.source), 'outside');
    mkdirSync(outside);
    writeFileSync(join(outside, 'package.json'), JSON.stringify({ name: 'outside', version: '1.0.0' }));
    writeFileSync(join(outside, 'index.js'), 'module.exports = "must not ship";');
    const consumer = f.pkg('consumer', '1.0.0', 'module.exports = require("outside");', { outside: '*' });
    f.link(consumer, 'outside', outside);
    expect(() => hoistStudioTree(f.source, f.output)).toThrow(/outside.*standalone/i);
  });

  it.each(['../escape', '@scope/..'])('rejects unsafe dependency names: %s', (name) => {
    const f = fixture();
    f.pkg('consumer', '1.0.0', 'module.exports = 1;', { [name]: '*' });
    expect(() => hoistStudioTree(f.source, f.output)).toThrow(/Invalid traced package name/);
  });

  it('rejects an unsafe workspace package name', () => {
    const f = fixture();
    const path = join(f.source, 'packages/core');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'package.json'), JSON.stringify({ name: '../../escape' }));
    expect(() => hoistStudioTree(f.source, f.output)).toThrow(/Invalid traced package name/);
  });
});
