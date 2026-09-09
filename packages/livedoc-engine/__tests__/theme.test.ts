import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { ThemeFileSchema, ENGINE_DEFAULT_THEME, resolveTheme } from '../src/theme.js';

// Canonicalized so the only symlink in a sandbox is the one a test creates
// on purpose — on macOS the temp path is itself symlinked (/var → /private/var).
async function tmp<T>(fn: (d: string) => Promise<T>): Promise<T> {
  const raw = await mkdtemp(join(tmpdir(), 'theme-'));
  const d = await realpath(raw);
  try { return await fn(d); } finally { await rm(raw, { recursive: true, force: true }); }
}

describe('ThemeFileSchema', () => {
  it('accepts an empty object (all fields optional)', () => {
    expect(ThemeFileSchema.parse({})).toEqual({});
  });

  it('accepts a full valid theme file', () => {
    const t = ThemeFileSchema.parse({
      colors: { accent: '#0B3D91' },
      fonts: { body: { ko: '맑은 고딕', en: 'Inter' }, heading: { ko: '맑은 고딕' } },
      logo: { asset: 'assets/logo.png', position: 'top-right', max_height: 0.5 },
      footer: { text: { ko: '○○부 · 대외비', en: 'Ministry' }, show_page_number: true },
      cover: { background_color: '#0B3D91', background_image: null },
    });
    expect(t.logo?.position).toBe('top-right');
  });

  it('defaults logo.position to top-left', () => {
    const t = ThemeFileSchema.parse({ logo: { asset: 'a.png' } });
    expect(t.logo?.position).toBe('top-left');
  });

  it('rejects a malformed hex color', () => {
    expect(() => ThemeFileSchema.parse({ colors: { accent: 'navy' } })).toThrow();
  });

  it('rejects unknown top-level keys (strict)', () => {
    expect(() => ThemeFileSchema.parse({ banner: true })).toThrow();
  });
});

describe('ENGINE_DEFAULT_THEME', () => {
  it('carries the current generator constants (resolved form)', () => {
    expect(ENGINE_DEFAULT_THEME.colors.accent).toBe('D32F2F');
    expect(ENGINE_DEFAULT_THEME.fonts.bodyKo).toBe('Pretendard');
    expect(ENGINE_DEFAULT_THEME.fonts.bodyEn).toBe('Inter');
    expect(ENGINE_DEFAULT_THEME.logo.position).toBe('none');
    expect(ENGINE_DEFAULT_THEME.footer.text).toBe('');
    expect(ENGINE_DEFAULT_THEME.footer.showPageNumber).toBe(false);
  });
});

