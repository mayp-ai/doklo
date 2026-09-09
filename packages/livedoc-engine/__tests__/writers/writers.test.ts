import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  getWriter as getPlannedWriter,
  InvalidJsonOutputError,
  InvalidYamlOutputError,
  KordocNotInstalledError,
  type WriterContext,
} from '../../src/writers/index.js';
import { plannedRelativePath } from '../../src/output-plan.js';
import { setKordocLoader } from '../../src/writers/hwpx.js';
import type { TemplateManifest } from '../../src/template-manifest.js';

function manifest(over: Partial<TemplateManifest> = {}): TemplateManifest {
  return {
    name: 't',
    version: '1.0.0',
    output_formats: ['markdown'],
    scope: 'workspace',
    output_path: 'out.md',
    entry: 'template.md.tpl',
    supported_locales: ['en'],
    default_locale: 'en',
    strings: {},
    requires_hub_layers: ['doks'],
    ...over,
  } as TemplateManifest;
}

async function withTmp<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), 'livedoc-writer-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

function getWriter(format: string) {
  const writer = getPlannedWriter(format);
  return async (ctx: WriterContext & { outDir?: string; outputPath?: string }) => {
    if (ctx.outputRoot) return writer(ctx);
    const outputRoot = await realpath(ctx.outDir!);
    const relativePath = plannedRelativePath(ctx.outputPath!, format);
    return writer({
      ...ctx,
      outputRoot,
      plannedOutput: {
        path: join(outputRoot, relativePath),
        relative_path: relativePath,
        format,
        exists: false,
        action: 'create',
      },
    });
  };
}

describe('markdownWriter', () => {
  it('writes content verbatim with .md extension', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'AUTH',
        content: '# Hello\n',
        source: 'markdown',
        template: manifest(),
        locale: 'en',
      };
      const r = await getWriter('markdown')(ctx);
      expect(r.path.endsWith('.md')).toBe(true);
      expect(await readFile(r.path, 'utf-8')).toBe('# Hello\n');
      expect(r.format).toBe('markdown');
    });
  });

  it('writes only to the exact planned target instead of deriving a destination', async () => {
    await withTmp(async (dir) => {
      const outputRoot = await realpath(dir);
      const targetPath = join(outputRoot, 'planned', 'AUTH.md');
      const ctx: WriterContext = {
        outDir: join(dir, 'legacy'),
        outputPath: 'wrong-place',
        outputRoot,
        plannedOutput: {
          path: targetPath,
          relative_path: 'planned/AUTH.md',
          format: 'markdown',
          exists: false,
          action: 'create',
        },
        content: '# Planned\n',
        source: 'markdown',
        template: manifest(),
        locale: 'en',
      };

      const result = await getPlannedWriter('markdown')(ctx);

      expect(result.path).toBe(targetPath);
      expect(await readFile(targetPath, 'utf8')).toBe('# Planned\n');
    });
  });
});

describe('htmlWriter', () => {
  it('produces a sanitized HTML shell from Markdown', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'AUTH',
        content: '# Hello\n\n<script>alert(1)</script>\n**bold**',
        source: 'markdown',
        template: manifest({ display_name: { en: 'My Doc' } }),
        locale: 'en',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('<h1');
      expect(html).toContain('My Doc');
      expect(html).toContain('<strong>bold</strong>');
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).toContain('lang="en"');
    });
  });

  it('uses the first h1 as the <title>, suffixed with the template display name', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'AUTH',
        content: '<h1 class="x">이메일 로그인</h1>\n\nbody text',
        source: 'markdown',
        template: manifest({ display_name: { ko: '도움말' }, default_locale: 'ko' }),
        locale: 'ko',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('<title>이메일 로그인 — 도움말</title>');
    });
  });

  it('falls back to the display name alone when content has no h1', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'AUTH',
        content: 'plain paragraph only',
        source: 'markdown',
        template: manifest({ display_name: { en: 'My Doc' } }),
        locale: 'en',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('<title>My Doc</title>');
    });
  });

  it('strips nested markup from the h1 when deriving the title', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'AUTH',
        content: '# Hello <em>World</em>\n',
        source: 'markdown',
        template: manifest({ display_name: { en: 'My Doc' } }),
        locale: 'en',
      };
      const r = await getWriter('html')(ctx);
      const html = await readFile(r.path, 'utf-8');
      expect(html).toContain('<title>Hello World — My Doc</title>');
    });
  });

  it('sanitizes an HTML source fragment without Markdown paragraph insertion', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'native',
        content: '<section><script>x()</script>Safe</section>',
        source: 'html',
        template: manifest({ display_name: { en: 'Native Doc' } }),
        locale: 'en',
      };

      const result = await getWriter('html')(ctx);
      const output = await readFile(result.path, 'utf8');

      expect(output).toContain('<section>Safe</section>');
      expect(output).not.toContain('<script>x()</script>');
      expect(output).not.toContain('<p><section>');
    });
  });
});

