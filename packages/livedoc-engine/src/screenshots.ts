import { mkdir, readFile, readdir, stat } from 'node:fs/promises';
import { basename, dirname, extname } from 'node:path';
import { resolveTemplatePath } from './path-security.js';
import { writePlannedArtifact } from './atomic-output.js';
import { planRenderOutputs } from './output-plan.js';

/**
 * Screenshot discovery conventions (under `<workspaceRoot>/.doklo/screenshots/<DOK-ID>/`):
 *
 *   step-<N>.<ext>                     flat — the default layer
 *   <platform>/step-<N>.<ext>          platform-specific (desktop/mobile/tablet/tv/cli/voice)
 *
 * The engine copies every match into `<outDir>/_assets/screenshots/<DOK-ID>/...`
 * preserving the platform subdir, and exposes on the Handlebars context:
 *   - step_screenshots[i]                 default layer (flat, or desktop, or first platform)
 *   - step_screenshots_by_platform[plat]  per-platform arrays (only present platforms)
 *
 * Locale-scoped screenshots (`<locale>/step-N`, `<locale>/<platform>/step-N`) are
 * layered on top by passing `locale` + `supportedLocales`.
 *
 * No Playwright required at render time — the capture pipeline (or a human)
 * populates these dirs; render just discovers + copies.
 */

const SUPPORTED = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.avif']);
const KNOWN_PLATFORMS = ['desktop', 'mobile', 'tablet', 'tv', 'cli', 'voice'];

export interface CollectScreenshotsArgs {
  workspaceRoot: string;
  dokId: string;
  outDir: string;
  /** Number of steps in the Dok — sets the length of the returned arrays. */
  stepCount: number;
  /** Active locale; when set, `<DOK>/<locale>/...` is preferred over flat. */
  locale?: string;
  /** Workspace locales — distinguishes locale subdirs from platform subdirs. */
  supportedLocales?: string[];
  /** Discover and build template context without copying any artifact. */
  write?: boolean;
  /** Explicit replacement authorization for direct copy callers. */
  overwrite?: boolean;
}

/** Interaction box for a step, as % of the screenshot. Drawn as an overlay. */
export interface AnnotationRegion { x: number; y: number; w: number; h: number }

export interface CollectScreenshotsResult {
  /** Default layer (active-locale flat → flat → desktop → first platform), null per missing step. */
  stepScreenshots: (string | null)[];
  /** Per-platform arrays for any platform that has at least one screenshot. */
  stepScreenshotsByPlatform: Record<string, (string | null)[]>;
  /** Annotation box per step for the DEFAULT layer (null when none). */
  stepAnnotations: (AnnotationRegion | null)[];
  /** Annotation box per step per platform — mirrors stepScreenshotsByPlatform. */
  stepAnnotationsByPlatform: Record<string, (AnnotationRegion | null)[]>;
  /** Total screenshot files copied — manifest telemetry. */
  copied: number;
  /** Complete copy ledger used by render planning before its first write. */
  artifacts: ScreenshotArtifact[];
}

export interface ScreenshotArtifact {
  sourcePath: string;
  relativePath: string;
  dokId: string;
}

interface FoundShot {
  /** absolute source path */
  src: string;
  /** path relative to the <DOK> dir, e.g. "step-1.png" or "mobile/step-1.png" or "en/step-1.png" */
  rel: string;
  step: number;
  platform: string | null;
  locale: string | null;
}

