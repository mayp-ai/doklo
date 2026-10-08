import { runInNewContext } from 'node:vm';
import { describe, expect, it } from 'vitest';
import {
  APPLICATION_ROUTE_PATTERN_SOURCE,
  SOURCE_PATH_PATTERN_SOURCE,
  containsSourcePath,
  findApplicationRoutes,
  findSourcePaths,
  replaceApplicationRoutes,
} from '../src/public-copy-patterns.js';

// The patterns as the engine wrote them before the linear matchers. They stay
// the definition of what a source path and an application route are; the
// matchers must agree with them on every input, only faster.
const ROUTE_SEGMENT = String.raw`(?:[a-z][a-z0-9_-]*|\[[A-Za-z_$][A-Za-z0-9_$]*\]|\{[\p{L}_$][\p{L}\p{N}_$-]*\}|:[A-Za-z_$][A-Za-z0-9_$]*)`;
const ROUTE_ORACLE = String.raw`(?<![A-Za-z0-9._:/-])\/(?!(?:Users|home|private|var|tmp|opt|workspace|packages|apps|src)(?:\/|$))${ROUTE_SEGMENT}(?:\/${ROUTE_SEGMENT})*(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])`;
const SOURCE_PATH_ORACLE = String.raw`\b(?:packages|apps|src)[\\/][^\s<>"']+|(?:^|[\s(])\/(?:Users|home|private|var|tmp|opt|workspace)\/[^\s<>"']+|\b[A-Za-z]:\\[^\s<>"']+|(?:^|[\s(])\.doklo[\\/][^\s<>"']+|\b(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|swift|kt|cs))\b|${ROUTE_ORACLE}`;

const oracleMatches = (source: string, text: string) =>
  [...text.matchAll(new RegExp(source, 'gimu'))].map((match) => ({ index: match.index ?? 0, text: match[0] }));

/** Every concatenation of up to `depth` tokens. */
function* sequences(tokens: readonly string[], depth: number, prefix = ''): Generator<string> {
  yield prefix;
  if (depth === 0) return;
  for (const token of tokens) yield* sequences(tokens, depth - 1, prefix + token);
}

/** Deterministic strings using public-domain mulberry32.
 * https://github.com/bryc/code/blob/master/jshash/PRNGs.md#mulberry32
 */
function* randomStrings(alphabet: readonly string[], count: number, maxLength: number, seed: number): Generator<string> {
  let state = seed >>> 0;
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  for (let i = 0; i < count; i += 1) {
    const length = Math.floor(next() * (maxLength + 1));
    let text = '';
    for (let j = 0; j < length; j += 1) text += alphabet[Math.floor(next() * alphabet.length)];
    yield text;
  }
}

function within<T>(milliseconds: number, work: () => T): T {
  return runInNewContext('work()', { work }, { timeout: milliseconds }) as T;
}

// Pieces that reach every branch of both patterns: reserved roots, separators,
// extensions (including ts before tsx), route segment kinds, the characters
// the end conditions look at, line starts and the case-folding letters ſ and K.
const PATH_TOKENS = [
  'a', 'B', '.ts', '.tsx', 'x.js', '/', '\\', '.', '-', '_', '$', ':', 'src', 'Users', '.doklo', 'C:',
  '[id]', '{k}', ':p', ' ', '(', '\n', 'ſ', 'K', '1', '"', '>',
];
const ALPHABET = ['a', 'B', 's', 't', 'x', '1', '_', '.', '-', '/', '\\', ':', '$', '[', ']', '{', '}', ' ', '(', '\n', 'ſ', 'K', 'é', '<'];

describe('source path and application route matchers', () => {
  it('keep the published pattern sources unchanged', () => {
    expect(APPLICATION_ROUTE_PATTERN_SOURCE).toBe(ROUTE_ORACLE);
    expect(SOURCE_PATH_PATTERN_SOURCE).toBe(SOURCE_PATH_ORACLE);
  });

  it('agree with the patterns on every short token sequence', () => {
    const differences: string[] = [];
    let checked = 0;
    for (const text of sequences(PATH_TOKENS, 4)) {
      checked += 1;
      const paths = oracleMatches(SOURCE_PATH_ORACLE, text);
      const routes = oracleMatches(ROUTE_ORACLE, text);
      if (JSON.stringify(findSourcePaths(text)) !== JSON.stringify(paths)
        || JSON.stringify(findApplicationRoutes(text)) !== JSON.stringify(routes)
        || containsSourcePath(text) !== new RegExp(SOURCE_PATH_ORACLE, 'imu').test(text)
        || replaceApplicationRoutes(text, 'the page') !== text.replace(new RegExp(ROUTE_ORACLE, 'gimu'), 'the page')) {
        differences.push(JSON.stringify(text));
        if (differences.length > 20) break;
      }
    }
    expect(checked).toBeGreaterThan(500_000);
    expect(differences).toEqual([]);
  });

  it('agree with the patterns on random strings', () => {
    const differences: string[] = [];
    for (const text of randomStrings(ALPHABET, 200_000, 24, 20261006)) {
      if (JSON.stringify(findSourcePaths(text)) !== JSON.stringify(oracleMatches(SOURCE_PATH_ORACLE, text))
        || JSON.stringify(findApplicationRoutes(text)) !== JSON.stringify(oracleMatches(ROUTE_ORACLE, text))) {
        differences.push(JSON.stringify(text));
        if (differences.length > 20) break;
      }
    }
    expect(differences).toEqual([]);
  });

  it('agree with the patterns on realistic copy', () => {
    for (const text of [
      'Open packages/core/src/index.ts or /Users/me/app and C:\\work\\x.ts',
      'Edit src/app/page.tsx, then open /settings/[id]/profile and /api/:id$ now.',
      'See ./.doklo/hub/doks/AUTH.json (.doklo/x) and app\\routes\\a.ts',
      'Go to /account/billing. The /home page and /Users/x/y and a/b/c.tsx.bak',
      '/:a$b/[x]_ /{이름}/x /docs/v1.2 /a/b.c path/to/file.java.',
    ]) {
      expect(findSourcePaths(text)).toEqual(oracleMatches(SOURCE_PATH_ORACLE, text));
      expect(findApplicationRoutes(text)).toEqual(oracleMatches(ROUTE_ORACLE, text));
    }
  });

  it.each([
    ['a dotted run', (n: number) => 'a.'.repeat(n)],
    ['a hyphenated run', (n: number) => 'a-'.repeat(n)],
    ['a slashed run without an extension', (n: number) => `${'a/'.repeat(n)}a`],
    ['a slashed run after a valid path', (n: number) => `a/x.ts${'/a'.repeat(n)}`],
    ['bracket route segments before a word character', (n: number) => `${'/[a]'.repeat(n)}_`],
    ['brace route segments before a word character', (n: number) => `${'/{a}'.repeat(n)}_`],
    ['colon route segments ending in $', (n: number) => `${'/:a$'.repeat(n)}_`],
  ])('finish on %s', (_name, build) => {
    const text = build(200_000);
    within(2_000, () => findSourcePaths(text));
    within(2_000, () => containsSourcePath(text));
    within(2_000, () => replaceApplicationRoutes(text, 'the page'));
  });
});