describe('yamlWriter', () => {
  it('round-trips valid YAML', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'openapi',
        content: 'openapi: 3.1.0\ninfo:\n  title: Test\n',
        source: 'yaml',
        template: manifest({ output_formats: ['yaml'] }),
        locale: 'en',
      };
      const r = await getWriter('yaml')(ctx);
      const out = await readFile(r.path, 'utf-8');
      expect(out).toMatch(/openapi: 3\.1\.0/);
    });
  });

  it('throws InvalidYamlOutputError on broken YAML', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'bad',
        content: 'key: [unclosed',
        source: 'yaml',
        template: manifest({ output_formats: ['yaml'] }),
        locale: 'en',
      };
      await expect(getWriter('yaml')(ctx)).rejects.toBeInstanceOf(InvalidYamlOutputError);
    });
  });

  it('parses JSON source before serializing YAML', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'from-json',
        content: '{"openapi":"3.1.0","info":{"title":"Test"}}',
        source: 'json',
        template: manifest({ output_formats: ['yaml'] }),
        locale: 'en',
      };

      const result = await getWriter('yaml')(ctx);
      const output = await readFile(result.path, 'utf8');

      expect(output).toContain('openapi: 3.1.0');
      expect(output).toContain('title: Test');
    });
  });
});

describe('jsonWriter', () => {
  it('round-trips JSON with 2-space indent', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'spec',
        content: '{"a":1,"b":[2,3]}',
        source: 'json',
        template: manifest({ output_formats: ['json'] }),
        locale: 'en',
      };
      const r = await getWriter('json')(ctx);
      const out = await readFile(r.path, 'utf-8');
      expect(out).toBe('{\n  "a": 1,\n  "b": [\n    2,\n    3\n  ]\n}');
    });
  });

  it('throws InvalidJsonOutputError on garbage', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'bad',
        content: '{[}',
        source: 'json',
        template: manifest({ output_formats: ['json'] }),
        locale: 'en',
      };
      await expect(getWriter('json')(ctx)).rejects.toBeInstanceOf(InvalidJsonOutputError);
    });
  });

  it('parses YAML source before serializing JSON', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'from-yaml',
        content: 'openapi: 3.1.0\ninfo:\n  title: Test\n',
        source: 'yaml',
        template: manifest({ output_formats: ['json'] }),
        locale: 'en',
      };

      const result = await getWriter('json')(ctx);
      const output = await readFile(result.path, 'utf8');

      expect(JSON.parse(output)).toEqual({
        openapi: '3.1.0',
        info: { title: 'Test' },
      });
    });
  });

  it('rejects YAML syntax when the declared source is JSON', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'invalid-source',
        content: 'openapi: 3.1.0',
        source: 'json',
        template: manifest({ output_formats: ['json'] }),
        locale: 'en',
      };

      await expect(getWriter('json')(ctx)).rejects.toThrow(/invalid JSON source/i);
    });
  });
});

