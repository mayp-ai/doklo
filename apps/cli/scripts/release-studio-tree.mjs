import { existsSync, mkdirSync, statSync, lstatSync, readdirSync, copyFileSync, readFileSync, realpathSync } from 'node:fs';
import { basename, dirname, join, relative, isAbsolute, resolve, sep } from 'node:path';

/** Materialize the traced dependency graph without npm-stripped symlinks. */
export function hoistStudioTree(standaloneSrc, destination, { log = () => {} } = {}) {
  const sourceRoot = realpathSync(standaloneSrc);
  const outputRoot = resolve(destination);
  const nmDst = join(outputRoot, 'node_modules');
  const placements = new Map(); // destination package -> exact traced source
  const expanded = new Set(); // destination, not source: ancestors can differ

  function packageName(name) {
    const parts = typeof name === 'string' ? name.split('/') : [];
    const segment = (value) => /^[a-z0-9._~-]+$/i.test(value) && value !== '.' && value !== '..';
    if ((parts.length === 1 && segment(parts[0])) ||
        (parts.length === 2 && parts[0].startsWith('@') && segment(parts[0].slice(1)) && segment(parts[1]))) return name;
    throw new Error(`Invalid traced package name: ${name}`);
  }

  function register(target, source) {
    const rel = relative(outputRoot, target);
    if (!rel || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Dependency outside release destination: ${target}`);
    }
    placements.set(target, source);
  }

  function containedSource(path) {
    const actual = realpathSync(path);
    const rel = relative(sourceRoot, actual);
    if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
      throw new Error(`Dependency outside standalone trace: ${path}`);
    }
    return actual;
  }

  function copyCode(from, to, ancestors = new Set()) {
    const actual = containedSource(from);
    if (statSync(actual).isDirectory()) {
      if (basename(from) === 'demo' && existsSync(join(from, '.doklo'))) {
        log(`skipped bundled demo workspace: ${basename(dirname(from))}/demo/`);
        return;
      }
      if (ancestors.has(actual)) throw new Error(`Cyclic standalone source directory: ${from}`);
      const next = new Set([...ancestors, actual]);
      mkdirSync(to, { recursive: true });
      for (const entry of readdirSync(actual)) {
        if (entry !== 'node_modules') copyCode(join(actual, entry), join(to, entry), next);
      }
    } else {
      copyFileSync(actual, to);
    }
  }

  function manifest(from) {
    const path = join(from, 'package.json');
    return existsSync(path) ? JSON.parse(readFileSync(containedSource(path), 'utf8')) : {};
  }

  function packageDirs(inner) {
    const result = [];
    for (const entry of readdirSync(inner)) {
      if (entry === '.bin') continue;
      const path = join(inner, entry);
      if (entry.startsWith('@')) {
        for (const name of readdirSync(path)) {
          const child = join(path, name);
          if (!lstatSync(child).isSymbolicLink()) result.push([`${entry}/${name}`, child]);
        }
      } else if (!lstatSync(path).isSymbolicLink()) {
        result.push([entry, path]);
      }
    }
    return result;
  }

  function newer(a, b) {
    const left = a.split(/[.-]/).map(Number);
    const right = b.split(/[.-]/).map(Number);
    for (let i = 0; i < 3; i++) {
      if ((left[i] || 0) !== (right[i] || 0)) return (left[i] || 0) > (right[i] || 0);
    }
    return false;
  }

  function tracedDependency(from, name) {
    for (let current = from; ; current = dirname(current)) {
      const candidate = join(current, 'node_modules', name);
      if (existsSync(candidate)) return containedSource(candidate);
      if (current === sourceRoot) return undefined;
    }
  }

  function nearestPlacement(from, name) {
    for (let current = from; ; current = dirname(current)) {
      const source = placements.get(join(current, 'node_modules', name));
      if (source) return source;
      if (current === outputRoot) return undefined;
    }
  }

  function expand(from, to, active = new Set([from])) {
    if (expanded.has(to)) return;
    expanded.add(to);
    const data = manifest(from);
    const names = Object.keys({ ...data.dependencies, ...data.optionalDependencies, ...data.peerDependencies });
    const children = [];
    for (const name of names) {
      packageName(name);
      const wanted = tracedDependency(from, name);
      // Next omits dependencies that are not used by the traced runtime.
      if (!wanted || nearestPlacement(to, name) === wanted) continue;
      if (active.has(wanted)) throw new Error(`Cannot materialize shadowed dependency cycle: ${name}`);
      const nested = join(to, 'node_modules', name);
      if (placements.has(nested)) throw new Error(`Conflicting dependency placement: ${nested}`);
      register(nested, wanted);
      copyCode(wanted, nested);
      children.push([wanted, nested]);
    }
    // Register all siblings before resolving their peers or cycles.
    for (const [source, target] of children) expand(source, target, new Set([...active, source]));
  }

  mkdirSync(nmDst, { recursive: true });
  for (const top of readdirSync(sourceRoot)) {
    if (top !== 'node_modules') copyCode(join(sourceRoot, top), join(outputRoot, top));
  }

  const winners = new Map();
  const store = join(sourceRoot, 'node_modules', '.pnpm');
  if (existsSync(store)) {
    for (const id of readdirSync(store)) {
      if (id === 'node_modules') continue;
      const inner = join(store, id, 'node_modules');
      if (!existsSync(inner)) continue;
      for (const [name, path] of packageDirs(inner)) {
        const source = containedSource(path);
        const version = manifest(source).version ?? '0.0.0';
        const current = winners.get(name);
        if (!current || newer(version, current.version)) winners.set(name, { source, version });
      }
    }
  }
  for (const [name, { source }] of winners) register(join(nmDst, packageName(name)), source);

  let workspace = 0;
  const localPackages = [];
  for (const group of ['apps', 'packages']) {
    const dir = join(sourceRoot, group);
    if (!existsSync(dir)) continue;
    for (const child of readdirSync(dir)) {
      const source = containedSource(join(dir, child));
      const name = manifest(source).name;
      if (!name) continue;
      packageName(name);
      localPackages.push([source, join(outputRoot, group, child)]);
      if (group === 'packages' && !placements.has(join(nmDst, name))) {
        register(join(nmDst, name), source);
        workspace++;
      }
    }
  }
  // All root placements must exist before any dependency is expanded.
  for (const [target, source] of placements) copyCode(source, target);
  for (const [source, target] of localPackages) register(target, source);
  for (const [target, source] of placements) expand(source, target);
  return { hoisted: winners.size, workspace };
}
