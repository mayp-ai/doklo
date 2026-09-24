import { z } from 'zod';
import { validateHelpPagePresentation } from './help-page-presentation.js';
import { DokIdSchema, DokStatusSchema, ServiceIdSchema } from '@doklo-beta/core';

/**
 * Text output formats produced by the Handlebars renderer.
 * `text` writes the rendered body verbatim, preserving the output_path
 * extension (.feature, Makefile, …) instead of normalizing to .md.
 * `hwpx` converts the rendered Markdown body to a Hangul .hwpx package.
 */
export const OutputFormatV1 = ['markdown', 'html', 'yaml', 'json', 'text', 'hwpx'] as const;

/**
 * All declarable formats. `pptx`/`xlsx` are only valid with the matching
 * binary renderer (not Handlebars text). docx/pdf remain v2 backlog.
 */
const AllOutputFormats = ['markdown', 'html', 'yaml', 'json', 'text', 'hwpx', 'pptx', 'xlsx'] as const;
const OutputFormatSchema = z.enum(AllOutputFormats);
export type OutputFormat = (typeof AllOutputFormats)[number];
const UNVALIDATED_STABLE_OUTPUT_FORMATS = new Set<string>(['hwpx', 'pptx', 'xlsx']);

export const TemplateOutputSourceSchema = z.enum([
  'markdown', 'html', 'yaml', 'json', 'text', 'binary',
]);
export type TemplateOutputSource = z.infer<typeof TemplateOutputSourceSchema>;

const TemplateOutputRecipeSchema = z.object({
  entry: z.string().min(1).optional(),
  output_path: z.string().min(1),
  source: TemplateOutputSourceSchema,
});
export type TemplateOutputRecipe = z.infer<typeof TemplateOutputRecipeSchema>;

/**
 * Which rendering pathway a template uses.
 * - handlebars (default): text templates → markdown/html/yaml/json/text
 * - pptx: a binary slide generator (per_dok), bypasses Handlebars; the body
 *   file is ignored and slides are built from the Dok + its screenshots.
 * - xlsx: a binary spreadsheet generator driven by the template's
 *   sheet.yaml spec (declarative columns over deterministic row joins).
 */
export const RendererSchema = z.enum(['handlebars', 'pptx', 'xlsx']);
export type Renderer = z.infer<typeof RendererSchema>;

export const TemplateScopeSchema = z.enum(['per_dok', 'workspace', 'selected_doks']);
export type TemplateScope = z.infer<typeof TemplateScopeSchema>;

export const TemplateSelectorSchema = z.object({
  include_tags: z.array(z.string()).optional(),
  include_services: z.array(ServiceIdSchema).optional(),
  include_statuses: z.array(DokStatusSchema).optional(),
  explicit_ids: z.array(DokIdSchema).optional(),
  exclude_tags: z.array(z.string()).optional(),
});
export type TemplateSelector = z.infer<typeof TemplateSelectorSchema>;

export const LocalizedStringMapSchema = z.record(z.string(), z.string());
const PublicationLocalizedMapSchema = z.record(z.string().min(1), z.string().min(1));

export const TemplateStabilitySchema = z.enum(['stable', 'experimental']);
export type TemplateStability = z.infer<typeof TemplateStabilitySchema>;

export const TemplateVariableDefinitionSchema = z
  .object({
    type: z.enum(['string', 'boolean', 'number']),
    required: z.boolean(),
    description: z.string().min(1),
    default: z.union([z.string(), z.boolean(), z.number().finite()]).optional(),
  })
  .refine(
    (definition) => definition.default === undefined || typeof definition.default === definition.type,
    { message: 'variable default must match its declared type', path: ['default'] },
  );
export type TemplateVariableDefinition = z.infer<typeof TemplateVariableDefinitionSchema>;

export const TemplateAuthorSchema = z.object({
  name: z.string().min(1),
  url: z.string().optional(),
  email: z.string().optional(),
});

