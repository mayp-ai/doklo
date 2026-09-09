import { describe, expect, it } from 'vitest';
import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ENGINE_VERSION } from '../src/index.js';
import { parseTemplate } from '../src/template-parser.js';

const here = dirname(fileURLToPath(import.meta.url));
const builtinTemplates = join(here, '..', 'templates');

describe('livedoc-engine', () => {
  it('exposes ENGINE_VERSION', () => {
    expect(ENGINE_VERSION).toBe('1.0.0');
  });

  it('ships built-in templates as canonical output manifests', async () => {
    const names = await readdir(builtinTemplates);

    for (const name of names) {
      const dir = join(builtinTemplates, name);
      const raw = JSON.parse(await readFile(join(dir, 'doklo-template.json'), 'utf8'));

      expect(raw.$schema).toBe('https://doklo.dev/template-manifest-v2.json');
      expect(raw.outputs).toBeDefined();
      expect(raw).not.toHaveProperty('entry');
      expect(raw).not.toHaveProperty('output_path');
      expect(raw).not.toHaveProperty('output_formats');
      await expect(parseTemplate(dir)).resolves.toBeDefined();
    }
  });
});
