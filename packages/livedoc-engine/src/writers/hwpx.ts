import type { Writer } from './types.js';
import { applyHwpxHouseStyle } from '../hwpx/style.js';
import { writePlannedArtifact } from '../atomic-output.js';
import { canonicalizeZipBytes } from '../canonical-zip.js';

/**
 * Type-only view of the kordoc module. `import type` / `typeof import(...)`
 * erase at compile time, so referencing kordoc's types here creates no
 * runtime dependency — the real module is pulled in lazily by `loadKordoc`.
 */
type KordocModule = typeof import('kordoc');

/**
 * Lazy loader for the optional `kordoc` package. kordoc drags a large,
 * platform-specific native dependency tree (onnxruntime-node, sharp,
 * @huggingface/transformers, @hyzyla/pdfium), so HWPX support is an *optional*
 * feature: the package is only imported when a .hwpx is actually rendered, and
 * doklo runs fine without it installed.
 *
 * Exposed as a mutable module-level binding + `setKordocLoader` so the
 * "kordoc not installed" path is unit-testable without uninstalling kordoc
 * from the dev tree (the engine tests are integration-style and don't use
 * module mocking). Production code never touches the setter.
 */
const importKordoc = (): Promise<KordocModule> => (
  import(/* webpackIgnore: true */ 'kordoc')
);

let loadKordoc: () => Promise<KordocModule> = importKordoc;

/** Test seam: override (or, with `null`, restore) how `kordoc` is loaded. */
export function setKordocLoader(loader: (() => Promise<KordocModule>) | null): void {
  loadKordoc = loader ?? importKordoc;
}

/**
 * Thrown when .hwpx rendering is requested but the optional `kordoc` package
 * is not installed. Follows the writer-local error convention used by the
 * json/yaml writers (see writers/json.ts, writers/yaml.ts). render.ts wraps
 * any writer throwable into a WRITER_FAILURE EngineError, preserving this
 * message, so the CLI surfaces the install hint.
 */
export class KordocNotInstalledError extends Error {
  constructor() {
    super(
      "HWPX rendering requires the optional 'kordoc' package (Korean HWPX toolchain with large native dependencies); install it next to doklo, e.g. `npm install -g kordoc`, then re-run.",
    );
    this.name = 'KordocNotInstalledError';
  }
}

/**
 * True only when `err` is a module-resolution failure for the `kordoc`
 * specifier ITSELF — not a genuine error thrown from *inside* kordoc (whose
 * message would name a different module, e.g. a missing onnxruntime-node, or a
 * path). We match the quoted specifier in the "Cannot find package/module
 * 'kordoc'" position so a kordoc path substring alone cannot false-positive,
 * which keeps real failures propagating unchanged.
 */
function isKordocSpecifierMissing(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (code !== 'ERR_MODULE_NOT_FOUND' && code !== 'MODULE_NOT_FOUND') return false;
  return /Cannot find (?:package|module) ['"]kordoc['"]/.test(err.message);
}

/**
 * Hangul .hwpx writer — the rendered Markdown body is converted to an
 * OWPML package via kordoc (headings, paragraphs, tables, bold/italic),
 * then finished with the house style (shaded bold table headers,
 * centered title) so it reads as a 산출물, not a text dump.
 *
 * Why this matters: 한국 공공 산출물(시험계획서·운영매뉴얼 등)은 한글(HWP)
 * 납품이 사실상 의무다. Templates author ordinary Markdown; this writer
 * makes the same body land as a document 한컴오피스 opens natively.
 *
 * kordoc is imported lazily here (not at module load) so it stays an optional
 * dependency — see `loadKordoc`.
 */
export const hwpxWriter: Writer = async (ctx) => {
  let markdownToHwpx: KordocModule['markdownToHwpx'];
  try {
    ({ markdownToHwpx } = await loadKordoc());
  } catch (err) {
    if (isKordocSpecifierMissing(err)) throw new KordocNotInstalledError();
    throw err;
  }
  const raw = await markdownToHwpx(ctx.content);
  const styled = await applyHwpxHouseStyle(Buffer.from(raw));
  const canonical = await canonicalizeZipBytes(styled);
  const path = await writePlannedArtifact(ctx.outputRoot, ctx.plannedOutput, canonical);
  return { path, bytes: canonical.byteLength, format: 'hwpx' };
};