describe('resolveTheme', () => {
  it('returns the engine default when no theme files exist', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl'); await mkdir(tpl, { recursive: true });
      const { theme, warnings } = await resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.colors.accent).toBe('D32F2F');
      expect(theme.footer.text).toBe('');
      expect(warnings).toEqual([]);
    });
  });

  it('merges template theme over the default and strips the # from colors', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl'); await mkdir(tpl, { recursive: true });
      await writeFile(join(tpl, 'theme.yaml'), 'colors:\n  accent: "#0B3D91"\n');
      const { theme } = await resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.colors.accent).toBe('0B3D91');
      expect(theme.colors.bodyText).toBe('333333'); // untouched default
    });
  });

  it('lets the workspace branding theme win over the template theme', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl'); await mkdir(tpl, { recursive: true });
      await writeFile(join(tpl, 'theme.yaml'), 'colors:\n  accent: "#0B3D91"\n');
      const brand = join(root, '.doklo', 'branding'); await mkdir(brand, { recursive: true });
      await writeFile(join(brand, 'theme.yaml'), 'colors:\n  accent: "#AA0000"\n');
      const { theme } = await resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.colors.accent).toBe('AA0000');
    });
  });

  it('resolves footer text for the active locale, falling back to default locale', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl'); await mkdir(tpl, { recursive: true });
      await writeFile(join(tpl, 'theme.yaml'),
        'footer:\n  text:\n    en: "Confidential"\n  show_page_number: true\n');
      const { theme } = await resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.footer.text).toBe('Confidential'); // ko absent → en
      expect(theme.footer.showPageNumber).toBe(true);
    });
  });

  // resolveTheme must hand back the path the contained-path resolver approved,
  // which is canonical, because consumers open it directly.
  //
  // Both of these reach the base directory through a symlink placed by the test
  // rather than relying on the platform's temp directory to contain one. On
  // macOS /var is itself a symlink, so comparing against realpath() alone would
  // catch a lexical return there and silently pass on the Linux CI runner,
  // where the temp path is already canonical and lexical == canonical.
  it('resolves a declared logo asset to its canonical path through a symlinked template dir', async () => {
    await tmp(async (root) => {
      const realTpl = join(root, 'real-tpl');
      const tpl = join(root, 'tpl');
      await mkdir(join(realTpl, 'assets'), { recursive: true });
      await writeFile(join(realTpl, 'assets', 'logo.png'), 'x');
      await writeFile(join(realTpl, 'theme.yaml'), 'logo:\n  asset: "assets/logo.png"\n  position: "top-right"\n');
      await symlink(realTpl, tpl);
      const { theme, warnings } = await resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.logo.assetPath).toBe(join(realTpl, 'assets', 'logo.png'));
      expect(theme.logo.assetPath).not.toBe(join(tpl, 'assets', 'logo.png'));
      expect(theme.logo.position).toBe('top-right');
      expect(warnings).toEqual([]);
    });
  });

  it('resolves a workspace-branding logo against the branding dir (winning over template)', async () => {
    await tmp(async (root) => {
      const realWs = join(root, 'real-ws');
      const ws = join(root, 'ws');
      const tpl = join(realWs, 'tpl'); await mkdir(tpl, { recursive: true });
      await writeFile(join(tpl, 'theme.yaml'), 'logo:\n  asset: "assets/tpl-logo.png"\n');
      const brand = join(realWs, '.doklo', 'branding');
      await mkdir(join(brand, 'assets'), { recursive: true });
      await writeFile(join(brand, 'assets', 'brand-logo.png'), 'x');
      await writeFile(join(brand, 'theme.yaml'), 'logo:\n  asset: "assets/brand-logo.png"\n');
      await symlink(realWs, ws);
      const { theme } = await resolveTheme({
        templateDir: tpl, workspaceRoot: ws, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.logo.assetPath).toBe(join(brand, 'assets', 'brand-logo.png'));
      expect(theme.logo.assetPath)
        .not.toBe(join(ws, '.doklo', 'branding', 'assets', 'brand-logo.png'));
    });
  });

  it('warns and skips when the logo asset file is missing', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl'); await mkdir(tpl, { recursive: true });
      await writeFile(join(tpl, 'theme.yaml'), 'logo:\n  asset: "assets/missing.png"\n');
      const { theme, warnings } = await resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      });
      expect(theme.logo.assetPath).toBeUndefined();
      expect(warnings.some((w) => w.includes('missing.png'))).toBe(true);
    });
  });

  it('throws on an invalid theme.yaml (Zod)', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl'); await mkdir(tpl, { recursive: true });
      await writeFile(join(tpl, 'theme.yaml'), 'colors:\n  accent: "navy"\n');
      await expect(resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      })).rejects.toThrow();
    });
  });

  it('propagates a non-missing theme file read error', async () => {
    await tmp(async (root) => {
      const tpl = join(root, 'tpl');
      await mkdir(join(tpl, 'theme.yaml'), { recursive: true });

      await expect(resolveTheme({
        templateDir: tpl, workspaceRoot: root, locale: 'ko', defaultLocale: 'en',
      })).rejects.toMatchObject({ code: 'EISDIR' });
    });
  });
});
