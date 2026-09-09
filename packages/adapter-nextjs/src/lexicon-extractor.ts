// Deterministic Lexicon term extraction from i18n files.
//
// Discovery: walks well-known i18n directory layouts (next-intl,
// next-i18next, plain custom locales/) to find <locale>[<ns>].json files.
// Extraction: flattens nested JSON to dot-notation keys, groups the same
// key across locales, and emits one LexiconTermCandidate per unique key.
// Value collection: collectI18nSampleValues() gathers the raw display
// strings themselves as corpus material for LLM term suggestion — the
// Lexicon holds curated domain terms, not raw UI strings.
//
// Output is intentionally CANDIDATES, not finalized LexiconTerm. Nothing
// merges them into .doklo/hub/lexicon.json anymore — the `doklo lexicon`
// command that did that was removed. The keys and their display values now
// serve as corpus material for `doklo lexicon-suggest` (its code corpus).
//
// Hardcoded JSX string extraction lives in `jsx-lexicon-extractor.ts` and
// is used as a fallback when this extractor finds no i18n files.
//
// Out of scope (future work):
//   - .ts / .tsx i18n modules (next-intl supports both)
//   - YAML / properties files
//   - Constant-binding extraction from code (e.g., LABELS.SAVE = 'Save')

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

export interface DiscoveredI18nFile {
  /** Locale code as it appears in the path (e.g., 'en', 'ko', 'ja'). */
  locale: string;
  /** Path relative to rootDir. */
  file: string;
  /** Optional namespace for next-i18next style (e.g., 'common', 'auth'). */
  namespace?: string;
}

export interface LexiconTermCandidate {
  /** TERM-XXX, derived deterministically from the key. */
  term_id: string;
  /** The original i18n key (e.g., 'nav.mypage'). */
  key: string;
  /** All files (relative to rootDir) where this key appears. Sorted. */
  files: string[];
  /** All locales where this key has a string value. Sorted. */
  supported_locales: string[];
  /** Sample text per locale — handy for human review in dry-run output. */
  sample_locales: Record<string, string>;
}

// ───────── discovery ──────────────────────────────────────────────

const LOCALE_RE = /^([a-z]{2,3}(?:-[A-Z]{2})?)\.json$/;

export function discoverI18nFiles(rootDir: string): DiscoveredI18nFile[] {
  const found: DiscoveredI18nFile[] = [];

  // 1) next-intl & custom: <root>/{messages,locales,i18n}/<locale>.json
  for (const dir of ['messages', 'locales', 'i18n']) {
    found.push(...scanFlatLocaleDir(rootDir, dir));
  }
  // 2) src layout: <root>/src/{locales,i18n}/<locale>.json
  for (const dir of ['src/locales', 'src/i18n']) {
    found.push(...scanFlatLocaleDir(rootDir, dir));
  }
  // 3) next-i18next: <root>/public/locales/<locale>/<ns>.json
  found.push(...scanNamespacedLocaleDir(rootDir, 'public/locales'));

  // Stable order across runs.
  found.sort((a, b) => a.file.localeCompare(b.file));
  return dedupe(found);
}

function scanFlatLocaleDir(rootDir: string, dir: string): DiscoveredI18nFile[] {
  const abs = join(rootDir, dir);
  if (!safeIsDir(abs)) return [];
  const out: DiscoveredI18nFile[] = [];
  for (const entry of readdirSync(abs)) {
    const m = entry.match(LOCALE_RE);
    if (!m) continue;
    const locale = m[1]!;
    out.push({ locale, file: relative(rootDir, join(abs, entry)) });
  }
  return out;
}

function scanNamespacedLocaleDir(rootDir: string, dir: string): DiscoveredI18nFile[] {
  const abs = join(rootDir, dir);
  if (!safeIsDir(abs)) return [];
  const out: DiscoveredI18nFile[] = [];
  for (const localeEntry of readdirSync(abs)) {
    const localeAbs = join(abs, localeEntry);
    if (!safeIsDir(localeAbs)) continue;
    if (!/^[a-z]{2,3}(?:-[A-Z]{2})?$/.test(localeEntry)) continue;
    for (const fileEntry of readdirSync(localeAbs)) {
      if (!fileEntry.endsWith('.json')) continue;
      const namespace = fileEntry.replace(/\.json$/, '');
      out.push({
        locale: localeEntry,
        namespace,
        file: relative(rootDir, join(localeAbs, fileEntry)),
      });
    }
  }
  return out;
}

