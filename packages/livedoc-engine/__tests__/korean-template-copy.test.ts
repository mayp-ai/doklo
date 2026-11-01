import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * The Korean sentences a template itself writes into a document (headings,
 * intros, the support block) sit next to Dok prose written in the workspace's
 * chosen register — 합쇼체, 해라체 or, since 2026-10-18, 해요체. A template line
 * that ends in ~합니다 reads as a register mix under the other two, so template
 * copy that is rendered into the document ends in a noun phrase or a label,
 * never in a sentence-final verb of one register.
 */
const RENDERED_COPY_TEMPLATES = ['help-page', 'help-index', 'release-digest', 'feature-spec', 'feature-matrix', 'permission-gap', 'github-onboarding', 'keep-a-changelog'];
const REGISTER_ENDING = /(?:습니다|니다|십시오|한다|된다|해요|세요|돼요)[.!]?$/u;

function walk(value: unknown, path: string, out: Array<[string, string]>): void {
  if (typeof value === 'string') out.push([path, value]);
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) walk(v, `${path}.${k}`, out);
}

describe('Korean template copy is register-neutral', () => {
  it.each(RENDERED_COPY_TEMPLATES)('%s: no ko string rendered into the document ends in a register-bound verb', async (template) => {
    const manifest = JSON.parse(await readFile(join(here, '../templates', template, 'doklo-template.json'), 'utf8'));
    const strings: Array<[string, string]> = [];
    walk(manifest.strings?.ko, 'strings.ko', strings);
    expect(strings.length).toBeGreaterThan(0);
    const bound = strings.filter(([, text]) => REGISTER_ENDING.test(text.trim()));
    expect(bound, bound.map(([k, v]) => `${k}: ${v}`).join('\n')).toEqual([]);
  });
});