describe('textWriter', () => {
  it('writes content verbatim and preserves the declared extension', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'AUTH.feature',
        content: '# language: ko\n기능: 이메일 로그인\n',
        source: 'text',
        template: manifest({ output_formats: ['text'] }),
        locale: 'ko',
      };
      const r = await getWriter('text')(ctx);
      expect(r.path.endsWith('AUTH.feature')).toBe(true);
      expect(await readFile(r.path, 'utf-8')).toBe('# language: ko\n기능: 이메일 로그인\n');
      expect(r.format).toBe('text');
    });
  });

  it('leaves extension-less paths untouched', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'Makefile',
        content: 'all:\n\techo hi\n',
        source: 'text',
        template: manifest({ output_formats: ['text'] }),
        locale: 'en',
      };
      const r = await getWriter('text')(ctx);
      expect(r.path.endsWith('Makefile')).toBe(true);
    });
  });
});

describe('hwpxWriter', () => {
  // Restore the real kordoc loader after any test that stubs it, so the
  // roundtrip tests below keep exercising the genuine lazy-import path.
  afterEach(() => setKordocLoader(null));

  it('throws a friendly, actionable error when the optional kordoc package is not installed', async () => {
    // Simulate `await import('kordoc')` failing to resolve the specifier —
    // exactly the shape Node emits when kordoc is absent.
    setKordocLoader(() =>
      Promise.reject(
        Object.assign(
          new Error("Cannot find package 'kordoc' imported from /x/writers/hwpx.js"),
          { code: 'ERR_MODULE_NOT_FOUND' },
        ),
      ),
    );
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'TEST-PLAN',
        content: '# 시험계획서\n',
        source: 'markdown',
        template: manifest({ output_formats: ['hwpx'] }),
        locale: 'ko',
      };
      const err = await getWriter('hwpx')(ctx).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(KordocNotInstalledError);
      expect((err as Error).message).toMatch(/kordoc/);
      expect((err as Error).message).toMatch(/npm install -g kordoc/);
    });
  });

  it('propagates a module-not-found for kordoc\'s OWN transitive dep (does not mislabel as missing kordoc)', async () => {
    // The message contains "kordoc" only as a path segment; the unresolved
    // specifier is onnxruntime-node, so this must pass through unchanged.
    setKordocLoader(() =>
      Promise.reject(
        Object.assign(
          new Error(
            "Cannot find package 'onnxruntime-node' imported from /x/node_modules/kordoc/dist/index.js",
          ),
          { code: 'ERR_MODULE_NOT_FOUND' },
        ),
      ),
    );
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'TEST-PLAN',
        content: '# 시험계획서\n',
        source: 'markdown',
        template: manifest({ output_formats: ['hwpx'] }),
        locale: 'ko',
      };
      const err = await getWriter('hwpx')(ctx).catch((e: unknown) => e);
      expect(err).not.toBeInstanceOf(KordocNotInstalledError);
      expect((err as Error).message).toMatch(/onnxruntime-node/);
    });
  });

  it('converts markdown to a valid hwpx package (kordoc roundtrip)', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'TEST-PLAN',
        content: '# 시험계획서\n\n| 시험ID | 항목 |\n| --- | --- |\n| TC-1 | 로그인 |\n',
        source: 'markdown',
        template: manifest({ output_formats: ['hwpx'] }),
        locale: 'ko',
      };
      const r = await getWriter('hwpx')(ctx);
      expect(r.path.endsWith('.hwpx')).toBe(true);
      expect(r.bytes).toBeGreaterThan(1000);
      const { parseHwpx } = await import('kordoc');
      const parsed = await parseHwpx(await readFile(r.path));
      expect((parsed as { success: boolean }).success).toBe(true);
      expect(JSON.stringify(parsed)).toContain('시험계획서');
    });
  });

  it('gives word-shaped label columns their full width (no mid-word wraps)', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'LABELS',
        content:
          '# 절차\n\n| 구분 | 설명 |\n| --- | --- |\n| 관리자 | 데이터 관리 화면에 진입하여 관리할 지원사업을 탐색하고 상세 데이터를 확인하는 긴 설명 문장 |\n',
        source: 'markdown',
        template: manifest({ output_formats: ['hwpx'] }),
        locale: 'ko',
      };
      const r = await getWriter('hwpx')(ctx);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(await readFile(r.path));
      const section = await zip.file('Contents/section0.xml')!.async('string');
      // 관리자(visual 6) label column → exactly 6*500+1600 = 4600 units,
      // wide enough to never break "관리자" mid-word
      expect(section).toContain('<hp:cellSz width="4600"');
    });
  });

  it('applies the house style: shaded bold header cells + centered title', async () => {
    await withTmp(async (dir) => {
      const ctx: WriterContext = {
        outDir: dir,
        outputPath: 'STYLED',
        content: '# 제목\n\n| 머리글 | 값 |\n| --- | --- |\n| 본문셀 | x |\n',
        source: 'markdown',
        template: manifest({ output_formats: ['hwpx'] }),
        locale: 'ko',
      };
      const r = await getWriter('hwpx')(ctx);
      const JSZip = (await import('jszip')).default;
      const zip = await JSZip.loadAsync(await readFile(r.path));
      const header = await zip.file('Contents/header.xml')!.async('string');
      const section = await zip.file('Contents/section0.xml')!.async('string');
      // borderFill registry rebased to Hancom's 1-based convention:
      // kordoc's 0(NONE)/1(SOLID) become 1/2, shaded header fill appended as 3
      expect(header).not.toContain('borderFill id="0"');
      expect(header).toContain('borderFill id="1"');
      expect(header).toContain('borderFill id="2"');
      expect(header).toContain('borderFill id="3"');
      expect(header).toContain('winBrush faceColor="#D9D9D9"');
      expect(header).toMatch(/<hh:borderFills itemCnt="3">/);
      // h1 paragraph style centered
      expect(header).toMatch(/<hh:paraPr id="1"[^>]*>\s*<hh:align horizontal="CENTER"/);
      // document-grade spacing in the GENUINE child-element form 한컴 reads
      // (attribute-form margins are silently ignored by 한컴)
      expect(header).not.toMatch(/<hh:margin indent="/);
      expect(header).toMatch(/<hh:paraPr id="0"[\s\S]*?<hp:switch>[\s\S]*?<hc:next value="300" unit="HWPUNIT"\/>/);
      expect(header).toMatch(/<hh:paraPr id="2"[\s\S]*?<hc:prev value="1600" unit="HWPUNIT"\/>/);
      // tables get outer margin + roomier cell padding
      expect(section).toContain('<hp:outMargin left="0" right="0" top="350" bottom="500"/>');
      expect(section).toMatch(/<hp:inMargin left="[^"]*" right="[^"]*" top="220" bottom="220"\/>/);
      // column widths reweighted by content — no longer equal splits
      const widths = [...section.matchAll(/<hp:cellSz width="(\d+)"/g)].map((m) => Number(m[1]));
      expect(new Set(widths).size).toBeGreaterThan(1);
      // header cells repointed to the shaded fill with bold runs
      const headerCell = /<hp:tc [^>]*header="1"[^>]*borderFillIDRef="3"[^>]*>[\s\S]*?charPrIDRef="1"/;
      expect(section).toMatch(headerCell);
      // body cells repointed to the shifted SOLID fill
      expect(section).toMatch(/<hp:tc [^>]*header="0"[^>]*borderFillIDRef="2"/);
      expect(section).not.toMatch(/borderFillIDRef="0"/);
      // mimetype still first + intact
      const names = Object.keys(zip.files);
      expect(names[0]).toBe('mimetype');
      // still parses
      const { parseHwpx } = await import('kordoc');
      const parsed = await parseHwpx(await readFile(r.path));
      expect((parsed as { success: boolean }).success).toBe(true);
    });
  });
});

describe('getWriter', () => {
  it('throws for unknown format', () => {
    expect(() => getWriter('pdf')).toThrow();
  });
});