export async function collectScreenshots(args: CollectScreenshotsArgs): Promise<CollectScreenshotsResult> {
  const empty: CollectScreenshotsResult = {
    stepScreenshots: new Array(args.stepCount).fill(null),
    stepScreenshotsByPlatform: {},
    stepAnnotations: new Array(args.stepCount).fill(null),
    stepAnnotationsByPlatform: {},
    copied: 0,
    artifacts: [],
  };
  const sourceDir = await resolveTemplatePath(
    args.workspaceRoot,
    `.doklo/screenshots/${args.dokId}`,
    'screenshot DOK ID',
    { allowMissingLeaf: true },
  );
  if (!(await dirExists(sourceDir))) return empty;

  const locales = new Set(args.supportedLocales ?? []);
  const found = (await scanShots(sourceDir, locales)).filter((f) => f.step <= args.stepCount);
  if (found.length === 0) return empty;

  const artifacts: ScreenshotArtifact[] = found.map((shot) => ({
    sourcePath: shot.src,
    relativePath: `_assets/screenshots/${args.dokId}/${shot.rel}`,
    dokId: args.dokId,
  }));

  // Direct callers keep the historical discover+copy API, but every file is
  // now committed through the same atomic no-clobber policy as render.
  let copied = 0;
  if (args.write !== false) {
    await mkdir(args.outDir, { recursive: true });
    const plan = await planRenderOutputs({
      outputRoot: args.outDir,
      outputDir: '',
      overwrite: args.overwrite === true,
      targets: [],
      screenshots: artifacts.map((artifact) => ({
        relativePath: artifact.relativePath,
        dokId: artifact.dokId,
      })),
    });
    for (const [index, artifact] of artifacts.entries()) {
      try {
        const bytes = await readFile(artifact.sourcePath);
        const planned = plan.outputs.find((output) =>
          output.format === 'screenshot'
          && output.relative_path === artifact.relativePath
          && output.dok_id === artifact.dokId);
        if (!planned) throw new Error(`planned screenshot is missing: ${artifact.relativePath}`);
        await writePlannedArtifact(plan.output_root, planned, bytes);
        copied += 1;
      } catch (error) {
        if (!isMissingPathError(error)) throw error;
        const foundShot = found[index];
        if (foundShot) foundShot.src = '';
      }
    }
  }
  const usable = found.filter((f) => f.src !== '');

  const urlFor = (f: FoundShot) => `_assets/screenshots/${args.dokId}/${f.rel}`;

  // Annotation lookup shared by the default + per-platform layers: each
  // chosen shot's annotations.json sits next to its step-N.png.
  const annCache = new Map<string, Map<number, AnnotationRegion>>();
  const annotationsFor = async (shots: (FoundShot | null)[]): Promise<(AnnotationRegion | null)[]> => {
    const out: (AnnotationRegion | null)[] = [];
    for (const shot of shots) {
      if (!shot) { out.push(null); continue; }
      const dir = dirname(shot.src);
      let byStep = annCache.get(dir);
      if (!byStep) {
        byStep = await loadAnnotations(dir);
        annCache.set(dir, byStep);
      }
      out.push(byStep.get(shot.step) ?? null);
    }
    return out;
  };

  // Build per-platform arrays. A platform's array prefers the active locale's
  // copy of that platform, else the locale-agnostic platform copy.
  const platformsPresent = new Set(usable.map((f) => f.platform).filter((p): p is string => p !== null));
  const byPlatform: Record<string, (string | null)[]> = {};
  const annByPlatform: Record<string, (AnnotationRegion | null)[]> = {};
  for (const plat of platformsPresent) {
    const shots = pickLayerShots(usable, args.stepCount, { platform: plat, locale: args.locale ?? null });
    byPlatform[plat] = shots.map((s) => (s ? urlFor(s) : null));
    annByPlatform[plat] = await annotationsFor(shots);
  }

  // Default layer (FoundShot per step), in fallback order.
  let defaultShots = pickLayerShots(usable, args.stepCount, { platform: null, locale: args.locale ?? null });
  const allNull = (a: (FoundShot | null)[]) => a.every((s) => s === null);
  if (allNull(defaultShots)) defaultShots = pickLayerShots(usable, args.stepCount, { platform: null, locale: null });
  if (allNull(defaultShots)) defaultShots = pickLayerShots(usable, args.stepCount, { platform: 'desktop', locale: args.locale ?? null });
  if (allNull(defaultShots)) {
    const first = [...platformsPresent][0] ?? null;
    if (first) defaultShots = pickLayerShots(usable, args.stepCount, { platform: first, locale: args.locale ?? null });
  }

  const stepScreenshots = defaultShots.map((s) => (s ? urlFor(s) : null));
  const stepAnnotations = await annotationsFor(defaultShots);

  return {
    stepScreenshots,
    stepScreenshotsByPlatform: byPlatform,
    stepAnnotations,
    stepAnnotationsByPlatform: annByPlatform,
    copied,
    artifacts,
  };
}

