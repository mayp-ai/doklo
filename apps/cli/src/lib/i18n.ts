// Tiny i18n loader for the doklo CLI.
//
// JSON dictionaries live in apps/cli/src/i18n/{en,ko}.json. We read them at
// module load time via readFileSync so the loader works under both vitest
// (src/) and the compiled CLI (dist/, JSON copied by the build script).

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type I18nLocale = 'en' | 'ko';

const HERE = dirname(fileURLToPath(import.meta.url));
const I18N_DIR = join(HERE, '..', 'i18n');

type Dict = Record<string, string>;

function loadDict(locale: I18nLocale): Dict {
  const raw = readFileSync(join(I18N_DIR, `${locale}.json`), 'utf-8');
  return JSON.parse(raw) as Dict;
}

const EN: Dict = loadDict('en');
const KO: Dict = loadDict('ko');

const TABLE: Record<I18nLocale, Dict> = { en: EN, ko: KO };

type Params = Record<string, string | number>;

function format(template: string, params?: Params): string {
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (_, key: string) =>
    Object.prototype.hasOwnProperty.call(params, key) ? String(params[key]) : `{${key}}`,
  );
}

export type I18nKey = string;

export interface I18nT {
  (key: I18nKey, params?: Params): string;
}

export function createI18n(locale: I18nLocale): I18nT {
  const primary = TABLE[locale];
  return (key, params) => {
    const template = primary[key] ?? EN[key] ?? key;
    return format(template, params);
  };
}
