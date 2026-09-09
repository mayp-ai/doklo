// release-content-guard.mjs — last gate before the ONLY artefact that leaves
// this private repo (`@mayp/doklo`) is published.
//
// `scripts/publish-snapshot.sh` guards the *repo* snapshot for the eventual
// public GitHub transition. Nothing guarded the *npm* tarball, even though the
// tarball ships today and the repo does not. This is that counterpart, and it
// runs inside build-release.mjs against the staged tree.
//
// The policy lives here, in code, on purpose: the release is rebuilt many times
// and the exclusion policy must not live in anyone's memory.
//
// Scope note: `studio/node_modules/` is vendored third-party code. It carries
// no policy signal, is enormous, and produces only substring false positives
// (e.g. "programs" contains "agms"), so it is skipped.

import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, sep } from 'node:path';

/** Private client names that must never appear in a public artefact. */
const CLIENT_NAMES = /agms|impactsquare|impactology|sovac|projectloopsocial/i;

/** High-confidence real-key shapes. Deliberately narrow: a false positive here
 *  blocks a release, so only shapes that cannot plausibly be sample text. */
const SECRET_SHAPES = [
  /sk-ant-api03-[A-Za-z0-9_-]{20,}/,
  /\bAKIA[0-9A-Z]{16}\b/,
  /\bghp_[A-Za-z0-9]{36}\b/,
  /\bgithub_pat_[A-Za-z0-9_]{40,}\b/,
  /\bxox[baprs]-[A-Za-z0-9-]{20,}/,
  /\bnpm_[A-Za-z0-9]{36}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

/** Internal-only documents, by basename at the package root. */
const INTERNAL_DOCS = new Set([
  'PLAN.md',
  'TODO.md',
  'DESIGN.md',
  'PRODUCT.md',
  'AGENTS.md',
  'CLAUDE.md',
  'decisions.md',
]);

const TEXT_EXTENSIONS = new Set([
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.md', '.txt',
  '.css', '.html', '.yaml', '.yml', '.tpl', '.map',
]);

function extensionOf(path) {
  const dot = path.lastIndexOf('.');
  return dot === -1 ? '' : path.slice(dot);
}

/** Path-shaped rules. Returns a rule name, or null when the path is allowed. */
function forbiddenPathRule(relPath) {
  const segments = relPath.split(sep);
  const base = segments[segments.length - 1];

  // A bundled demo workspace: sample Doks presented without the
  // `.doklo/DEMO_WORKSPACE` marker that makes them legible as samples.
  if (segments.includes('demo') && segments.includes('.doklo')) return 'demo-workspace';
  if (segments.includes('demo') && base === 'workspace.json') return 'demo-workspace';

  // Vendored client golden sets and evaluator ground truth.
  if (segments.includes('golden') || segments.includes('fixtures')) return 'golden-fixture';
  if (segments.includes('benchmarks') || segments.includes('module-evals')) return 'eval-asset';

  if (base === '.env' || base.startsWith('.env.')) return 'dotenv';
  if (segments.length === 1 && INTERNAL_DOCS.has(base)) return 'internal-doc';

  return null;
}

async function* walk(root, current = root) {
  for (const entry of await readdir(current, { withFileTypes: true })) {
    const abs = join(current, entry.name);
    if (entry.isDirectory()) {
      // Vendored third-party code carries no policy signal (see header).
      if (entry.name === 'node_modules') continue;
      yield* walk(root, abs);
    } else if (entry.isFile()) {
      yield abs;
    }
  }
}

/**
 * Scan a staged release tree.
 *
 * @param {string} root staged package directory
 * @returns {Promise<Array<{path: string, rule: string, detail: string}>>}
 *   One finding per (path, rule). Findings never carry a matched secret value —
 *   only its prefix and length — so build logs stay safe to paste.
 */
export async function findForbiddenReleaseContent(root) {
  const findings = [];

  for await (const abs of walk(root)) {
    const rel = relative(root, abs);

    const pathRule = forbiddenPathRule(rel);
    if (pathRule) {
      findings.push({ path: rel, rule: pathRule, detail: 'forbidden path' });
      continue; // one finding per file is enough to fail the build
    }

    if (!TEXT_EXTENSIONS.has(extensionOf(rel))) continue;
    // Guard against pathological files; policy signal lives near the top anyway.
    const { size } = await stat(abs);
    if (size > 8 * 1024 * 1024) continue;

    let text;
    try {
      text = await readFile(abs, 'utf-8');
    } catch {
      continue;
    }

    const client = CLIENT_NAMES.exec(text);
    if (client) {
      findings.push({ path: rel, rule: 'client-name', detail: `matched ${client[0]}` });
    }

    for (const shape of SECRET_SHAPES) {
      const hit = shape.exec(text);
      if (!hit) continue;
      // Never echo the value: prefix + length only.
      findings.push({
        path: rel,
        rule: 'secret-shape',
        detail: `${hit[0].slice(0, 4)}… (${hit[0].length} chars)`,
      });
      break;
    }
  }

  return findings.sort((a, b) => a.path.localeCompare(b.path) || a.rule.localeCompare(b.rule));
}

/** Throw unless the staged tree is publishable. */
export async function assertPublishableReleaseContent(root) {
  const findings = await findForbiddenReleaseContent(root);
  if (findings.length === 0) return;
  const lines = findings.map((f) => `  ${f.rule.padEnd(16)} ${f.path} — ${f.detail}`);
  throw new Error(
    `release content guard rejected ${findings.length} file(s):\n${lines.join('\n')}\n` +
      'Fix the release builder (or the source) — do not publish this tree.',
  );
}
