import { readFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import yaml from 'js-yaml';
import { z } from 'zod';
import { resolveTemplatePath } from './path-security.js';

/**
 * `theme.yaml` — the on-disk, author-facing visual theme. Every field is
 * optional; the engine fills gaps from ENGINE_DEFAULT_THEME, so a partial
 * theme.yaml only overrides what it names. `.strict()` rejects typos.
 */
// theme.yaml authors write colors as `#RRGGBB` (or bare `RRGGBB`). The leading
// `#` is intentionally accepted here; resolveTheme() normalizes to bare
// uppercase hex (no `#`) for the ResolvedTheme the pptx generator consumes.
const HexColor = z.string().regex(/^#?[0-9a-fA-F]{6}$/, 'must be a 6-digit hex color');

const FontPairSchema = z.object({ ko: z.string().optional(), en: z.string().optional() });

export const ThemeFileSchema = z
  .object({
    colors: z
      .object({
        accent: HexColor.optional(),
        header_text: HexColor.optional(),
        body_text: HexColor.optional(),
        muted_text: HexColor.optional(),
        background: HexColor.optional(),
      })
      .strict()
      .optional(),
    fonts: z
      .object({ body: FontPairSchema.optional(), heading: FontPairSchema.optional() })
      .strict()
      .optional(),
    logo: z
      .object({
        asset: z.string().min(1),
        position: z.enum(['top-left', 'top-right', 'none']).default('top-left'),
        max_height: z.number().positive().optional(),
      })
      .strict()
      .optional(),
    footer: z
      .object({
        text: z.record(z.string(), z.string()).optional(),
        show_page_number: z.boolean().optional(),
      })
      .strict()
      .optional(),
    cover: z
      .object({
        background_color: HexColor.optional(),
        background_image: z.string().min(1).nullable().optional(),
      })
      .strict()
      .optional(),
  })
  .strict();

export type ThemeFile = z.infer<typeof ThemeFileSchema>;

/** Fully-populated theme the pptx generator consumes. Colors are hex WITHOUT '#'. */
export interface ResolvedTheme {
  colors: { accent: string; headerText: string; bodyText: string; mutedText: string; background: string };
  fonts: { bodyKo: string; bodyEn: string; headingKo: string; headingEn: string };
  logo: { assetPath?: string; position: 'top-left' | 'top-right' | 'none'; maxHeight: number };
  footer: { text: string; showPageNumber: boolean };
  cover: { backgroundColor?: string; backgroundImagePath?: string };
}

/**
 * Mirrors the constants currently hardcoded in pptx/generate.ts (COLORS,
 * FONT_FACES). Keep in sync when that generator's defaults change; Task 3 of
 * the visual-templates plan migrates the generator to read this instead.
 */
export const ENGINE_DEFAULT_THEME: ResolvedTheme = {
  colors: { accent: 'D32F2F', headerText: '1A1A1A', bodyText: '333333', mutedText: '888888', background: 'FFFFFF' },
  fonts: { bodyKo: 'Pretendard', bodyEn: 'Inter', headingKo: 'Pretendard', headingEn: 'Inter' },
  logo: { position: 'none', maxHeight: 0.4 },
  footer: { text: '', showPageNumber: false },
  cover: {},
};

export interface ResolveThemeArgs {
  templateDir: string;
  workspaceRoot: string;
  locale: string;
  defaultLocale: string;
}

/** Read + validate a theme.yaml. Returns undefined if the file is absent; throws on invalid content. */
async function loadThemeFile(path: string): Promise<ThemeFile | undefined> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) return undefined; // absent → fine
    throw error;
  }
  return ThemeFileSchema.parse(yaml.load(raw) ?? {});
}

