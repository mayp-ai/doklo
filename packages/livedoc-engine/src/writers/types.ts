import type { TemplateManifest, TemplateOutputSource } from '../template-manifest.js';
import type { PlannedOutput } from '../output-plan.js';

export interface WriterContext {
  /** Existing trusted ancestor used by the core containment primitive. */
  outputRoot: string;
  /** Full ledger entry whose action is the only replacement authority. */
  plannedOutput: PlannedOutput;
  /** Raw template render output (Markdown / YAML / JSON / text). */
  content: string;
  /** Syntax of the rendered template entry before final-format conversion. */
  source: TemplateOutputSource;
  template: TemplateManifest;
  locale: string;
  /** Engine-owned watermark, applied after customer-copy lint. */
  preview?: boolean;
  /**
   * Absolute path to the template directory (or single-file template path).
   * HTML writer reads `<templateDir>/assets/style.css` if present.
   */
  templateDir?: string;
  /**
   * Absolute workspace root. HTML writer reads
   * `<workspaceRoot>/.doklo/branding/livedoc.css` if present (brand cascade).
   */
  workspaceRoot?: string;
}

export interface WriterResult {
  /** Absolute path of the file written. */
  path: string;
  bytes: number;
  format: string;
}

export type Writer = (ctx: WriterContext) => Promise<WriterResult>;