const CommonManifestSchema = z
  .object({
    $schema: z.string().optional(),
    name: z
      .string()
      .min(1)
      .regex(/^[a-z0-9][a-z0-9.-]*$/, 'name must be lowercase kebab-case (dots allowed for version-style names like openapi-3.1)'),
    version: z.string().min(1),
    display_name: z.record(z.string(), z.string()).optional(),
    description: z.record(z.string(), z.string()).optional(),
    stability: TemplateStabilitySchema.default('experimental'),
    audience: PublicationLocalizedMapSchema.default({}),
    purpose: PublicationLocalizedMapSchema.default({}),
    job: PublicationLocalizedMapSchema.default({}),
    required_input: PublicationLocalizedMapSchema.default({}),
    variables: z.record(z.string(), TemplateVariableDefinitionSchema).default({}),
    author: TemplateAuthorSchema.optional(),
    license: z.string().optional(),
    renderer: RendererSchema.default('handlebars'),
    scope: TemplateScopeSchema,
    partials: z.record(z.string(), z.string()).optional(),
    supported_locales: z.array(z.string()).min(1),
    default_locale: z.string().min(1),
    strings: z.record(z.string(), LocalizedStringMapSchema).default({}),
    selector: TemplateSelectorSchema.optional(),
    requires_hub_layers: z.array(z.enum(['doks', 'lexicon', 'roles', 'ia', 'code-mapping'])).default(['doks']),
    min_engine_version: z.string().optional(),
    /**
     * When false, the engine's default.css is NOT included in the HTML
     * shell; only the template's own assets/style.css and workspace
     * branding are loaded. Use this when shipping a template that
     * deliberately replaces all base styling. Default: true (cascade).
     */
    extends_default_css: z.boolean().default(true),
  })
  .refine(
    (m) => m.scope !== 'selected_doks' || m.selector !== undefined,
    { message: "scope='selected_doks' requires a selector" },
  )
  .refine(
    (m) => m.supported_locales.includes(m.default_locale),
    { message: 'default_locale must be in supported_locales' },
  )
  .refine(
    (m) => m.stability !== 'stable' || [m.audience, m.purpose, m.job, m.required_input]
      .every((localized) => m.supported_locales.every((locale) => Boolean(localized[locale]))),
    { message: 'stable audience, purpose, job, and required_input must cover every supported locale' },
  );

const LegacyTemplateManifestInputSchema = CommonManifestSchema.extend({
  output_formats: z.array(OutputFormatSchema).min(1),
  output_path: z.string().min(1),
  entry: z.string().min(1).default('template.md.tpl'),
});

const CanonicalTemplateManifestInputSchema = CommonManifestSchema.extend({
  default_format: OutputFormatSchema.optional(),
  outputs: z.partialRecord(OutputFormatSchema, TemplateOutputRecipeSchema),
});

const RawTemplateManifestSchema = z.union([
  CanonicalTemplateManifestInputSchema,
  LegacyTemplateManifestInputSchema,
]);

type CommonManifest = z.infer<typeof CommonManifestSchema>;
export type TemplateManifest = CommonManifest & {
  outputs: Partial<Record<OutputFormat, TemplateOutputRecipe>>;
  default_format: OutputFormat;
  output_formats: OutputFormat[];
  /** Deprecated compatibility view of the default recipe. */
  entry: string;
  /** Deprecated compatibility view of the default recipe. */
  output_path: string;
};

const LegacyOutputSources: Record<OutputFormat, TemplateOutputSource> = {
  markdown: 'markdown',
  html: 'markdown',
  hwpx: 'markdown',
  yaml: 'yaml',
  json: 'yaml',
  text: 'text',
  pptx: 'binary',
  xlsx: 'binary',
};

const AllowedOutputSources: Record<OutputFormat, readonly TemplateOutputSource[]> = {
  markdown: ['markdown'],
  html: ['markdown', 'html'],
  yaml: ['yaml', 'json'],
  json: ['yaml', 'json'],
  text: ['text'],
  hwpx: ['markdown'],
  pptx: ['binary'],
  xlsx: ['binary'],
};

