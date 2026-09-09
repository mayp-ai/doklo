import { describe, expect, it } from 'vitest';
import { execaNode } from 'execa';
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { scaffoldAction } from '../src/commands/template-scaffold.js';

const here = dirname(fileURLToPath(import.meta.url));
const cliEntry = join(here, '..', 'dist', 'index.js');
const prohibitedHtmlTag = /<(?:header|section|div|article)\b/i;

async function withWs<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(join(tmpdir(), 'scaffold-ws-'));
  try {
    return await fn(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

describe('cli: template scaffold', () => {
  it('detects prohibited structural HTML tags in a scaffold body', () => {
    expect('<header class="hero">').toMatch(prohibitedHtmlTag);
  });

  it('scaffolds a per_dok template with all 4 files + valid manifest', async () => {
    await withWs(async (root) => {
      expect(await scaffoldAction({
        name: 'my-faq',
        scope: 'per_dok',
        dest: 'workspace',
        root,
        force: false,
      })).toBe(0);

      const dir = join(root, '.doklo', 'templates', 'my-faq');
      for (const f of ['doklo-template.json', 'template.md.tpl', 'assets/style.css', 'README.md']) {
        expect(await stat(join(dir, f)).then(() => true).catch(() => false)).toBe(true);
      }
      const manifest = JSON.parse(await readFile(join(dir, 'doklo-template.json'), 'utf-8'));
      expect(manifest.name).toBe('my-faq');
      expect(manifest.scope).toBe('per_dok');
      expect(manifest.extends_default_css).toBe(false);
      expect(manifest).toMatchObject({
        stability: 'experimental',
        audience: { en: expect.any(String), ko: expect.any(String) },
        purpose: { en: expect.any(String), ko: expect.any(String) },
        job: { en: expect.any(String), ko: expect.any(String) },
        required_input: { en: expect.any(String), ko: expect.any(String) },
        variables: {},
        default_format: 'markdown',
        outputs: {
          markdown: { output_path: '{{dok.dok_id}}.md', source: 'markdown' },
          html: { output_path: '{{dok.dok_id}}.html', source: 'markdown' },
        },
      });
      const body = await readFile(join(dir, 'template.md.tpl'), 'utf8');
      expect(body).toMatch(/^# /);
      expect(body).not.toMatch(prohibitedHtmlTag);
    }, );
  }, 30000);

  it('scaffolded template passes its own validate', async () => {
    await withWs(async (root) => {
      await execaNode(cliEntry, ['template', 'scaffold', 'okx', '--scope', 'workspace', '--root', root], { reject: false });
      const dir = join(root, '.doklo', 'templates', 'okx');
      const raw = JSON.parse(await readFile(join(dir, 'doklo-template.json'), 'utf8'));
      const body = await readFile(join(dir, 'template.md.tpl'), 'utf8');
      expect(raw.default_format).toBe('markdown');
      expect(raw.outputs.markdown.source).toBe('markdown');
      expect(raw.outputs.html.source).toBe('markdown');
      expect(body).toMatch(/^# /);
      expect(body).not.toMatch(prohibitedHtmlTag);
      const v = await execaNode(cliEntry, [
        'template', 'validate', dir,
      ], { reject: false });
      expect(v.exitCode).toBe(0);
      expect(v.stdout).toContain('manifest valid');
    });
  }, 30000);

  it('selected_doks scaffold includes a selector stub', async () => {
    await withWs(async (root) => {
      await execaNode(cliEntry, ['template', 'scaffold', 'sel', '--scope', 'selected_doks', '--root', root], { reject: false });
      const manifest = JSON.parse(
        await readFile(join(root, '.doklo', 'templates', 'sel', 'doklo-template.json'), 'utf-8'),
      );
      expect(manifest.selector).toBeDefined();
      expect(manifest.selector.include_tags).toBeDefined();
    });
  }, 30000);

  it('rejects an invalid name', async () => {
    await withWs(async (root) => {
      const r = await execaNode(cliEntry, ['template', 'scaffold', 'Bad Name', '--root', root], { reject: false });
      expect(r.exitCode).toBe(1);
      expect(r.stderr).toContain('kebab-case');
    });
  }, 30000);

  it('refuses to overwrite without --force', async () => {
    await withWs(async (root) => {
      await execaNode(cliEntry, ['template', 'scaffold', 'dup', '--root', root], { reject: false });
      const second = await execaNode(cliEntry, ['template', 'scaffold', 'dup', '--root', root], { reject: false });
      expect(second.exitCode).toBe(1);
      expect(second.stderr).toContain('already exists');
      const forced = await execaNode(cliEntry, ['template', 'scaffold', 'dup', '--root', root, '--force'], { reject: false });
      expect(forced.exitCode).toBe(0);
    });
  }, 30000);
});
