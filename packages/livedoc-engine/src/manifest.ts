import type { TranslateCollector } from '@doklo-beta/core';
import { ENGINE_VERSION } from './version.js';
import type { TemplateManifest, TemplateScope } from './template-manifest.js';
import type { WriterResult } from './writers/index.js';
import type { TemplateSource } from './template-loader.js';
import type { EngineErrorDetail } from './errors.js';
import { writePlannedArtifact } from './atomic-output.js';
import type { PlannedOutput } from './output-plan.js';
import type { ReproducibleRenderOutputPlan } from './output-plan.js';

export interface LivedocManifestOutputEntry {
  path: string;
  relative_path?: string;
  dok_id?: string;
  format: string;
  bytes: number;
  sha256?: string;
}

export interface LivedocManifestWarning {
  code: string;
  message: string;
  dok_id?: string;
  field?: string;
}

export interface LivedocManifest {
  /** Present only for review-only artifacts; never official Publication evidence. */
  render_mode?: 'draft-preview';
  engine_version: string;
  template: {
    name: string;
    version: string;
    source: TemplateSource;
    stability: TemplateManifest['stability'];
    audience: TemplateManifest['audience'];
    purpose: TemplateManifest['purpose'];
    job: TemplateManifest['job'];
    required_input: TemplateManifest['required_input'];
    variables: TemplateManifest['variables'];
    output_formats: TemplateManifest['output_formats'];
  };
  locale: string;
  primary_locale: string;
  workspace_root: string;
  generated_at: string;
  scope: TemplateScope;
  selector_applied: boolean;
  outputs: LivedocManifestOutputEntry[];
  translation: {
    resolved: number;
    fallback_to_primary: number;
    fallback_to_first_available: number;
    unresolved_terms: string[];
  };
  strings: {
    missing_keys: string[];
  };
  warnings: LivedocManifestWarning[];
  errors: EngineErrorDetail[];
  publication?: {
    name: string;
    definition_path: string;
    definition_sha256: string;
    selected_dok_ids: string[];
    rendered_dok_ids?: string[];
    locale: string;
    variables: Record<string, string>;
    plan: ReproducibleRenderOutputPlan;
    warnings: string[];
  };
}

export interface BuildManifestArgs {
  renderMode?: 'draft-preview';
  template: LivedocManifest['template'];
  locale: string;
  primaryLocale: string;
  workspaceRoot: string;
  scope: TemplateScope;
  selectorApplied: boolean;
  outputs: Array<WriterResult & { dokId?: string }>;
  collector: TranslateCollector;
  stringsMissing: Set<string>;
  warnings: LivedocManifestWarning[];
  errors: EngineErrorDetail[];
  generatedAt?: string;
}

export function buildManifest(args: BuildManifestArgs): LivedocManifest {
  return {
    ...(args.renderMode ? { render_mode: args.renderMode } : {}),
    engine_version: ENGINE_VERSION,
    template: args.template,
    locale: args.locale,
    primary_locale: args.primaryLocale,
    workspace_root: args.workspaceRoot,
    generated_at: args.generatedAt ?? new Date().toISOString(),
    scope: args.scope,
    selector_applied: args.selectorApplied,
    outputs: args.outputs.map((o) => ({
      path: o.path,
      dok_id: o.dokId,
      format: o.format,
      bytes: o.bytes,
    })),
    translation: {
      resolved: args.collector.resolvedCount,
      fallback_to_primary: args.collector.fallbackToPrimaryCount,
      fallback_to_first_available: args.collector.fallbackToOtherCount,
      unresolved_terms: Array.from(args.collector.unresolved).sort(),
    },
    strings: {
      missing_keys: Array.from(args.stringsMissing).sort(),
    },
    warnings: args.warnings,
    errors: args.errors,
  };
}

export async function writeManifest(
  outputRoot: string,
  output: PlannedOutput,
  m: LivedocManifest,
): Promise<string> {
  return writePlannedArtifact(
    outputRoot,
    output,
    `${JSON.stringify(m, null, 2)}\n`,
  );
}

/** Preview labels are incompatible with official saved-publication evidence. */
export function hasDraftPreviewMarker(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.render_mode === 'draft-preview') return true;
  return Array.isArray(record.warnings) && record.warnings.some((warning: unknown) => (
    typeof warning === 'string'
      ? warning.startsWith('DRAFT_PREVIEW')
      : Boolean(warning && typeof warning === 'object' && (warning as Record<string, unknown>).code === 'DRAFT_PREVIEW')
  ));
}