async function loadAnnotations(dir: string): Promise<Map<number, AnnotationRegion>> {
  const out = new Map<number, AnnotationRegion>();
  const annotationsPath = await resolveTemplatePath(
    dir,
    'annotations.json',
    'screenshot annotations',
    { allowMissingLeaf: true },
  );
  let raw: string;
  try {
    const { readFile } = await import('node:fs/promises');
    raw = await readFile(annotationsPath, 'utf-8');
  } catch (error) {
    if (isMissingPathError(error)) return out;
    throw error;
  }
  const parsed = JSON.parse(raw) as { regions?: Array<{ step: number; x: number; y: number; w: number; h: number }> };
  for (const r of parsed.regions ?? []) {
    if (typeof r.step === 'number') out.set(r.step, { x: r.x, y: r.y, w: r.w, h: r.h });
  }
  return out;
}

/**
 * Build a per-step array for one (platform, locale) target. For each step,
 * resolve in priority: exact (locale+platform) → platform-only-with-locale-flat
 * → platform → locale-flat → flat. Within the requested platform constraint.
 */
function pickLayerShots(
  shots: FoundShot[],
  stepCount: number,
  target: { platform: string | null; locale: string | null },
): (FoundShot | null)[] {
  const out: (FoundShot | null)[] = new Array(stepCount).fill(null);
  for (let i = 0; i < stepCount; i++) {
    const step = i + 1;
    const candidates = shots.filter((f) => f.step === step && f.platform === target.platform);
    if (candidates.length === 0) continue;
    const exact = candidates.find((f) => f.locale === target.locale);
    const agnostic = candidates.find((f) => f.locale === null);
    out[i] = exact ?? agnostic ?? candidates[0] ?? null;
  }
  return out;
}

async function scanShots(dokDir: string, locales: Set<string>): Promise<FoundShot[]> {
  const out: FoundShot[] = [];
  const top = await readDirSafe(dokDir);

  for (const name of top) {
    const full = await resolveTemplatePath(dokDir, name, 'screenshot entry');
    if (await isFile(full)) {
      const step = parseStep(name);
      if (step !== null) out.push({ src: full, rel: name, step, platform: null, locale: null });
      continue;
    }
    if (await dirExists(full)) {
      const sub = classify(name, locales);
      const inner = await readDirSafe(full);
      for (const innerName of inner) {
        const innerFull = await resolveTemplatePath(full, innerName, 'screenshot entry');
        if (await isFile(innerFull)) {
          const step = parseStep(innerName);
          if (step !== null) {
            out.push({
              src: innerFull,
              rel: `${name}/${innerName}`,
              step,
              platform: sub.platform,
              locale: sub.locale,
            });
          }
          continue;
        }
        // two levels: <locale>/<platform>/ or <platform>/<locale>/
        if (await dirExists(innerFull)) {
          const sub2 = classify(innerName, locales);
          const inner2 = await readDirSafe(innerFull);
          for (const leaf of inner2) {
            const leafFull = await resolveTemplatePath(innerFull, leaf, 'screenshot entry');
            if (await isFile(leafFull)) {
              const step = parseStep(leaf);
              if (step !== null) {
                out.push({
                  src: leafFull,
                  rel: `${name}/${innerName}/${leaf}`,
                  step,
                  platform: sub.platform ?? sub2.platform,
                  locale: sub.locale ?? sub2.locale,
                });
              }
            }
          }
        }
      }
    }
  }
  return out;
}

function classify(name: string, locales: Set<string>): { platform: string | null; locale: string | null } {
  if (KNOWN_PLATFORMS.includes(name)) return { platform: name, locale: null };
  if (locales.has(name)) return { platform: null, locale: name };
  return { platform: null, locale: null };
}

function parseStep(file: string): number | null {
  const ext = extname(file).toLowerCase();
  if (!SUPPORTED.has(ext)) return null;
  const m = /^step-(\d+)\b/i.exec(basename(file, ext));
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n >= 1 ? n : null;
}

async function readDirSafe(p: string): Promise<string[]> {
  try {
    return (await readdir(p)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
  } catch (error) {
    if (isMissingPathError(error)) return [];
    throw error;
  }
}
async function isFile(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isFile();
  } catch (error) {
    if (isMissingPathError(error)) return false;
    throw error;
  }
}
async function dirExists(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
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