function dedupe(files: DiscoveredI18nFile[]): DiscoveredI18nFile[] {
  const seen = new Set<string>();
  const out: DiscoveredI18nFile[] = [];
  for (const f of files) {
    if (seen.has(f.file)) continue;
    seen.add(f.file);
    out.push(f);
  }
  return out;
}

function safeIsDir(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

// ───────── extraction ─────────────────────────────────────────────

export interface ExtractLexiconOptions {
  rootDir: string;
  files: DiscoveredI18nFile[];
}

interface KeyAcc {
  key: string;
  files: Set<string>;
  locales: Map<string, string>; // locale → sample text (last-write wins on dupes within same locale)
}

export function extractLexiconCandidates(opts: ExtractLexiconOptions): LexiconTermCandidate[] {
  const accs = new Map<string, KeyAcc>();

  for (const f of opts.files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(opts.rootDir, f.file), 'utf-8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;

    for (const [key, value] of flatten(parsed as Record<string, unknown>, '')) {
      let acc = accs.get(key);
      if (!acc) {
        acc = { key, files: new Set(), locales: new Map() };
        accs.set(key, acc);
      }
      acc.files.add(f.file);
      acc.locales.set(f.locale, value);
    }
  }

  return [...accs.values()]
    .map((acc) => ({
      term_id: keyToTermId(acc.key),
      key: acc.key,
      files: [...acc.files].sort(),
      supported_locales: [...acc.locales.keys()].sort(),
      sample_locales: Object.fromEntries(acc.locales),
    }))
    .sort((a, b) => a.term_id.localeCompare(b.term_id));
}

/** Flatten a nested JSON object into [key, stringValue] pairs.
 *  Non-string leaves (arrays, numbers, booleans, null) are skipped. */
function* flatten(
  obj: Record<string, unknown>,
  prefix: string,
): Generator<[string, string]> {
  for (const [k, v] of Object.entries(obj)) {
    const next = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') {
      yield [next, v];
    } else if (v && typeof v === 'object' && !Array.isArray(v)) {
      yield* flatten(v as Record<string, unknown>, next);
    }
  }
}

function keyToTermId(key: string): string {
  const sanitized = key
    .toUpperCase()
    .replace(/[^A-Z0-9_-]+/g, '-') // dots, spaces, slashes → '-'
    .replace(/^-+|-+$/g, '') // trim leading/trailing dashes
    .replace(/-{2,}/g, '-'); // collapse runs
  if (!/^[A-Z]/.test(sanitized)) {
    // Edge case: key starts with non-letter; prefix with X.
    return `TERM-X-${sanitized}`;
  }
  return `TERM-${sanitized}`;
}

// ───────── corpus collection ──────────────────────────────────────

export interface CollectI18nValuesOptions {
  rootDir: string;
  files: DiscoveredI18nFile[];
  /** Maximum number of unique values returned (default 200). */
  cap?: number;
}

/** Collect unique display strings from discovered i18n files.
 *  Corpus material for LLM term suggestion — NOT term candidates.
 *  The Lexicon holds curated domain terms; raw UI strings only feed
 *  the model that nominates them. */
export function collectI18nSampleValues(opts: CollectI18nValuesOptions): string[] {
  const cap = opts.cap ?? 200;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const f of opts.files) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(join(opts.rootDir, f.file), 'utf-8'));
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    for (const [, value] of flatten(parsed as Record<string, unknown>, '')) {
      const v = value.trim();
      if (v.length === 0 || seen.has(v)) continue;
      seen.add(v);
      out.push(v);
      if (out.length >= cap) return out;
    }
  }
  return out;
}