export const TemplateManifestSchema = RawTemplateManifestSchema
  .transform((raw, ctx): TemplateManifest | typeof z.NEVER => {
    if ('outputs' in raw) {
      const declaredFormats = AllOutputFormats.filter((format) => raw.outputs[format] !== undefined);
      if (declaredFormats.length === 0) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs'],
          message: 'canonical manifests require at least one output recipe',
        });
        return z.NEVER;
      }

      if (declaredFormats.length > 1 && raw.default_format === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['default_format'],
          message: 'canonical multi-output manifests require default_format',
        });
        return z.NEVER;
      }

      const defaultFormat = raw.default_format ?? declaredFormats[0]!;
      const defaultRecipe = raw.outputs[defaultFormat];
      if (defaultRecipe === undefined) {
        ctx.addIssue({
          code: 'custom',
          path: ['default_format'],
          message: 'default_format must name a declared output recipe',
        });
        return z.NEVER;
      }

      return {
        ...raw,
        outputs: raw.outputs,
        default_format: defaultFormat,
        output_formats: [defaultFormat, ...declaredFormats.filter((format) => format !== defaultFormat)],
        entry: defaultRecipe.entry ?? 'template.md.tpl',
        output_path: defaultRecipe.output_path,
      };
    }

    const sources = new Set(raw.output_formats.map((format) => LegacyOutputSources[format]));
    if (sources.size !== 1) {
      ctx.addIssue({
        code: 'custom',
        path: ['output_formats'],
        message: 'legacy output formats spanning multiple source families require explicit output recipes',
      });
      return z.NEVER;
    }

    const source = sources.values().next().value!;
    const outputs = Object.fromEntries(raw.output_formats.map((format) => [format, {
      entry: raw.entry,
      output_path: raw.output_path,
      source,
    }])) as Partial<Record<OutputFormat, TemplateOutputRecipe>>;
    const defaultFormat = raw.output_formats[0]!;

    return {
      ...raw,
      outputs,
      default_format: defaultFormat,
      output_formats: [...raw.output_formats],
    };
  })
  .superRefine((manifest, ctx) => {
    for (const format of manifest.output_formats) {
      const recipe = manifest.outputs[format]!;
      if (!AllowedOutputSources[format].includes(recipe.source)) {
        ctx.addIssue({
          code: 'custom',
          path: ['outputs', format, 'source'],
          message: `source '${recipe.source}' is not allowed for final format '${format}'`,
        });
      }
    }

    if (unvalidatedStableOutputFormats(manifest).length > 0) {
      ctx.addIssue({
        code: 'custom',
        path: ['output_formats'],
        message: 'stable templates cannot use output formats without validated stable-output evidence: hwpx, pptx, xlsx',
      });
    }

    if (manifest.renderer !== 'pptx' && manifest.output_formats.includes('pptx')) {
      ctx.addIssue({ code: 'custom', message: "output_format 'pptx' requires renderer: 'pptx'" });
    }
    if (manifest.renderer === 'pptx' && !manifest.output_formats.every((format) => format === 'pptx')) {
      ctx.addIssue({ code: 'custom', message: "renderer:'pptx' templates may only declare output formats: ['pptx']" });
    }
    if (manifest.renderer === 'pptx' && manifest.scope !== 'per_dok') {
      ctx.addIssue({ code: 'custom', message: "renderer:'pptx' requires scope: 'per_dok'" });
    }
    if (manifest.renderer !== 'xlsx' && manifest.output_formats.includes('xlsx')) {
      ctx.addIssue({ code: 'custom', message: "output_format 'xlsx' requires renderer: 'xlsx'" });
    }
    if (manifest.renderer === 'xlsx' && !manifest.output_formats.every((format) => format === 'xlsx')) {
      ctx.addIssue({ code: 'custom', message: "renderer:'xlsx' templates may only declare output formats: ['xlsx']" });
    }
  });

/**
 * Parse + validate a manifest payload (already JSON-parsed or YAML-parsed).
 * Throws ZodError on failure with a path that points at the offending field.
 */
export function parseTemplateManifest(raw: unknown): TemplateManifest {
  return TemplateManifestSchema.parse(raw);
}

export function unvalidatedStableOutputFormats(
  manifest: { stability: TemplateStability; output_formats: readonly string[] },
): string[] {
  if (manifest.stability !== 'stable') return [];
  return manifest.output_formats.filter((format) => UNVALIDATED_STABLE_OUTPUT_FORMATS.has(format));
}

export function coerceTemplateVariables(
  manifest: TemplateManifest,
  raw: Record<string, string>,
): Record<string, string | boolean | number> {
  const declared = manifest.variables;
  const unknown = Object.keys(raw).filter((name) => declared[name] === undefined).sort();
  if (unknown.length > 0) {
    throw new Error(`Unknown variable${unknown.length === 1 ? '' : 's'}: ${unknown.join(', ')}`);
  }

  const values: Record<string, string | boolean | number> = {};
  for (const name of Object.keys(declared).sort()) {
    const definition = declared[name]!;
    const value = raw[name];
    if (definition.required && (value === undefined || value === '')) {
      throw new Error(`Required variable '${name}' is missing`);
    }
    if (value === undefined || (value === '' && definition.type !== 'string')) {
      if (definition.default !== undefined) {
        values[name] = definition.default;
      }
      continue;
    }

    if (definition.type === 'string') {
      values[name] = value;
    } else if (definition.type === 'boolean') {
      if (value !== 'true' && value !== 'false') {
        throw new Error(`Variable '${name}' must be boolean 'true' or 'false'`);
      }
      values[name] = value === 'true';
    } else {
      const number = Number(value);
      if (!Number.isFinite(number)) {
        throw new Error(`Variable '${name}' must be a finite number`);
      }
      values[name] = number;
    }
  }
  if (manifest.name === 'help-page' && manifest.stability === 'stable') {
    validateHelpPagePresentation(values);
  }
  return values;
}