const stripHash = (c: string): string => c.replace(/^#/, '').toUpperCase();

async function fileExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Resolve a declared asset path against baseDir; returns the contained absolute
 * path if the file exists, else pushes a "<label> not found" warning and
 * returns undefined.
 *
 * The returned string is the resolver's own output, never a lexically rebuilt
 * `resolve(baseDir, declared)`. Consumers open it raw — the pptx generator
 * passes it straight to `addImage()` and `readFileSync()` — so handing back a
 * different string than the one containment approved would mean validating one
 * path and reading another.
 */
async function resolveAsset(
  declared: string,
  baseDir: string,
  label: string,
  warnings: string[],
): Promise<string | undefined> {
  const abs = await resolveTemplatePath(baseDir, declared, `theme ${label}`, {
    allowMissingLeaf: true,
  });
  if (await fileExists(abs)) return abs;
  warnings.push(`theme ${label} not found, skipping: ${declared}`);
  return undefined;
}

/**
 * Resolve a fully-populated ResolvedTheme by layering:
 *   ENGINE_DEFAULT_THEME ← template theme.yaml ← workspace .doklo/branding/theme.yaml
 * (later wins). Asset paths resolve against the dir that declared them; a
 * missing asset is dropped with a warning rather than failing the render.
 */
export async function resolveTheme(
  args: ResolveThemeArgs,
): Promise<{ theme: ResolvedTheme; warnings: string[] }> {
  const warnings: string[] = [];
  const brandingDir = resolve(args.workspaceRoot, '.doklo', 'branding');

  const tplThemePath = await resolveTemplatePath(
    args.templateDir,
    'theme.yaml',
    'template theme',
    { allowMissingLeaf: true },
  );
  const workspaceThemePath = await resolveTemplatePath(
    args.workspaceRoot,
    '.doklo/branding/theme.yaml',
    'workspace theme',
    { allowMissingLeaf: true },
  );
  const tplFile = await loadThemeFile(tplThemePath);
  const wsFile = await loadThemeFile(workspaceThemePath);

  const d = ENGINE_DEFAULT_THEME;
  const c = (k: keyof NonNullable<ThemeFile['colors']>, fallback: string): string => {
    const v = wsFile?.colors?.[k] ?? tplFile?.colors?.[k];
    return v ? stripHash(v) : fallback;
  };

  const fontBody = {
    ko: wsFile?.fonts?.body?.ko ?? tplFile?.fonts?.body?.ko,
    en: wsFile?.fonts?.body?.en ?? tplFile?.fonts?.body?.en,
  };
  const fontHead = {
    ko: wsFile?.fonts?.heading?.ko ?? tplFile?.fonts?.heading?.ko,
    en: wsFile?.fonts?.heading?.en ?? tplFile?.fonts?.heading?.en,
  };

  // logo: whichever source declared it wins (workspace over template); the
  // asset resolves against that source's base dir.
  const logoDecl = wsFile?.logo
    ? { logo: wsFile.logo, base: brandingDir }
    : tplFile?.logo
      ? { logo: tplFile.logo, base: args.templateDir }
      : undefined;
  let logoAssetPath: string | undefined;
  let logoPosition: ResolvedTheme['logo']['position'] = d.logo.position;
  let logoMaxHeight = d.logo.maxHeight;
  if (logoDecl) {
    logoPosition = logoDecl.logo.position;
    logoMaxHeight = logoDecl.logo.max_height ?? d.logo.maxHeight;
    if (logoDecl.logo.position !== 'none') {
      logoAssetPath = await resolveAsset(logoDecl.logo.asset, logoDecl.base, 'logo asset', warnings);
    }
  }

  // cover background image: same source-precedence + existence handling.
  const coverDecl = wsFile?.cover?.background_image
    ? { img: wsFile.cover.background_image, base: brandingDir }
    : tplFile?.cover?.background_image
      ? { img: tplFile.cover.background_image, base: args.templateDir }
      : undefined;
  const coverImagePath = coverDecl
    ? await resolveAsset(coverDecl.img, coverDecl.base, 'cover image', warnings)
    : undefined;
  const coverColorRaw = wsFile?.cover?.background_color ?? tplFile?.cover?.background_color;

  // footer text: active locale → default locale → '' .
  const footerMap = wsFile?.footer?.text ?? tplFile?.footer?.text;
  const footerText = footerMap?.[args.locale] ?? footerMap?.[args.defaultLocale] ?? d.footer.text;
  const showPageNumber = wsFile?.footer?.show_page_number ?? tplFile?.footer?.show_page_number ?? d.footer.showPageNumber;

  return {
    theme: {
      colors: {
        accent: c('accent', d.colors.accent),
        headerText: c('header_text', d.colors.headerText),
        bodyText: c('body_text', d.colors.bodyText),
        mutedText: c('muted_text', d.colors.mutedText),
        background: c('background', d.colors.background),
      },
      fonts: {
        bodyKo: fontBody.ko ?? d.fonts.bodyKo,
        bodyEn: fontBody.en ?? d.fonts.bodyEn,
        headingKo: fontHead.ko ?? fontBody.ko ?? d.fonts.headingKo,
        headingEn: fontHead.en ?? fontBody.en ?? d.fonts.headingEn,
      },
      logo: { assetPath: logoAssetPath, position: logoPosition, maxHeight: logoMaxHeight },
      footer: { text: footerText, showPageNumber },
      cover: { backgroundColor: coverColorRaw ? stripHash(coverColorRaw) : undefined, backgroundImagePath: coverImagePath },
    },
    warnings,
  };
}
