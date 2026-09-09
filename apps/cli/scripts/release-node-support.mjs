// release-node-support.mjs — the one Node.js minimum this release stands behind.
//
// It used to be stated three times, in three shapes, and they disagreed:
// the root README said "Node.js 20.9+", apps/cli/README.md said `>=20.9.0`,
// and the generated release manifest said `"engines": { "node": ">=20" }`.
// The manifest was the loosest of the three, so npm installed happily on
// 20.0-20.8 — versions the release was never exercised on (the fresh-install
// verification covered v20.20.2, v22.16.0 and v22.23.2).
//
// One constant, plus the reader the test points at every README, so the three
// statements cannot drift apart again.

export const RELEASE_NODE_MINIMUM = '20.9.0';

/** The semver range the published `engines.node` field carries. */
export const RELEASE_NODE_ENGINE = `>=${RELEASE_NODE_MINIMUM}`;

/**
 * Pad a stated version to `major.minor.patch` so "20", "20.9" and "20.9.0"
 * compare as the values they mean.
 *
 * @param {string} version
 * @returns {string}
 */
export function normalizeNodeVersion(version) {
  const parts = version.split('.');
  while (parts.length < 3) parts.push('0');
  return parts.join('.');
}

/**
 * Every Node.js minimum a document states, normalized.
 *
 * Only lines that name Node.js are read, so a version number belonging to
 * something else (Next.js, a package version) is never mistaken for one.
 *
 * @param {string} text
 * @returns {string[]}
 */
export function documentedNodeMinimums(text) {
  const minimums = [];
  for (const line of text.split('\n')) {
    if (!line.includes('Node.js')) continue;
    for (const match of line.matchAll(/Node\.js\D{0,12}?v?(\d+(?:\.\d+){0,2})/g)) {
      minimums.push(normalizeNodeVersion(match[1]));
    }
  }
  return minimums;
}
