// Format-only normaliser (judge-gated sync design §4.2): a pure, conservative
// "did this file change in form only?" canonicaliser behind
// `_meta.logic_hash_normalized`. Ported from the benchmark harness
// (`benchmarks/judge-sync/src/normalize.ts`), which measured zero false
// "format-only" verdicts on 32 real changes and passed the plan's synthetic
// cases. Core stays dependency-free: it receives this as an injected
// `LogicHashNormalizer` and computes the hash itself, so generate (compute) and
// drift (verify) share one hash function and one normaliser.
//
// It lives here because this package already carries the TypeScript parser
// (ts-morph's bundled `ts`); the generator package has no parser dependency.
//
// Rules (design §4.2 "보수 규칙"):
//  1. Only .ts .tsx .js .jsx .mjs .cjs are normalised. Everything else returns
//     null, and the caller hashes it raw.
//  2. Normalisation uses the TypeScript parser, never regular expressions, so a
//     `//` inside a string, template or regex is never mistaken for a comment.
//  3. Only comments, whitespace and line-ending kinds disappear. The canonical
//     form is the parse tree itself — every node kind plus the exact source
//     text of every token (strings, templates, JSX text, numbers, names and
//     regex literals are copied verbatim, quotes included).
//  4. Because node kinds are part of the form, a newline that changes the parse
//     (ASI after `return`) is a real change.
//  5. A parse error means "not sure": null, so any edit to that file is a real
//     change.
//  6. The version includes the TypeScript version: node-kind names are only
//     stable within one compiler version, and a stored hash with another
//     version is never compared.
//
// Two JSX-specific rules remove only what the JSX compiler itself discards:
//  - a JSX text node that is all whitespace and contains a line break
//    (indentation between elements; TS marks it `containsOnlyTriviaWhiteSpaces`
//    and the JSX transform drops it);
//  - an empty JSX expression container `{/* comment */}` (no expression; the
//    JSX transform emits no child for it).
// A JSX text node that carries any non-whitespace character is kept verbatim,
// leading/trailing indentation included, so re-indenting a line of JSX text is
// a real change (conservative).
import { ts } from 'ts-morph';
import type { LogicHashNormalizer } from '@doklo-beta/core';

/** The canonicalisation algorithm. Bump it whenever the canonical form changes. */
export const NORMALIZER_ID = 'ts-tree-v1';

/**
 * Stored as the prefix of `_meta.logic_hash_normalized`, e.g.
 * `ts-tree-v1+ts5.4.2`. A stored hash with any other version is never compared,
 * so a normaliser or parser change can never silently match an old hash.
 */
export const NORMALIZER_VERSION = `${NORMALIZER_ID}+ts${ts.version}`;

const SCRIPT_KINDS: Readonly<Record<string, ts.ScriptKind>> = {
  '.ts': ts.ScriptKind.TS,
  '.tsx': ts.ScriptKind.TSX,
  '.js': ts.ScriptKind.JS,
  '.jsx': ts.ScriptKind.JSX,
  '.mjs': ts.ScriptKind.JS,
  '.cjs': ts.ScriptKind.JS,
};

function scriptKindFor(file: string): ts.ScriptKind | undefined {
  const base = file.split('/').at(-1) ?? file;
  const dot = base.lastIndexOf('.');
  if (dot <= 0) return undefined;
  return SCRIPT_KINDS[base.slice(dot).toLowerCase()];
}

function isJsDocKind(kind: ts.SyntaxKind): boolean {
  return kind >= ts.SyntaxKind.FirstJSDocNode && kind <= ts.SyntaxKind.LastJSDocNode;
}

function emit(node: ts.Node, sf: ts.SourceFile, out: string[]): void {
  if (isJsDocKind(node.kind)) return;
  if (ts.isJsxText(node) && node.containsOnlyTriviaWhiteSpaces) return;
  if (ts.isJsxExpression(node) && node.expression === undefined && node.dotDotDotToken === undefined) return;
  const children = node.getChildren(sf);
  const name = ts.SyntaxKind[node.kind] ?? String(node.kind);
  if (children.length === 0) {
    // JSX text has no trivia: its full span is content. Every other leaf is a
    // token whose leading trivia (whitespace, comments) is skipped.
    const start = ts.isJsxText(node) ? node.pos : node.getStart(sf);
    out.push(`${name}=${JSON.stringify(sf.text.slice(start, node.end))} `);
    return;
  }
  out.push(`(${name} `);
  for (const child of children) emit(child, sf, out);
  out.push(') ');
}

/**
 * Canonical form of one file for `_meta.logic_hash_normalized`, or `null` when
 * the file is not a JS/TS file or does not parse — then the caller hashes its
 * raw content. Equal forms ⇔ equal parse trees, comments, whitespace and
 * line-ending kinds aside. Pure; never throws.
 */
export function normalizeForHash(file: string, content: string): string | null {
  const kind = scriptKindFor(file);
  if (kind === undefined) return null;
  try {
    const sf = ts.createSourceFile(file, content, ts.ScriptTarget.Latest, true, kind);
    const diagnostics = (sf as unknown as { parseDiagnostics?: unknown }).parseDiagnostics;
    if (!Array.isArray(diagnostics) || diagnostics.length > 0) return null;
    const out: string[] = [];
    emit(sf, sf, out);
    return out.join('');
  } catch {
    return null;
  }
}

/** True only when both sides normalise and their canonical forms are equal. */
export function isFormatOnlyChange(file: string, before: string, after: string): boolean {
  const a = normalizeForHash(file, before);
  const b = normalizeForHash(file, after);
  return a !== null && b !== null && a === b;
}

/**
 * The normaliser to inject into core's drift functions
 * (`computeNormalizedLogicHash`, `isDokStale(dok, root, { normalize })`).
 * Every caller must use this one instance — stamping and verification with
 * different normalisers would make one screen call a Dok fresh and another
 * call it stale.
 */
export const tsTreeNormalizer: LogicHashNormalizer = Object.freeze({
  version: NORMALIZER_VERSION,
  normalizeForHash,
});
