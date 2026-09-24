import { createHash } from 'node:crypto';
import { constants, type Dirent } from 'node:fs';
import {
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  realpath,
} from 'node:fs/promises';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  posix,
  relative,
  resolve,
  sep,
} from 'node:path';
import yaml from 'js-yaml';
import { marked } from 'marked';
import { ZodError } from 'zod';
import {
  actorLabel,
  assertContainedPathIdentity,
  captureContainedPathIdentity,
  captureDirectoryPublishDestination,
  loadHubModel,
  makeCollector,
  PathOutsideRootError,
  publishDirectoryContained,
  removeContained,
  resolveContainedPath,
  resolveTranslatable,
  type Dok,
  type ContainedPathIdentity,
  type DirectoryPublishDestinationSnapshot,
  type HubModel,
  type TranslateCollector,
} from '@doklo-beta/core';
import { renderPptxBuffer, type PptxStep, type PptxView } from './pptx/generate.js';
import { generateXlsxBuffer } from './xlsx/generate.js';
import { parseXlsxSpec, type XlsxSpec } from './xlsx/spec.js';
import { resolveTheme } from './theme.js';
import { createEngine } from './handlebars-setup.js';
import { resolveTemplate, type TemplateSource } from './template-loader.js';
import { TemplateParseError } from './template-parser.js';
import {
  coerceTemplateVariables,
  unvalidatedStableOutputFormats,
  type OutputFormat,
  type TemplateManifest,
  type TemplateOutputSource,
} from './template-manifest.js';
import { selectDoks } from './selector.js';
import {
  collectScreenshots,
  type AnnotationRegion,
  type ScreenshotArtifact,
} from './screenshots.js';
import { getWriter, type WriterResult } from './writers/index.js';
import {
  buildManifest,
  hasDraftPreviewMarker,
  writeManifest,
  type LivedocManifest,
  type LivedocManifestWarning,
} from './manifest.js';
import type { ServiceAwareHelperRoot, AudienceDictionary } from './helpers/index.js';
import { EngineError, type EngineErrorDetail } from './errors.js';
import { ENGINE_VERSION } from './version.js';
import { resolveTemplatePath } from './path-security.js';
import {
  planRenderOutputs,
  plannedRelativePath,
  reproducibleRenderOutputPlan,
  resolveOutputDestination,
  type PlannedOutput,
  type ReproducibleRenderOutputPlan,
  type RenderOutputPlan,
} from './output-plan.js';
import { OutputExistsError, writePlannedArtifact } from './atomic-output.js';
import {
  lintStableArtifact,
  lintStableMarkdown,
  StableLintError,
  type StableLintViolation,
} from './stable-lint.js';
import { loadWorkspaceAudienceDictionary } from './audience-dictionary.js';
import { buildChangelog } from './changelog.js';
import { prepareStableHelpCopy } from './stable-help-copy.js';
import { checkKoreanHelpWriting } from './korean-writing-policy.js';
import { helpPagePresentation } from './help-page-presentation.js';
import {
  publicationDigest,
  type PublicationFormat,
  type PublicationV1,
} from './publication.js';
import {
  PublicationSelectionError,
  selectPublicationDoks,
} from './render-selection.js';
import { writeArtifactAtomic } from './atomic-output.js';
import {
  buildDokSnapshots,
  classifyDokChanges,
  type DokChangeSet,
  type EvidenceDokSnapshot,
} from './dok-changes.js';
import { effectiveRenderInputDigest } from './render-input-digest.js';

const CANONICAL_EPOCH = '1970-01-01T00:00:00.000Z';

export interface RenderLivedocInput {
  workspaceRoot: string;
  templateRef: string;
  locale: string;
  primaryLocale?: string;
  outDir: string;
  dokIds?: string[];
  source?: TemplateSource;
  userHome?: string;
  builtinRoot?: string;
  variables?: Record<string, string>;
  /** Extra template-context keys (spread first; fixed keys always win). */
  extraContext?: Record<string, unknown>;
  /** Render exactly one format declared by the template. */
  format?: PublicationFormat;
  /** Render every format declared by the template. */
  allFormats?: boolean;
  overwrite?: boolean;
  dryRun?: boolean;
  /** Review-only stable Markdown/HTML output; accepts drafts without approving the Hub. */
  preview?: boolean;
  /** Anchor planned relative paths to a stable existing root. */
  outputRoot?: string;
  /** Reserve outputs written by a higher-level orchestrator. */
  additionalPlannedOutputs?: Array<{
    relativePath: string;
    format: string;
    dokId?: string;
  }>;
  /** Additional immutable inputs that must appear in the plan. */
  additionalSourcePaths?: string[];
  /** Skip the html writer even when output_formats declares it. CLI --no-html. */
  noHtml?: boolean;
  /** Treat zero-match selector as an error (default warning). CLI --strict. */
  strict?: boolean;
  /** Project audience-text substitutions for the active locale (CLI loads .doklo/audience-text.json). */
  audienceDictionary?: AudienceDictionary;
  /** Cooperative cancellation checked only at atomic artifact boundaries. */
  signal?: AbortSignal;
  /** Reports an artifact only after its atomic write has completed. */
  onOutputWritten?: (output: PlannedOutput) => void;
}

export interface RenderLivedocResult {
  outputs: Array<WriterResult & { dokId?: string }>;
  manifest: LivedocManifest;
  manifestPath?: string;
  plan: RenderOutputPlan;
}

export type PublicationRenderEvidence = {
  schema_version: 1;
  command: 'live-docs.publication.render';
  publication: {
    name: string;
    definition_path: string;
    definition_sha256: string;
  };
  template: {
    name: string;
    version: string;
    stability: 'stable' | 'experimental';
  };
  selected_dok_ids: string[];
  /** Doks that survived stable output checks and actually contributed to artifacts. */
  rendered_dok_ids?: string[];
  /**
   * Digest of canonical Hub, Template, locale, variables, and runtime content.
   * Optional only so evidence written before this field remains parseable.
   */
  render_input_sha256?: string;
  /** Per-Dok baseline for the next render's change classification. */
  dok_snapshots: EvidenceDokSnapshot[];
  plan: ReproducibleRenderOutputPlan;
  outputs: Array<{
    path: string;
    relative_path: string;
    format: string;
    bytes: number;
    sha256: string;
    dok_id?: string;
  }>;
  warnings: string[];
  manifest_path: string;
};

export type PublicationRenderSuccessData = Omit<PublicationRenderEvidence, 'plan'> & {
  /** Truthful plan for this invocation, including transient exists/action state. */
  plan: RenderOutputPlan;
  /** Stable plan serialized into the manifest and success evidence. */
  evidence_plan: ReproducibleRenderOutputPlan;
};

export type PublicationRenderCancellation = {
  publication: PublicationRenderEvidence['publication'];
  plan: RenderOutputPlan;
  completed_outputs: PlannedOutput[];
  unfinished_outputs: PlannedOutput[];
};

export type PublicationRenderCommandResult = {
  schema_version: 1;
  command: 'live-docs.publication.render';
  status: 'success';
  data: PublicationRenderSuccessData;
  diagnostics: [];
} | {
  schema_version: 1;
  command: 'live-docs.publication.render';
  status: 'cancelled';
  data: PublicationRenderCancellation;
  diagnostics: Array<{ code: 'PUBLICATION_RENDER_INTERRUPTED'; message: string }>;
} | {
  schema_version: 1;
  command: 'live-docs.publication.render';
  status: 'failed';
  data: null;
  diagnostics: Array<{ code: string; message: string; retryable?: boolean }>;
};

export interface RenderPublicationInput {
  workspaceRoot: string;
  publication: PublicationV1;
  definition: { path: string; sha256: string };
  overwrite?: boolean;
  dryRun?: boolean;
  signal?: AbortSignal;
  onPlan?: (plan: RenderOutputPlan) => void;
  onArtifactWritten?: (output: PlannedOutput) => void;
}

type SelectedTarget = { dok?: Dok; doks?: Dok[]; key: string };

type PreparedTextOutput = {
  relativePath: string;
  format: string;
  content: string;
  source: TemplateOutputSource;
  dokId?: string;
  templateDir?: string;
};

type CompiledTextOutput = {
  body: HandlebarsTemplateDelegate;
  path: HandlebarsTemplateDelegate;
  source: TemplateOutputSource;
};

type PreparedBinaryOutput = {
  relativePath: string;
  format: 'pptx' | 'xlsx';
  dokId?: string;
  bytes: () => Promise<Buffer>;
};

type PlanContext = {
  outputDir: string;
  plan: RenderOutputPlan;
};

type PublicationDefinitionIdentity = {
  realPath: string;
  device: string;
  inode: string;
  fileType: string;
};

export async function renderLivedoc(input: RenderLivedocInput): Promise<RenderLivedocResult> {
  const warnings: LivedocManifestWarning[] = [];
  const errors: EngineErrorDetail[] = [];

  let resolved;
  try {
    resolved = await resolveTemplate(input.templateRef, {
      workspaceRoot: input.workspaceRoot,
      userHome: input.userHome,
      builtinRoot: input.builtinRoot,
      preferredSource: input.source,
    });
  } catch (error) {
    const code = isStableOutputFormatValidationError(error)
      ? 'OUTPUT_FORMAT_REJECTED'
      : error instanceof ZodError || error instanceof TemplateParseError
        ? 'INVALID_MANIFEST'
        : 'TEMPLATE_NOT_FOUND';
    throw new EngineError({
      code,
      message: (error as Error).message,
    });
  }
  const { parsed, source } = resolved;
  const { manifest } = parsed;
  const unvalidatedStableFormats = unvalidatedStableOutputFormats(manifest);
  if (unvalidatedStableFormats.length > 0) {
    throw new EngineError({
      code: 'OUTPUT_FORMAT_REJECTED',
      message: `Stable template '${manifest.name}' uses output formats without stable validator evidence: ${unvalidatedStableFormats.join(', ')}`,
    });
  }
  if (input.format && !manifest.output_formats.includes(input.format)) {
    throw new EngineError({
      code: 'OUTPUT_FORMAT_REJECTED',
      message: `Template '${manifest.name}' does not declare output format '${input.format}'`,
    });
  }
  if (
    (input.format !== undefined && input.allFormats === true)
    || (input.format !== undefined && input.noHtml === true)
    || (input.allFormats === true && input.noHtml === true)
  ) {
    throw new EngineError({
      code: 'OUTPUT_FORMAT_REJECTED',
      message: 'Choose only one render intent: format, allFormats, or noHtml.',
    });
  }
  const selectedFormats = selectOutputFormats(input, manifest);
  if (input.preview) {
    if (manifest.stability !== 'stable' || selectedFormats.some((format) => !['markdown', 'html'].includes(format))) {
      throw new EngineError({
        code: 'OUTPUT_FORMAT_REJECTED',
        message: 'Draft preview supports only stable Markdown and HTML templates.',
      });
    }
    warnings.push({
      code: 'DRAFT_PREVIEW',
      message: 'Draft preview. Not reviewed or approved for publication. Hub review status is unchanged.',
    });
  }
  let variables: Record<string, string | boolean | number>;
  try {
    variables = coerceTemplateVariables(manifest, input.variables ?? {});
  } catch (error) {
    throw new EngineError({
      code: 'INVALID_TEMPLATE_VARIABLE',
      message: (error as Error).message,
    });
  }

  if (
    manifest.min_engine_version
    && !satisfiesMinVersion(ENGINE_VERSION, manifest.min_engine_version)
  ) {
    throw new EngineError({
      code: 'ENGINE_VERSION_MISMATCH',
      message: `Template '${manifest.name}' requires engine ${manifest.min_engine_version}, have ${ENGINE_VERSION}`,
    });
  }

  let hub: HubModel;
  try {
    hub = await loadHubModel(input.workspaceRoot);
  } catch (error) {
    throw new EngineError({
      code: 'MISSING_HUB_LAYER',
      message: (error as Error).message,
      path: input.workspaceRoot,
    });
  }
  collectHubWarnings(manifest, hub, warnings);

  const primaryLocale = input.primaryLocale
    ?? hub.workspace.default_locale
    ?? hub.workspace.supported_locales[0]
    ?? 'en';
  const selection = selectTargets(input, manifest, hub, warnings);
  let { targets } = selection;
  const { selectorApplied } = selection;
  const generatedAt = canonicalGeneratedAt(hub);

  if (manifest.renderer === 'pptx') {
    return renderPptxTemplate({
      input,
      manifest,
      source,
      templatePath: parsed.sourcePath,
      templateDir: parsed.singleFile ? dirname(parsed.sourcePath) : parsed.sourcePath,
      hub,
      primaryLocale,
      variables,
      targets,
      warnings,
      errors,
      generatedAt,
    });
  }
  if (manifest.renderer === 'xlsx') {
    return renderXlsxTemplate({
      input,
      manifest,
      source,
      templatePath: parsed.sourcePath,
      templateDir: parsed.singleFile ? dirname(parsed.sourcePath) : parsed.sourcePath,
      hub,
      primaryLocale,
      targets,
      warnings,
      errors,
      generatedAt,
    });
  }

  const hb = createEngine();
  for (const [name, body] of parsed.partials) hb.registerPartial(name, body);
  const compiledOutputs = new Map<OutputFormat, CompiledTextOutput>();
  try {
    for (const format of selectedFormats) {
      const output = parsed.outputs.get(format)!;
      compiledOutputs.set(format, {
        body: hb.compile(output.body, { noEscape: true }),
        path: hb.compile(output.recipe.output_path, { noEscape: true }),
        source: output.recipe.source,
      });
    }
  } catch (error) {
    throw new EngineError({
      code: 'TEMPLATE_COMPILE_ERROR',
      message: `Template '${manifest.name}' compile error: ${(error as Error).message}`,
      path: parsed.sourcePath,
    });
  }

  const stableWorkspaceSelection = selectStableWorkspaceDoks({
    manifest,
    targets,
    hub,
    input,
    primaryLocale,
    variables,
    selectedFormats,
    compiledOutputs,
    generatedAt,
  });
  targets = stableWorkspaceSelection.targets;
  appendSkippedStableDokWarnings(warnings, stableWorkspaceSelection.skipped);

  const collector = makeCollector();
  const stringsMissing = new Set<string>();
  const prepared: PreparedTextOutput[] = [];
  const screenshots: ScreenshotArtifact[] = [];

  for (const target of targets) {
    const contextHub = stableContextHub(manifest, hub, target);
    const root = makeHelperRoot({
      locale: input.locale,
      primaryLocale,
      hub: contextHub,
      manifest,
      collector,
      stringsMissing,
      ...(input.audienceDictionary ? { audienceDictionary: input.audienceDictionary } : {}),
    });
    const screenshotContext = await discoverTargetScreenshots(input, hub, target);
    collectStableHelpWarnings(manifest, target.dok, screenshotContext, variables, warnings);
    const stableHelp = manifest.stability === 'stable' && manifest.name === 'help-page' && target.dok
      ? prepareStableHelpCopy({
        dok: target.dok,
        workspaceName: hub.workspace.name,
        resolve: (value) => resolveTranslatable(value, {
          locale: input.locale,
          primaryLocale,
          lexicon: hub.lexicon,
          roles: hub.roles,
        }, collector),
        actorLabel: (actor) => actorLabel(actor, {
          locale: input.locale,
          primaryLocale,
          lexicon: hub.lexicon,
          roles: hub.roles,
        }, collector).text,
        ...(input.audienceDictionary ? { audienceDictionary: input.audienceDictionary } : {}),
      })
      : undefined;
    if (stableHelp?.unsafeTitle) {
      throw new EngineError({
        code: 'STABLE_COPY_UNSAFE',
        message: 'Stable help-page title has no customer-safe wording after implementation copy is removed.',
        dokId: target.dok?.dok_id,
      });
    }
    if (stableHelp && target.dok && input.locale === 'ko') {
      warnings.push(...checkKoreanHelpWriting({
        dok: target.dok, copy: stableHelp.copy, tone: hub.workspace.korean_customer_tone, preview: input.preview === true,
      }));
    }
    for (const change of stableHelp?.changes ?? []) {
      warnings.push({
        code: change.category === 'normalized'
          ? 'NORMALIZED_DEVELOPER_COPY'
          : 'OMITTED_DEVELOPER_COPY',
        message: change.category === 'normalized'
          ? 'Developer-only wording was removed while customer-observable meaning was retained.'
          : 'Developer-only copy was omitted from the customer help article.',
        dok_id: target.dok?.dok_id,
        field: change.field,
      });
    }
    screenshots.push(...screenshotContext.artifacts);
    const context = {
      ...scopeStableWorkspaceExtraContext(
        input.extraContext,
        manifest,
        contextHub.doks,
        stableWorkspaceSelection.retainedRemovedSnapshots,
      ),
      dok: target.dok,
      doks: target.doks ?? contextHub.doks,
      // Workspace-wide recorded history — computed over the full Hub set so an
      // archived Dok still contributes its Removed entry.
      changelog: buildChangelog(contextHub.doks),
      workspace: contextHub.workspace,
      services: contextHub.services,
      hub: contextHub,
      locale: input.locale,
      primaryLocale,
      variables,
      step_screenshots: screenshotContext.stepScreenshots,
      step_screenshots_by_platform: screenshotContext.stepScreenshotsByPlatform,
      step_annotations: screenshotContext.stepAnnotations,
      step_annotations_by_platform: screenshotContext.stepAnnotationsByPlatform,
      platforms: Object.keys(screenshotContext.stepScreenshotsByPlatform).sort(compareText),
      ...(stableHelp ? {
        help: stableHelp.copy,
        help_html: helpPagePresentation(target.dok!.dok_id, input.locale, variables),
      } : {}),
    };

    for (const format of selectedFormats) {
      const output = compiledOutputs.get(format)!;
      let rendered: string;
      let outputPath: string;
      try {
        rendered = output.body(context, {
          data: { root: { ...root, __outputSource: output.source } },
        });
        outputPath = output.path(context, { data: { root } });
      } catch (error) {
        throw new EngineError({
          code: 'TEMPLATE_COMPILE_ERROR',
          message: `Render failed for ${target.key} (${format}): ${(error as Error).message}`,
          dokId: target.dok?.dok_id,
        });
      }
      prepared.push({
        relativePath: plannedRelativePath(outputPath, format),
        format,
        content: rendered,
        source: output.source,
        ...(target.dok ? { dokId: target.dok.dok_id } : {}),
        ...(!parsed.singleFile ? { templateDir: parsed.sourcePath } : {}),
      });
    }
  }

  collectTranslationWarnings(collector, stringsMissing, manifest.name, warnings);
  const stablePrepared = selectStablePrepared(
    manifest,
    prepared,
    generatedAt,
    manifest.scope === 'workspace'
      ? targets.flatMap((target) => target.doks?.map((dok) => dok.dok_id) ?? [])
      : undefined,
    hub.workspace.stable_public_terms,
  );
  const skippedDokIds = new Set(stablePrepared.skipped.map((skipped) => skipped.dokId));
  if (skippedDokIds.size > 0) {
    const retainedWarnings = warnings.filter((warning) => (
      !warning.dok_id || !skippedDokIds.has(warning.dok_id)
    ));
    warnings.splice(0, warnings.length, ...retainedWarnings);
  }
  appendSkippedStableDokWarnings(warnings, stablePrepared.skipped);
  const renderableTargets = targets.filter((target) => (
    !target.dok || !skippedDokIds.has(target.dok.dok_id)
  ));
  const renderableScreenshots = screenshots.filter((screenshot) => (
    !skippedDokIds.has(screenshot.dokId)
  ));
  const planContext = await buildPlan({
    input,
    source,
    templatePath: parsed.sourcePath,
    hub,
    targets: renderableTargets,
    warnings,
    screenshots: renderableScreenshots,
    outputs: stablePrepared.outputs,
  });
  const emptyManifest = buildRenderManifest({
    manifest,
    source,
    input,
    primaryLocale,
    selectorApplied,
    outputs: [],
    collector,
    stringsMissing,
    warnings,
    errors,
    generatedAt,
  });
  if (input.dryRun) {
    return { outputs: [], manifest: emptyManifest, plan: planContext.plan };
  }
  assertPlanWritable(planContext.plan);

  const outputs: Array<WriterResult & { dokId?: string }> = [];
  for (const output of stablePrepared.outputs) {
    const planned = findPlannedOutput(planContext, output.relativePath, output.format, output.dokId);
    throwIfAborted(input.signal);
    try {
      const result = await getWriter(output.format)({
        outputRoot: planContext.plan.output_root,
        plannedOutput: planned,
        content: output.content,
        preview: input.preview,
        source: output.source,
        template: manifest,
        locale: input.locale,
        ...(manifest.name === 'help-page' && manifest.stability === 'stable'
          ? { html: { fragment: variables['html_fragment'] === true } }
          : {}),
        ...(output.templateDir ? { templateDir: output.templateDir } : {}),
        workspaceRoot: input.workspaceRoot,
      });
      outputs.push({ ...result, ...(output.dokId ? { dokId: output.dokId } : {}) });
    } catch (error) {
      throwWriterError(error, output.format, output.dokId ?? '__workspace__', planned.path);
    }
    input.onOutputWritten?.(planned);
    await abortCheckpoint(input.signal);
  }
  const screenshotOutputs = await writeScreenshots(planContext, renderableScreenshots, input);
  const manifestOutputs = [...outputs, ...screenshotOutputs].sort((a, b) => compareText(a.path, b.path));
  const renderedManifest = buildRenderManifest({
    manifest,
    source,
    input,
    primaryLocale,
    selectorApplied,
    outputs: manifestOutputs,
    collector,
    stringsMissing,
    warnings,
    errors,
    generatedAt,
  });
  const manifestOutput = findManifest(planContext.plan);
  const manifestPath = await writeManifest(
    planContext.plan.output_root,
    manifestOutput,
    renderedManifest,
  );
  input.onOutputWritten?.(manifestOutput);
  await abortCheckpoint(input.signal);
  return { outputs, manifest: renderedManifest, manifestPath, plan: planContext.plan };
}

export async function renderPublication(
  input: RenderPublicationInput,
): Promise<PublicationRenderCommandResult> {
  let executionPlan: RenderOutputPlan | undefined;
  let definitionPath = resolve(input.definition.path);
  let stagingDirectory: string | undefined;
  let stagingIdentity: ContainedPathIdentity | undefined;
  let confinedWorkspaceRoot: string | undefined;
  const completedPaths = new Set<string>();
  try {
    const requestedWorkspaceRoot = resolve(input.workspaceRoot);
    const requestedDefinitionPath = resolve(input.definition.path);
    const requestedDefinitionRelativePath = relative(
      requestedWorkspaceRoot,
      requestedDefinitionPath,
    );
    const workspaceRoot = await resolveContainedPath(requestedWorkspaceRoot, '.', {
      rejectSymlinkLeaf: true,
    });
    confinedWorkspaceRoot = workspaceRoot;
    const definitionRelativePath = isLexicallyContained(requestedDefinitionRelativePath)
      ? requestedDefinitionRelativePath
      : relative(workspaceRoot, requestedDefinitionPath);
    definitionPath = await resolveContainedPath(
      workspaceRoot,
      definitionRelativePath,
      { rejectSymlinkLeaf: true },
    );
    const definitionIdentity = await publicationDefinitionIdentity(definitionPath);
    await assertPublicationDefinitionDigest(
      input.publication,
      definitionPath,
      input.definition.sha256,
    );

    const resolvedTemplate = await resolveTemplate(input.publication.template, { workspaceRoot });
    if (!resolvedTemplate.parsed.manifest.output_formats.includes(input.publication.format)) {
      throw codedError(
        'OUTPUT_FORMAT_REJECTED',
        `Template '${input.publication.template}' does not declare output format '${input.publication.format}'`,
      );
    }
    const renderMode = resolvedTemplate.parsed.manifest.scope === 'workspace'
      ? 'workspace'
      : 'per_dok';
    const hub = await loadHubModel(workspaceRoot);
    const selection = selectPublicationDoks(hub.doks, input.publication, renderMode);
    const renderInputSha256 = await effectiveRenderInputDigest({
      workspaceRoot,
      templateRef: input.publication.template,
      templateSource: resolvedTemplate.source,
      locale: input.publication.locale,
      primaryLocale: hub.workspace.default_locale ?? 'en',
      format: input.publication.format,
      variables: input.publication.vars,
      selectedDokIds: selection.selectedDokIds,
      hub,
      resolvedTemplate,
    });
    const audience = await loadWorkspaceAudienceDictionary(
      workspaceRoot,
      input.publication.locale,
      hub.workspace.default_locale,
    );
    const outDir = await resolvePublicationOutputDirectory(
      workspaceRoot,
      input.publication.output_dir,
    );
    const priorEvidence = await readPriorEvidence(workspaceRoot, outDir);
    const baseline = Array.isArray(priorEvidence?.dok_snapshots)
      ? priorEvidence.dok_snapshots as EvidenceDokSnapshot[]
      : undefined;
    const dokById = new Map(hub.doks.map((dok) => [dok.dok_id, dok]));
    const selectedDoks = selection.selectedDokIds
      .map((dokId) => dokById.get(dokId))
      .filter((dok): dok is Dok => dok !== undefined);
    const changes = classifyDokChanges(selectedDoks, baseline);
    const renderInput: RenderLivedocInput = {
      workspaceRoot,
      templateRef: input.publication.template,
      locale: input.publication.locale,
      outDir,
      outputRoot: workspaceRoot,
      dokIds: selection.selectedDokIds,
      variables: input.publication.vars,
      extraContext: { changes },
      format: input.publication.format,
      overwrite: input.overwrite === true,
      additionalPlannedOutputs: [{
        relativePath: 'publication-evidence.json',
        format: 'publication-evidence',
      }],
      additionalSourcePaths: [definitionPath],
      ...(audience.dictionary ? { audienceDictionary: audience.dictionary } : {}),
    };

    const preflight = await renderLivedoc({ ...renderInput, dryRun: true });
    executionPlan = preflight.plan;
    input.onPlan?.(executionPlan);
    await abortCheckpoint(input.signal);
    const renderedDokIds = preflight.plan.inputs.dok_ids;
    const dokSnapshots = buildDokSnapshots({
      doks: hub.doks,
      selectedDokIds: renderedDokIds,
      locale: input.publication.locale,
      primaryLocale: hub.workspace.default_locale ?? 'en',
      lexicon: hub.lexicon,
      roles: hub.roles,
    });
    const warnings = evidenceWarnings(preflight.plan);
    const evidencePlan = reproducibleRenderOutputPlan(preflight.plan);
    const baseEvidence = publicationEvidence({
      publication: input.publication,
      definitionPath,
      definitionSha256: input.definition.sha256,
      selectedDokIds: selection.selectedDokIds,
      renderedDokIds,
      renderInputSha256,
      dokSnapshots,
      result: preflight,
      plan: evidencePlan,
      warnings,
      outputs: [],
    });
    if (input.dryRun) return successPublicationResult(baseEvidence, preflight.plan);

    const priorOfficial = input.overwrite
      ? await validatePriorOfficialPublication({
        workspaceRoot,
        outDir,
        priorEvidence,
        publication: input.publication,
        templateName: resolvedTemplate.parsed.manifest.name,
      })
      : undefined;
    if (!priorOfficial) {
      await assertNoUnplannedOutputEntries(outDir, preflight.plan);
    }

    const blocked = preflight.plan.outputs.filter((output) => output.action === 'blocked');
    if (blocked.length > 0) {
      throw codedError(
        'OUTPUT_EXISTS',
        `output exists; pass --overwrite to replace: ${blocked.map((output) => output.path).join(', ')}`,
      );
    }
    const createdStagingDirectory = await createPublicationStagingDirectory(
      workspaceRoot,
      outDir,
    );
    const createdStagingRelativePath = rootRelative(
      workspaceRoot,
      createdStagingDirectory,
    );
    const createdStagingIdentity = await captureContainedPathIdentity(
      workspaceRoot,
      createdStagingRelativePath,
    );
    stagingDirectory = createdStagingDirectory;
    stagingIdentity = createdStagingIdentity;
    const activeStagingDirectory = stagingDirectory;
    const activeStagingRelativePath = createdStagingRelativePath;
    const activeStagingIdentity = stagingIdentity;
    const actualRenderInput = {
      ...renderInput,
      outDir: activeStagingDirectory,
      overwrite: false,
    };

    const rendered = await renderLivedoc({
      ...actualRenderInput,
      signal: input.signal,
      onOutputWritten(output) {
        if (output.format === 'manifest') return;
        const reported = remapPlannedOutput(
          output,
          activeStagingDirectory,
          outDir,
          workspaceRoot,
        );
        completedPaths.add(reported.path);
        input.onArtifactWritten?.(reported);
      },
    });
    await assertContainedPathIdentity(
      workspaceRoot,
      activeStagingRelativePath,
      activeStagingIdentity,
    );
    if (!rendered.manifestPath) {
      throw codedError('PUBLICATION_EVIDENCE_INVALID', 'Publication manifest was not written');
    }
    await assertPublicationDefinitionIdentity(
      definitionPath,
      definitionIdentity,
    );
    await assertEffectiveRenderInputDigest({
      workspaceRoot,
      publication: input.publication,
      expected: renderInputSha256,
    });
    const ledger = await publicationOutputLedger(
      workspaceRoot,
      rendered.manifest.outputs,
      { physicalRoot: activeStagingDirectory, logicalRoot: outDir },
    );
    const finalizedManifest: LivedocManifest = {
      ...rendered.manifest,
      outputs: ledger,
      publication: {
        name: input.publication.name,
        definition_path: definitionPath,
        definition_sha256: input.definition.sha256,
        selected_dok_ids: selection.selectedDokIds,
        rendered_dok_ids: renderedDokIds,
        locale: input.publication.locale,
        variables: input.publication.vars,
        plan: evidencePlan,
        warnings,
      },
    };
    const manifestBytes = `${JSON.stringify(finalizedManifest, null, 2)}\n`;
    await writeArtifactAtomic(
      rendered.plan.output_root,
      relative(rendered.plan.output_root, rendered.manifestPath),
      manifestBytes,
      { overwrite: true },
    );
    const reportedManifest = remapPlannedOutput(
      findManifest(rendered.plan),
      activeStagingDirectory,
      outDir,
      workspaceRoot,
    );
    completedPaths.add(reportedManifest.path);
    input.onArtifactWritten?.(reportedManifest);
    await abortCheckpoint(input.signal);
    const logicalManifestPath = remapPublicationPath(
      rendered.manifestPath,
      activeStagingDirectory,
      outDir,
    );
    const manifestOutput = await evidenceOutput(
      workspaceRoot,
      rendered.manifestPath,
      'manifest',
      logicalManifestPath,
    );
    const outputs = [...ledger.map((output) => ({
      path: output.path,
      relative_path: output.relative_path!,
      format: output.format,
      bytes: output.bytes,
      sha256: output.sha256!,
      ...(output.dok_id ? { dok_id: output.dok_id } : {}),
    })), manifestOutput].sort((a, b) => compareText(a.relative_path, b.relative_path));
    await assertPublicationOutputsComplete(
      activeStagingDirectory,
      preflight.plan,
      outputs,
      { physicalRoot: activeStagingDirectory, logicalRoot: outDir },
    );
    await assertContainedPathIdentity(
      workspaceRoot,
      activeStagingRelativePath,
      activeStagingIdentity,
    );

    const evidence = publicationEvidence({
      publication: input.publication,
      definitionPath,
      definitionSha256: input.definition.sha256,
      selectedDokIds: selection.selectedDokIds,
      renderedDokIds,
      renderInputSha256,
      dokSnapshots,
      result: rendered,
      plan: evidencePlan,
      warnings,
      outputs,
    });
    const evidenceOutputPlan = rendered.plan.outputs.find(
      (output) => output.format === 'publication-evidence',
    );
    if (!evidenceOutputPlan) {
      throw codedError('PUBLICATION_EVIDENCE_INVALID', 'Evidence output is missing from the plan');
    }
    await abortCheckpoint(input.signal);
    await writePlannedArtifact(
      rendered.plan.output_root,
      evidenceOutputPlan,
      `${JSON.stringify(evidence, null, 2)}\n`,
    );
    const reportedEvidence = remapPlannedOutput(
      evidenceOutputPlan,
      activeStagingDirectory,
      outDir,
      workspaceRoot,
    );
    input.onArtifactWritten?.(reportedEvidence);
    await abortCheckpoint(input.signal);
    let expectedDestination: DirectoryPublishDestinationSnapshot = {
      exists: false,
    };
    if (priorOfficial) {
      const currentPriorOfficial = await validatePriorOfficialPublication({
        workspaceRoot,
        outDir,
        priorEvidence: await readPriorEvidence(workspaceRoot, outDir),
        publication: input.publication,
        templateName: resolvedTemplate.parsed.manifest.name,
      });
      if (
        !currentPriorOfficial
        || currentPriorOfficial.snapshotSha256 !== priorOfficial.snapshotSha256
      ) {
        throw codedError(
          'PUBLICATION_EVIDENCE_INVALID',
          'Prior official Publication changed before atomic replacement',
        );
      }
      expectedDestination = priorOfficial.expectedDestination;
    } else {
      // A pre-existing *empty* output directory is not a conflict (MAYP-36).
      // Snapshot its identity first, then verify that this same directory is
      // empty: the atomic publish re-checks the snapshot (realPath, device,
      // inode), so a directory swapped in after the snapshot fails closed
      // instead of being replaced, and an empty directory that was already
      // there is replaced exactly once rather than failing every attempt with
      // a PATH_IDENTITY_CHANGED that the CLI reports as retryable.
      expectedDestination = await captureDirectoryPublishDestination(
        workspaceRoot,
        rootRelative(workspaceRoot, outDir),
      );
      await assertEmptyPublicationOutputDirectory(outDir);
    }
    await assertStagedPublicationComplete(
      activeStagingDirectory,
      rendered.plan,
    );
    await assertContainedPathIdentity(
      workspaceRoot,
      activeStagingRelativePath,
      activeStagingIdentity,
    );
    await assertPublicationDefinitionIdentity(
      definitionPath,
      definitionIdentity,
    );
    await assertEffectiveRenderInputDigest({
      workspaceRoot,
      publication: input.publication,
      expected: renderInputSha256,
    });
    await publishDirectoryContained(
      workspaceRoot,
      activeStagingRelativePath,
      rootRelative(workspaceRoot, outDir),
      {
        expectedDestination,
        expectedStagedIdentity: activeStagingIdentity,
      },
    );
    stagingDirectory = undefined;
    stagingIdentity = undefined;
    return successPublicationResult(evidence, preflight.plan);
  } catch (error) {
    if (input.signal?.aborted && executionPlan) {
      return cancelledPublicationResult({
        publication: {
          name: input.publication.name,
          definition_path: definitionPath,
          definition_sha256: input.definition.sha256,
        },
        plan: executionPlan,
        completedPaths,
        reason: input.signal.reason,
      });
    }
    return failedPublicationResult(error);
  } finally {
    if (stagingDirectory && stagingIdentity) {
      try {
        const cleanupRoot = confinedWorkspaceRoot ?? resolve(input.workspaceRoot);
        await removeContained(
          cleanupRoot,
          rootRelative(cleanupRoot, stagingDirectory),
          {
            recursive: true,
            force: true,
            expectedIdentity: stagingIdentity,
          },
        );
      } catch {
        // A confined cleanup failure must not risk deleting through a replaced path.
      }
    }
  }
}

async function publicationDefinitionIdentity(
  definitionPath: string,
): Promise<PublicationDefinitionIdentity> {
  try {
    const stats = await lstat(definitionPath, { bigint: true });
    if (!stats.isFile()) throw new Error('expected a regular file');
    const device = stableIdentityMetadata(stats.dev);
    const inode = stableIdentityMetadata(stats.ino);
    if (device === undefined || inode === undefined) {
      throw new Error('stable filesystem identity unavailable');
    }
    return {
      realPath: await realpath(definitionPath),
      device,
      inode,
      fileType: String(stats.mode & BigInt(constants.S_IFMT)),
    };
  } catch {
    throw publicationDefinitionChanged(definitionPath);
  }
}

async function assertPublicationDefinitionIdentity(
  definitionPath: string,
  expected: PublicationDefinitionIdentity,
): Promise<void> {
  const actual = await publicationDefinitionIdentity(definitionPath);
  if (
    actual.realPath !== expected.realPath
    || actual.device !== expected.device
    || actual.inode !== expected.inode
    || actual.fileType !== expected.fileType
  ) {
    throw publicationDefinitionChanged(definitionPath);
  }
}

function publicationDefinitionChanged(
  definitionPath: string,
): Error & { code: string; retryable: true } {
  return Object.assign(
    new Error(`Publication definition identity changed before finalization: ${definitionPath}`),
    { code: 'PUBLICATION_DEFINITION_CHANGED', retryable: true as const },
  );
}

function stableIdentityMetadata(value: bigint): string | undefined {
  return value > 0n ? String(value) : undefined;
}

async function assertPublicationDefinitionDigest(
  publication: PublicationV1,
  definitionPath: string,
  expected: string,
): Promise<void> {
  const canonical = publicationDigest(publication);
  const actual = createHash('sha256').update(await readFile(definitionPath)).digest('hex');
  if (expected !== canonical || actual !== canonical) {
    throw codedError(
      'PUBLICATION_DEFINITION_MISMATCH',
      `Publication definition digest mismatch: expected canonical ${canonical}, received ${expected}, actual ${actual}`,
    );
  }
}

async function publicationOutputLedger(
  workspaceRoot: string,
  outputs: LivedocManifest['outputs'],
  remapping?: {
    physicalRoot: string;
    logicalRoot: string;
  },
): Promise<LivedocManifest['outputs']> {
  return Promise.all(outputs.map(async (output) => {
    const bytes = await readFile(output.path);
    if (bytes.byteLength !== output.bytes) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        `Output byte count mismatch for ${output.path}: manifest ${output.bytes}, actual ${bytes.byteLength}`,
      );
    }
    const logicalPath = remapping
      ? remapPublicationPath(
        output.path,
        remapping.physicalRoot,
        remapping.logicalRoot,
      )
      : output.path;
    return {
      ...output,
      path: logicalPath,
      relative_path: rootRelative(workspaceRoot, logicalPath),
      sha256: createHash('sha256').update(bytes).digest('hex'),
    };
  }));
}

async function evidenceOutput(
  workspaceRoot: string,
  path: string,
  format: string,
  logicalPath = path,
): Promise<PublicationRenderEvidence['outputs'][number]> {
  const bytes = await readFile(path);
  return {
    path: logicalPath,
    relative_path: rootRelative(workspaceRoot, logicalPath),
    format,
    bytes: bytes.byteLength,
    sha256: createHash('sha256').update(bytes).digest('hex'),
  };
}

function publicationEvidence(input: {
  publication: PublicationV1;
  definitionPath: string;
  definitionSha256: string;
  selectedDokIds: string[];
  renderedDokIds: string[];
  renderInputSha256: string;
  dokSnapshots: EvidenceDokSnapshot[];
  result: RenderLivedocResult;
  plan: ReproducibleRenderOutputPlan;
  warnings: string[];
  outputs: PublicationRenderEvidence['outputs'];
}): PublicationRenderEvidence {
  return {
    schema_version: 1,
    command: 'live-docs.publication.render',
    publication: {
      name: input.publication.name,
      definition_path: input.definitionPath,
      definition_sha256: input.definitionSha256,
    },
    template: {
      name: input.result.manifest.template.name,
      version: input.result.manifest.template.version,
      stability: input.result.manifest.template.stability,
    },
    selected_dok_ids: input.selectedDokIds,
    rendered_dok_ids: input.renderedDokIds,
    render_input_sha256: input.renderInputSha256,
    dok_snapshots: input.dokSnapshots,
    plan: input.plan,
    outputs: input.outputs,
    warnings: input.warnings,
    manifest_path: input.plan.manifest_path,
  };
}

function evidenceWarnings(plan: RenderOutputPlan): string[] {
  return plan.warnings.map((warning) => `${warning.code}: ${warning.message}`);
}

/**
 * Prove the Publication output directory is inside the workspace *before* the
 * first read of it.
 *
 * `output_dir` reaches us from a persisted Publication definition, and the
 * schema (`publication.ts` `isSafeOutputDirectory`) only checks it lexically —
 * no `..`, no absolute, no backslash. That is not enough on its own, because a
 * symlink at the output directory or at any segment above it satisfies every
 * lexical rule while pointing outside the workspace. Containment used to be
 * established later, by `planRenderOutputs`; but the unplanned-entry walk opens
 * the directory before then, so a symlinked output directory turned a render
 * into an out-of-root read.
 *
 * Resolving here closes that window: every later consumer of `outDir` inherits
 * a path the core resolver has already proven contained and symlink-free.
 *
 * The relative path is joined, not normalized. `posix.join` would collapse a
 * `..` before the resolver ever saw it, quietly rewriting the caller's path
 * instead of rejecting it; the schema happens to forbid `..` today, but the
 * containment decision belongs to the resolver either way.
 */
async function resolvePublicationOutputDirectory(
  workspaceRoot: string,
  outputDir: string,
): Promise<string> {
  try {
    return await resolveContainedPath(
      workspaceRoot,
      `.doklo/output/${outputDir}`,
      { allowMissingLeaf: true, rejectSymlinkLeaf: true },
    );
  } catch (error) {
    // Only a containment verdict becomes this code. Anything else (EACCES, a
    // broken volume) keeps its own cause so it is not misreported as a hostile
    // path — but the resolved path stays out of the message either way, since
    // exposing it is what this check exists to prevent.
    if (!(error instanceof PathOutsideRootError)) throw error;
    throw codedError(
      'PUBLICATION_OUTPUT_DIR_INVALID',
      `Publication output directory '${outputDir}' does not resolve to a real directory inside `
      + `the workspace output root '.doklo/output'.`,
    );
  }
}

/**
 * Read the prior evidence file, proving containment on the *leaf* before opening
 * it.
 *
 * A contained `outDir` is not sufficient. `publication-evidence.json` inside an
 * ordinary workspace directory can itself be a symlink, and this is the first
 * file a Publication render opens — well before the unplanned-entry walk that
 * rejects symlinks. Following it read a file outside the workspace, and the
 * parse failure handed its leading bytes back to the operator. This mirrors
 * `loadPublicationEvidence` in apps/cli/src/commands/live-docs-publication.ts,
 * which is the pattern the rest of the Publication surface already follows.
 *
 * No parser text reaches the message. Node quotes the head of whatever it just
 * read, so echoing it discloses file bytes — a leak even when the file is
 * genuinely inside the workspace.
 */
async function readPriorEvidence(
  workspaceRoot: string,
  outDir: string,
): Promise<Record<string, unknown> | undefined> {
  const relativePath = `${rootRelative(workspaceRoot, outDir)}/publication-evidence.json`;
  let path: string;
  try {
    path = await resolveContainedPath(workspaceRoot, relativePath, {
      rejectSymlinkLeaf: true,
    });
  } catch (error) {
    // A missing leaf is the ordinary "no prior publication" case.
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Prior Publication evidence at '${relativePath}' is not a regular file contained by the `
      + 'workspace.',
    );
  }
  // Containment proves where the leaf is, not what it is. A FIFO would block
  // readFile until a writer appeared — hanging the render instead of failing
  // it — and a directory would fail obscurely, so both are refused before the
  // open. This is also what makes the message above true.
  if (!(await lstat(path)).isFile()) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Prior Publication evidence at '${relativePath}' is not a regular file contained by the `
      + 'workspace.',
    );
  }
  try {
    const parsed: unknown = JSON.parse(await readFile(path, 'utf8'));
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('not a JSON object');
    }
    return parsed as Record<string, unknown>;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Cannot parse prior Publication evidence at '${relativePath}'; expected a JSON object.`,
    );
  }
}

type ValidatedPriorOfficial = {
  expectedDestination: DirectoryPublishDestinationSnapshot;
  snapshotSha256: string;
};

async function validatePriorOfficialPublication(input: {
  workspaceRoot: string;
  outDir: string;
  priorEvidence: Record<string, unknown> | undefined;
  publication: PublicationV1;
  templateName: string;
}): Promise<ValidatedPriorOfficial | undefined> {
  if (!input.priorEvidence) {
    let entries: Dirent[];
    try {
      entries = await readdir(input.outDir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
      throw error;
    }
    if (entries.length === 0) return undefined;
    await listFiles(input.outDir, new Set());
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Cannot overwrite a nonempty Publication directory without valid evidence: ${input.outDir}`,
    );
  }
  const expectedDestination = await captureDirectoryPublishDestination(
    input.workspaceRoot,
    rootRelative(input.workspaceRoot, input.outDir),
  );
  if (!expectedDestination.exists) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Prior official Publication directory is missing',
    );
  }
  const evidence = input.priorEvidence;
  const publication = recordValue(evidence.publication);
  const template = recordValue(evidence.template);
  if (
    hasDraftPreviewMarker(evidence)
    || evidence.schema_version !== 1
    || evidence.command !== 'live-docs.publication.render'
    || publication?.name !== input.publication.name
    || template?.name !== input.templateName
    || !Array.isArray(evidence.outputs)
  ) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Prior evidence does not own Publication '${input.publication.name}'`,
    );
  }

  const expectedPaths = new Set<string>();
  const outputClaims = new Map<string, {
    bytes: number;
    sha256: string;
    format: string;
  }>();
  for (const value of evidence.outputs) {
    const output = recordValue(value);
    if (
      !output
      ||
      typeof output.relative_path !== 'string'
      || typeof output.sha256 !== 'string'
      || !/^[a-f0-9]{64}$/u.test(output.sha256)
      || typeof output.bytes !== 'number'
      || !Number.isSafeInteger(output.bytes)
      || output.bytes < 0
      || typeof output.format !== 'string'
    ) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        'Prior evidence contains an invalid output claim',
      );
    }
    let path: string;
    try {
      path = await resolveContainedPath(
        input.workspaceRoot,
        output.relative_path,
        { rejectSymlinkLeaf: true },
      );
    } catch (error) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        `Prior evidence output is not a safe contained file: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      !isStrictlyContainedPath(input.outDir, path)
      || rootRelative(input.workspaceRoot, path) !== output.relative_path
      || outputClaims.has(path)
    ) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        `Prior evidence contains a duplicate, noncanonical, or foreign output: ${output.relative_path}`,
      );
    }
    let bytes: Buffer;
    try {
      bytes = await readFile(path);
    } catch (error) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        `Prior evidence output cannot be read: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
    if (
      bytes.byteLength !== output.bytes
      ||
      createHash('sha256').update(bytes).digest('hex')
      !== output.sha256
    ) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        `Prior evidence output bytes do not match: ${output.relative_path}`,
      );
    }
    expectedPaths.add(path);
    outputClaims.set(path, {
      bytes: output.bytes,
      sha256: output.sha256,
      format: output.format,
    });
  }

  const manifestClaims = [...outputClaims.entries()]
    .filter(([, claim]) => claim.format === 'manifest');
  if (manifestClaims.length !== 1) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Prior evidence must claim exactly one Publication manifest',
    );
  }
  const [manifestPath] = manifestClaims[0]!;
  let manifest: Record<string, unknown>;
  try {
    manifest = recordValue(JSON.parse(await readFile(manifestPath, 'utf8')))
      ?? {};
  } catch {
    // No parser text: Node quotes the head of whatever it just read, which
    // discloses file bytes even for a file inside the workspace.
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Cannot parse the prior Publication manifest claimed by prior evidence; '
      + 'expected a JSON object.',
    );
  }
  if (
    hasDraftPreviewMarker(manifest)
    || recordValue(manifest.publication)?.name !== input.publication.name
    || recordValue(manifest.template)?.name !== input.templateName
  ) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Prior manifest does not agree with Publication evidence ownership',
    );
  }

  const evidencePath = join(input.outDir, 'publication-evidence.json');
  expectedPaths.add(evidencePath);
  let actualFiles: string[];
  try {
    actualFiles = (await listFiles(input.outDir, expectedPaths)).sort(compareText);
  } catch (error) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Prior official Publication contains foreign entries: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const expected = [...expectedPaths].sort(compareText);
  if (JSON.stringify(actualFiles) !== JSON.stringify(expected)) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Prior official Publication directory does not match its evidence ledger',
    );
  }
  const snapshotEntries = await Promise.all(actualFiles.map(async (path) => ({
    path: rootRelative(input.outDir, path),
    sha256: createHash('sha256').update(await readFile(path)).digest('hex'),
  })));
  return {
    expectedDestination,
    snapshotSha256: createHash('sha256')
      .update(JSON.stringify(snapshotEntries))
      .digest('hex'),
  };
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function isStrictlyContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot !== ''
    && fromRoot !== '..'
    && !fromRoot.startsWith(`..${sep}`)
    && !isAbsolute(fromRoot);
}

async function createPublicationStagingDirectory(
  workspaceRoot: string,
  outputDir: string,
): Promise<string> {
  const parentRelativePath = rootRelative(
    workspaceRoot,
    dirname(outputDir),
  );
  const parent = await resolveContainedPath(
    workspaceRoot,
    parentRelativePath,
    {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    },
  );
  await mkdir(parent, { recursive: true });
  const confinedParent = await resolveContainedPath(
    workspaceRoot,
    parentRelativePath,
    { rejectSymlinkLeaf: true },
  );
  return mkdtemp(join(confinedParent, `.${basename(outputDir)}.stage-`));
}

function remapPublicationPath(
  path: string,
  physicalRoot: string,
  logicalRoot: string,
): string {
  const suffix = relative(physicalRoot, path);
  if (
    suffix === ''
    || suffix === '..'
    || suffix.startsWith(`..${sep}`)
    || isAbsolute(suffix)
  ) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Cannot remap Publication path outside its root: ${path}`,
    );
  }
  return resolve(logicalRoot, suffix);
}

function remapPlannedOutput(
  output: PlannedOutput,
  physicalRoot: string,
  logicalRoot: string,
  workspaceRoot: string,
): PlannedOutput {
  const path = remapPublicationPath(output.path, physicalRoot, logicalRoot);
  return {
    ...output,
    path,
    relative_path: rootRelative(workspaceRoot, path),
  };
}

async function assertStagedPublicationComplete(
  stagingDirectory: string,
  plan: RenderOutputPlan,
): Promise<void> {
  const expected = new Set(plan.outputs.map((output) => output.path));
  const actual = (await listFiles(stagingDirectory, expected)).sort(compareText);
  const planned = [...expected].sort(compareText);
  if (JSON.stringify(actual) !== JSON.stringify(planned)) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      'Staged Publication is incomplete before atomic replacement',
    );
  }
}

async function assertEffectiveRenderInputDigest(input: {
  workspaceRoot: string;
  publication: PublicationV1;
  expected: string;
}): Promise<void> {
  const hub = await loadHubModel(input.workspaceRoot);
  const resolvedTemplate = await resolveTemplate(input.publication.template, {
    workspaceRoot: input.workspaceRoot,
  });
  const renderMode = resolvedTemplate.parsed.manifest.scope === 'workspace'
    ? 'workspace'
    : 'per_dok';
  const selection = selectPublicationDoks(
    hub.doks,
    input.publication,
    renderMode,
  );
  const actual = await effectiveRenderInputDigest({
    workspaceRoot: input.workspaceRoot,
    templateRef: input.publication.template,
    templateSource: resolvedTemplate.source,
    locale: input.publication.locale,
    primaryLocale: hub.workspace.default_locale ?? 'en',
    format: input.publication.format,
    variables: input.publication.vars,
    selectedDokIds: selection.selectedDokIds,
    hub,
    resolvedTemplate,
  });
  if (actual !== input.expected) {
    throw Object.assign(
      new Error('Effective Publication render inputs changed before finalization'),
      { code: 'PUBLICATION_INPUTS_CHANGED', retryable: true as const },
    );
  }
}

async function assertPublicationOutputsComplete(
  outputDir: string,
  plan: RenderOutputPlan,
  outputs: PublicationRenderEvidence['outputs'],
  remapping?: {
    physicalRoot: string;
    logicalRoot: string;
  },
): Promise<void> {
  const expected = plan.outputs
    .filter((output) => output.format !== 'publication-evidence')
    .map((output) => output.path)
    .sort(compareText);
  const actual = outputs.map((output) => output.path).sort(compareText);
  if (JSON.stringify(expected) !== JSON.stringify(actual)) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Planned and finalized outputs differ: planned ${expected.join(', ')}, finalized ${actual.join(', ')}`,
    );
  }
  const expectedPhysical = remapping
    ? actual.map((path) => remapPublicationPath(
      path,
      remapping.logicalRoot,
      remapping.physicalRoot,
    ))
    : actual;
  const physicalFiles = await listFiles(outputDir, new Set(expectedPhysical));
  const files = physicalFiles.map((path) => (
    remapping
      ? remapPublicationPath(
        path,
        remapping.physicalRoot,
        remapping.logicalRoot,
      )
      : path
  )).sort(compareText);
  if (JSON.stringify(files) !== JSON.stringify(actual)) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Publication output directory contains unplanned files: ${files.filter((path) => !actual.includes(path)).join(', ')}`,
    );
  }
  for (const output of outputs) {
    const physicalPath = remapping
      ? remapPublicationPath(
        output.path,
        remapping.logicalRoot,
        remapping.physicalRoot,
      )
      : output.path;
    const actualBytes = await readFile(physicalPath);
    if (
      actualBytes.byteLength !== output.bytes
      || createHash('sha256').update(actualBytes).digest('hex') !== output.sha256
    ) {
      throw codedError(
        'PUBLICATION_EVIDENCE_INVALID',
        'Final Publication output does not match its recorded evidence',
      );
    }
  }
}

async function assertNoUnplannedOutputEntries(
  outputDir: string,
  plan: RenderOutputPlan,
): Promise<void> {
  await listFiles(outputDir, new Set(plan.outputs.map((output) => output.path)));
}

async function assertEmptyPublicationOutputDirectory(
  outputDir: string,
): Promise<void> {
  let entries: string[];
  try {
    entries = await readdir(outputDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (entries.length > 0) {
    throw codedError(
      'PUBLICATION_OUTPUT_UNPLANNED',
      `Publication output changed before atomic publish: ${entries.sort(compareText).join(', ')}`,
    );
  }
}

async function listFiles(
  directory: string,
  expectedFiles: ReadonlySet<string>,
): Promise<string[]> {
  let entries: Dirent[];
  try {
    entries = await readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const files: string[] = [];
  for (const entry of entries) {
    const path = resolve(directory, entry.name);
    const entryStat = await lstat(path);
    if (entryStat.isSymbolicLink()) {
      throw codedError(
        'PUBLICATION_OUTPUT_UNPLANNED',
        `Publication output contains an unplanned symbolic link: ${path}`,
      );
    }
    if (entryStat.isDirectory()) {
      files.push(...await listFiles(path, expectedFiles));
      continue;
    }
    if (!entryStat.isFile()) {
      throw codedError(
        'PUBLICATION_OUTPUT_UNPLANNED',
        `Publication output contains an unsupported filesystem entry: ${path}`,
      );
    }
    if (!expectedFiles.has(path)) {
      throw codedError(
        'PUBLICATION_OUTPUT_UNPLANNED',
        `Publication output contains an unplanned file: ${path}`,
      );
    }
    files.push(path);
  }
  return files;
}

function successPublicationResult(
  evidence: PublicationRenderEvidence,
  plan: RenderOutputPlan,
): PublicationRenderCommandResult {
  return {
    schema_version: 1,
    command: 'live-docs.publication.render',
    status: 'success',
    data: {
      ...evidence,
      plan,
      evidence_plan: evidence.plan,
    },
    diagnostics: [],
  };
}

function cancelledPublicationResult(input: {
  publication: PublicationRenderEvidence['publication'];
  plan: RenderOutputPlan;
  completedPaths: ReadonlySet<string>;
  reason: unknown;
}): PublicationRenderCommandResult {
  const completedOutputs = input.plan.outputs
    .filter((output) => input.completedPaths.has(output.path));
  const unfinishedOutputs = input.plan.outputs
    .filter((output) => !input.completedPaths.has(output.path));
  const reason = input.reason instanceof Error ? input.reason.message : String(input.reason ?? 'SIGINT');
  return {
    schema_version: 1,
    command: 'live-docs.publication.render',
    status: 'cancelled',
    data: {
      publication: input.publication,
      plan: input.plan,
      completed_outputs: completedOutputs,
      unfinished_outputs: unfinishedOutputs,
    },
    diagnostics: [{
      code: 'PUBLICATION_RENDER_INTERRUPTED',
      message: `Publication render interrupted: ${reason}`,
    }],
  };
}

function failedPublicationResult(error: unknown): PublicationRenderCommandResult {
  const code = error instanceof PublicationSelectionError
    ? error.code
    : typeof error === 'object' && error !== null && 'code' in error
      ? String(error.code)
      : 'PUBLICATION_RENDER_FAILED';
  const message = error instanceof Error ? error.message : String(error);
  const retryable = typeof error === 'object'
    && error !== null
    && 'retryable' in error
    && error.retryable === true;
  return {
    schema_version: 1,
    command: 'live-docs.publication.render',
    status: 'failed',
    data: null,
    diagnostics: [{ code, message, ...(retryable ? { retryable: true } : {}) }],
  };
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function selectOutputFormats(
  input: RenderLivedocInput,
  manifest: TemplateManifest,
): OutputFormat[] {
  if (input.format !== undefined) return [input.format];
  if (input.allFormats === true) return [...manifest.output_formats];
  if (input.noHtml === true) {
    return manifest.output_formats.filter((format) => format !== 'html');
  }
  if (manifest.output_formats.length === 1) return [...manifest.output_formats];
  throw new EngineError({
    code: 'OUTPUT_FORMAT_REQUIRED',
    message: `Template '${manifest.name}' declares multiple output formats; choose one of ${manifest.output_formats.join(', ')} or request allFormats.`,
  });
}

function rootRelative(workspaceRoot: string, path: string): string {
  return relative(workspaceRoot, path).split('\\').join('/');
}

function isLexicallyContained(relativePath: string): boolean {
  return !isAbsolute(relativePath) && relativePath.split(sep)[0] !== '..';
}

async function abortCheckpoint(signal: AbortSignal | undefined): Promise<void> {
  if (!signal) return;
  await new Promise<void>((resolveCheckpoint) => setImmediate(resolveCheckpoint));
  throwIfAborted(signal);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  throw new Error(String(signal.reason ?? 'Publication render interrupted'));
}

function isStableOutputFormatValidationError(error: unknown): boolean {
  return error instanceof ZodError && error.issues.some((issue) =>
    issue.path.includes('output_formats')
    && issue.message.startsWith('stable templates cannot use output formats'));
}

async function renderPptxTemplate(args: {
  input: RenderLivedocInput;
  manifest: TemplateManifest;
  source: TemplateSource;
  templatePath: string;
  templateDir: string;
  hub: HubModel;
  primaryLocale: string;
  variables: Record<string, string | boolean | number>;
  targets: SelectedTarget[];
  warnings: LivedocManifestWarning[];
  errors: EngineErrorDetail[];
  generatedAt: string;
}): Promise<RenderLivedocResult> {
  const {
    input,
    manifest,
    source,
    templatePath,
    templateDir,
    hub,
    primaryLocale,
    variables,
    targets,
    warnings,
    errors,
    generatedAt,
  } = args;
  const collector = makeCollector();
  const screenshots: ScreenshotArtifact[] = [];
  const prepared: PreparedBinaryOutput[] = [];
  const hb = createEngine();
  let pathTemplate: HandlebarsTemplateDelegate;
  try {
    pathTemplate = hb.compile(manifest.outputs.pptx!.output_path, { noEscape: true });
  } catch (error) {
    throw new EngineError({
      code: 'TEMPLATE_COMPILE_ERROR',
      message: `Template '${manifest.name}' pptx output-path compile error: ${(error as Error).message}`,
      path: templatePath,
    });
  }
  const { theme, warnings: themeWarnings } = await resolveTheme({
    templateDir,
    workspaceRoot: input.workspaceRoot,
    locale: input.locale,
    defaultLocale: manifest.default_locale,
  });
  for (const warning of themeWarnings) {
    warnings.push({ code: 'THEME_ASSET_MISSING', message: warning });
  }

  const string = (key: string, fallback: string): string =>
    manifest.strings[input.locale]?.[key]
      ?? manifest.strings[manifest.default_locale]?.[key]
      ?? fallback;
  const translateContext = {
    locale: input.locale,
    primaryLocale,
    lexicon: hub.lexicon,
    roles: hub.roles,
  };

  for (const target of targets) {
    if (!target.dok) continue;
    const dok = target.dok;
    const allSteps = dok.user_actions?.steps ?? [];
    const screenshotContext = await discoverTargetScreenshots(input, hub, target);
    screenshots.push(...screenshotContext.artifacts);
    const artifactByRelative = new Map(
      screenshotContext.artifacts.map((artifact) => [artifact.relativePath, artifact.sourcePath]),
    );
    const steps: PptxStep[] = allSteps.map((step, index) => {
      const relativeScreenshot = screenshotContext.stepScreenshots[index];
      const annotation = screenshotContext.stepAnnotations[index];
      const screenshotPath = relativeScreenshot
        ? artifactByRelative.get(relativeScreenshot)
        : undefined;
      return {
        number: index + 1,
        actorLabel: actorLabel(step.actor, translateContext, collector).text,
        isSystem: step.actor.kind === 'system',
        intent: resolveTranslatable(step.intent, translateContext, collector),
        outcome: resolveTranslatable(step.outcome, translateContext, collector),
        ...(screenshotPath ? { screenshotPath } : {}),
        ...(annotation ? { annotation } : {}),
      };
    });
    const view: PptxView = {
      dokId: dok.dok_id,
      title: resolveTranslatable(dok.name, translateContext, collector),
      description: resolveTranslatable(dok.description, translateContext, collector),
      locale: input.locale,
      generatedAt,
      steps,
      theme,
      strings: {
        generatedBy: string('generated_by', 'Generated by Doklo'),
        step: string('step', input.locale.startsWith('ko') ? '단계' : 'Step'),
        actorSystem: string('actor_system', input.locale.startsWith('ko') ? '시스템' : 'System'),
        screenshotDrop: string(
          'screenshot_drop',
          input.locale.startsWith('ko') ? '스크린샷을 여기에 놓아주세요' : 'Drop screenshot here',
        ),
      },
    };
    const root = makeHelperRoot({
      locale: input.locale,
      primaryLocale,
      hub,
      manifest,
      collector,
      stringsMissing: new Set(),
    });
    let outputPath: string;
    try {
      outputPath = pathTemplate(
        { dok, workspace: hub.workspace, locale: input.locale, variables },
        { data: { root } },
      );
    } catch (error) {
      throw new EngineError({
        code: 'TEMPLATE_COMPILE_ERROR',
        message: `Render failed for ${dok.dok_id} (pptx output path): ${(error as Error).message}`,
        dokId: dok.dok_id,
        path: templatePath,
      });
    }
    prepared.push({
      relativePath: plannedRelativePath(outputPath, 'pptx'),
      format: 'pptx',
      dokId: dok.dok_id,
      bytes: () => renderPptxBuffer(view),
    });
  }

  collectTranslationWarnings(collector, new Set(), manifest.name, warnings);
  const planContext = await buildPlan({
    input,
    source,
    templatePath,
    hub,
    targets,
    warnings,
    screenshots,
    outputs: prepared,
  });
  const emptyManifest = buildRenderManifest({
    manifest,
    source,
    input,
    primaryLocale,
    selectorApplied: false,
    outputs: [],
    collector,
    stringsMissing: new Set(),
    warnings,
    errors,
    generatedAt,
  });
  if (input.dryRun) return { outputs: [], manifest: emptyManifest, plan: planContext.plan };
  assertPlanWritable(planContext.plan);

  const outputs = await writeBinaryOutputs(planContext, prepared, input);
  const screenshotOutputs = await writeScreenshots(planContext, screenshots, input);
  const renderedManifest = buildRenderManifest({
    manifest,
    source,
    input,
    primaryLocale,
    selectorApplied: false,
    outputs: [...outputs, ...screenshotOutputs].sort((a, b) => compareText(a.path, b.path)),
    collector,
    stringsMissing: new Set(),
    warnings,
    errors,
    generatedAt,
  });
  const manifestOutput = findManifest(planContext.plan);
  const manifestPath = await writeManifest(
    planContext.plan.output_root,
    manifestOutput,
    renderedManifest,
  );
  input.onOutputWritten?.(manifestOutput);
  await abortCheckpoint(input.signal);
  return { outputs, manifest: renderedManifest, manifestPath, plan: planContext.plan };
}

async function renderXlsxTemplate(args: {
  input: RenderLivedocInput;
  manifest: TemplateManifest;
  source: TemplateSource;
  templatePath: string;
  templateDir: string;
  hub: HubModel;
  primaryLocale: string;
  targets: SelectedTarget[];
  warnings: LivedocManifestWarning[];
  errors: EngineErrorDetail[];
  generatedAt: string;
}): Promise<RenderLivedocResult> {
  const {
    input,
    manifest,
    source,
    templatePath,
    templateDir,
    hub,
    primaryLocale,
    targets,
    warnings,
    errors,
    generatedAt,
  } = args;
  const collector = makeCollector();
  let spec: XlsxSpec;
  const specPath = await resolveTemplatePath(
    templateDir,
    'sheet.yaml',
    'spreadsheet template specification',
    { allowMissingLeaf: true },
  );
  try {
    spec = parseXlsxSpec(yaml.load(await readFile(specPath, 'utf8')));
  } catch (error) {
    throw new EngineError({
      code: 'TEMPLATE_COMPILE_ERROR',
      message: `xlsx template '${manifest.name}' has no valid sheet.yaml: ${(error as Error).message}`,
      path: specPath,
    });
  }
  const strings = (key: string): string | undefined =>
    manifest.strings[input.locale]?.[key] ?? manifest.strings[manifest.default_locale]?.[key];
  const hb = createEngine();
  const pathTemplate = hb.compile(manifest.output_path, { noEscape: true });
  const groups: Array<{ doks: Dok[]; key: string; dok?: Dok }> =
    manifest.scope === 'workspace'
      ? [{
          doks: targets[0]?.doks ?? hub.doks.filter((dok) => dok.status !== 'archived'),
          key: '__workspace__',
        }]
      : targets
          .filter((target): target is { dok: Dok; key: string } => Boolean(target.dok))
          .map((target) => ({ doks: [target.dok], key: target.key, dok: target.dok }));
  const prepared: PreparedBinaryOutput[] = [];
  for (const group of groups) {
    const root = makeHelperRoot({
      locale: input.locale,
      primaryLocale,
      hub,
      manifest,
      collector,
      stringsMissing: new Set(),
    });
    const outputPath = pathTemplate(
      { dok: group.dok, workspace: hub.workspace, locale: input.locale },
      { data: { root } },
    );
    const buffer = await generateXlsxBuffer({
      spec,
      doks: group.doks,
      hub,
      locale: input.locale,
      primaryLocale,
      strings,
      collector,
      now: new Date(generatedAt),
    });
    prepared.push({
      relativePath: plannedRelativePath(outputPath, 'xlsx'),
      format: 'xlsx',
      ...(group.dok ? { dokId: group.dok.dok_id } : {}),
      bytes: async () => buffer,
    });
  }

  collectTranslationWarnings(collector, new Set(), manifest.name, warnings);
  const planContext = await buildPlan({
    input,
    source,
    templatePath,
    hub,
    targets,
    warnings,
    screenshots: [],
    outputs: prepared,
  });
  const emptyManifest = buildRenderManifest({
    manifest,
    source,
    input,
    primaryLocale,
    selectorApplied: false,
    outputs: [],
    collector,
    stringsMissing: new Set(),
    warnings,
    errors,
    generatedAt,
  });
  if (input.dryRun) return { outputs: [], manifest: emptyManifest, plan: planContext.plan };
  assertPlanWritable(planContext.plan);

  const outputs = await writeBinaryOutputs(planContext, prepared, input);
  const renderedManifest = buildRenderManifest({
    manifest,
    source,
    input,
    primaryLocale,
    selectorApplied: false,
    outputs,
    collector,
    stringsMissing: new Set(),
    warnings,
    errors,
    generatedAt,
  });
  const manifestOutput = findManifest(planContext.plan);
  const manifestPath = await writeManifest(
    planContext.plan.output_root,
    manifestOutput,
    renderedManifest,
  );
  input.onOutputWritten?.(manifestOutput);
  await abortCheckpoint(input.signal);
  return { outputs, manifest: renderedManifest, manifestPath, plan: planContext.plan };
}

function selectTargets(
  input: RenderLivedocInput,
  manifest: TemplateManifest,
  hub: HubModel,
  warnings: LivedocManifestWarning[],
): { targets: SelectedTarget[]; selectorApplied: boolean } {
  if (input.dokIds && input.dokIds.length > 0) {
    const selected = new Set(input.dokIds);
    const selectedDoks = hub.doks
      .filter((dok) => selected.has(dok.dok_id))
      .sort((a, b) => compareText(a.dok_id, b.dok_id));
    const missing = [...selected]
      .filter((dokId) => !selectedDoks.some((dok) => dok.dok_id === dokId))
      .sort(compareText);
    if (missing.length > 0) {
      throw new EngineError({
        code: 'SELECTOR_EMPTY',
        message: `Selected Doks are missing from the Hub: ${missing.join(', ')}`,
      });
    }
    assertStableDoksReviewed(manifest, selectedDoks, input.preview);
    if (manifest.scope === 'workspace') {
      return {
        targets: [{ doks: selectedDoks, key: '__workspace__' }],
        selectorApplied: false,
      };
    }
    return {
      targets: selectedDoks.map((dok) => ({ dok, key: dok.dok_id })),
      selectorApplied: false,
    };
  }
  if (manifest.scope === 'workspace') {
    if (manifest.stability !== 'stable') {
      return { targets: [{ key: '__workspace__' }], selectorApplied: false };
    }
    const available = hub.doks.filter((dok) => dok.status !== 'archived');
    const selected = available.filter((dok) => dok.status === 'active' || (input.preview && dok.status === 'draft'));
    if (selected.length === 0 && available.length > 0) {
      assertStableDoksReviewed(manifest, [available[0]!], input.preview);
    }
    return { targets: [{ doks: selected, key: '__workspace__' }], selectorApplied: false };
  }
  if (manifest.scope === 'per_dok') {
    const available = hub.doks.filter((dok) => dok.status !== 'archived');
    const selected = manifest.stability === 'stable'
      ? available.filter((dok) => dok.status === 'active' || (input.preview && dok.status === 'draft'))
      : available;
    if (manifest.stability === 'stable' && selected.length === 0 && available.length > 0) {
      assertStableDoksReviewed(manifest, [available[0]!], input.preview);
    }
    return {
      targets: selected.map((dok) => ({ dok, key: dok.dok_id })),
      selectorApplied: false,
    };
  }
  const matched = selectDoks(hub.doks, manifest.selector!);
  assertStableDoksReviewed(manifest, matched, input.preview);
  if (matched.length === 0) {
    if (input.strict) {
      throw new EngineError({
        code: 'SELECTOR_EMPTY',
        message: `Selector for template '${manifest.name}' matched 0 Doks`,
      });
    }
    warnings.push({
      code: 'SELECTOR_EMPTY',
      message: `Selector for template '${manifest.name}' matched 0 Doks`,
    });
  }
  return {
    targets: matched.map((dok) => ({ dok, key: dok.dok_id })),
    selectorApplied: true,
  };
}

function assertStableDoksReviewed(manifest: TemplateManifest, doks: Dok[], preview = false): void {
  if (manifest.stability !== 'stable') return;
  const unreviewed = doks.find((dok) => dok.status !== 'active' && !(preview && dok.status === 'draft'));
  if (!unreviewed) return;
  throw new EngineError({
    code: 'UNREVIEWED_DOK',
    dokId: unreviewed.dok_id,
    message: preview
      ? `Draft preview requires an active or draft Dok: ${unreviewed.dok_id} is ${unreviewed.status}.`
      : `Stable template '${manifest.name}' requires an active, human-reviewed Dok: ${unreviewed.dok_id} is ${unreviewed.status}. Use --preview for draft review without approval.`,
  });
}

function stableContextHub(
  manifest: TemplateManifest,
  hub: HubModel,
  target: SelectedTarget,
): HubModel {
  if (manifest.stability !== 'stable') return hub;
  const doks = target.doks ?? (target.dok ? [target.dok] : []);
  return { ...hub, doks };
}

function collectHubWarnings(
  manifest: TemplateManifest,
  hub: HubModel,
  warnings: LivedocManifestWarning[],
): void {
  for (const layer of manifest.requires_hub_layers) {
    if (layer === 'doks' && hub.doks.length === 0) {
      warnings.push({
        code: 'EMPTY_HUB',
        message: 'Hub has 0 Doks; template scope will produce minimal output',
      });
    } else if (layer === 'lexicon' && hub.lexicon.terms.length === 0) {
      warnings.push({
        code: 'EMPTY_LEXICON',
        message: 'Lexicon has 0 terms; TermRefs will appear as [TERM:???]',
      });
    } else if (layer === 'roles' && hub.roles.roles.length === 0) {
      warnings.push({
        code: 'EMPTY_ROLES',
        message: 'Roles is empty; role-based actor labels will degrade',
      });
    } else if (layer === 'ia' && !hub.services.some((service) => service.ia)) {
      warnings.push({
        code: 'MISSING_IA',
        message: "Template requires 'ia' layer but no service IA found",
      });
    } else if (
      layer === 'code-mapping'
      && !hub.services.some((service) => service.codeMapping)
    ) {
      warnings.push({
        code: 'MISSING_CODE_MAPPING',
        message: "Template requires 'code-mapping' but none found",
      });
    }
  }
}

async function discoverTargetScreenshots(
  input: RenderLivedocInput,
  hub: HubModel,
  target: SelectedTarget,
): Promise<Awaited<ReturnType<typeof collectScreenshots>>> {
  const stepCount = target.dok?.user_actions?.steps.length ?? 0;
  if (!target.dok || stepCount === 0) {
    return {
      stepScreenshots: new Array(stepCount).fill(null),
      stepScreenshotsByPlatform: {},
      stepAnnotations: new Array(stepCount).fill(null),
      stepAnnotationsByPlatform: {},
      copied: 0,
      artifacts: [],
    };
  }
  return collectScreenshots({
    workspaceRoot: input.workspaceRoot,
    dokId: target.dok.dok_id,
    outDir: input.outDir,
    stepCount,
    locale: input.locale,
    supportedLocales: hub.workspace.supported_locales,
    write: false,
  });
}

async function buildPlan(args: {
  input: RenderLivedocInput;
  source: TemplateSource;
  templatePath: string;
  hub: HubModel;
  targets: SelectedTarget[];
  warnings: LivedocManifestWarning[];
  screenshots: ScreenshotArtifact[];
  outputs: Array<{ relativePath: string; format: string; dokId?: string }>;
}): Promise<PlanContext> {
  const destination = args.input.outputRoot
    ? {
        outputRoot: await resolveContainedPath(args.input.outputRoot, '.', {
          rejectSymlinkLeaf: true,
        }),
        outputDir: relative(resolve(args.input.outputRoot), resolve(args.input.outDir))
          .split('\\').join('/'),
      }
    : await resolveOutputDestination(args.input.outDir);
  const dokIds = args.targets.flatMap((target) => (
    target.doks?.map((dok) => dok.dok_id)
      ?? (target.dok ? [target.dok.dok_id] : [])
  ));
  const dokPaths = await resolveDokInputPaths(args.input.workspaceRoot, args.hub, dokIds);
  const plan = await planRenderOutputs({
    outputRoot: destination.outputRoot,
    outputDir: destination.outputDir,
    overwrite: args.input.overwrite === true,
    targets: [...args.outputs, ...(args.input.additionalPlannedOutputs ?? [])]
      .map((output) => ({
        relativePath: output.relativePath,
        format: output.format,
        ...(output.dokId ? { dokId: output.dokId } : {}),
      })),
    screenshots: args.screenshots.map((screenshot) => ({
      relativePath: screenshot.relativePath,
      dokId: screenshot.dokId,
    })),
    inputs: {
      template_ref: args.input.templateRef,
      template_source: args.source,
      template_path: args.templatePath,
      dok_ids: dokIds,
      source_paths: [
        args.templatePath,
        ...dokPaths,
        ...args.screenshots.map((screenshot) => screenshot.sourcePath),
        ...(args.input.additionalSourcePaths ?? []),
      ],
    },
    warnings: args.warnings,
  });
  return { outputDir: destination.outputDir, plan };
}

async function resolveDokInputPaths(
  workspaceRoot: string,
  hub: HubModel,
  dokIds: string[],
): Promise<string[]> {
  if (dokIds.length === 0) return [];
  if (hub.layout === 'legacy') {
    return [await resolveTemplatePath(workspaceRoot, 'doks.json', 'Dok source', {
      allowMissingLeaf: true,
      rejectSymlinkLeaf: true,
    })];
  }
  return Promise.all(dokIds.map((dokId) => resolveTemplatePath(
    workspaceRoot,
    `.doklo/hub/doks/${dokId}.json`,
    'Dok source',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  )));
}

function findPlannedOutput(
  context: PlanContext,
  relativePath: string,
  format: string,
  dokId?: string,
): PlannedOutput {
  const fullRelativePath = context.outputDir
    ? posix.join(context.outputDir, relativePath.replaceAll('\\', '/'))
    : relativePath.replaceAll('\\', '/');
  const output = context.plan.outputs.find((candidate) =>
    candidate.relative_path === fullRelativePath
    && candidate.format === format
    && candidate.dok_id === dokId);
  if (!output) throw new Error(`planned output is missing: ${fullRelativePath}`);
  return output;
}

function findManifest(plan: RenderOutputPlan): PlannedOutput {
  const output = plan.outputs.find((candidate) => candidate.format === 'manifest');
  if (!output) throw new Error('manifest output is missing from the plan');
  return output;
}

function assertPlanWritable(plan: RenderOutputPlan): void {
  const blocked = plan.outputs.filter((output) => output.action === 'blocked');
  if (blocked.length === 0) return;
  throw new EngineError({
    code: 'OUTPUT_EXISTS',
    message: `output exists; pass --overwrite to replace: ${blocked.map((output) => output.path).join(', ')}`,
    path: blocked[0]?.path,
  });
}

async function writeScreenshots(
  context: PlanContext,
  screenshots: ScreenshotArtifact[],
  input: RenderLivedocInput,
): Promise<Array<WriterResult & { dokId?: string }>> {
  const outputs: Array<WriterResult & { dokId?: string }> = [];
  for (const screenshot of screenshots) {
    const planned = findPlannedOutput(
      context,
      screenshot.relativePath,
      'screenshot',
      screenshot.dokId,
    );
    throwIfAborted(input.signal);
    try {
      const bytes = await readFile(screenshot.sourcePath);
      const path = await writePlannedArtifact(
        context.plan.output_root,
        planned,
        bytes,
      );
      outputs.push({
        path,
        bytes: bytes.byteLength,
        format: 'screenshot',
        dokId: screenshot.dokId,
      });
    } catch (error) {
      throwWriterError(error, 'screenshot', screenshot.dokId, planned.path);
    }
    input.onOutputWritten?.(planned);
    await abortCheckpoint(input.signal);
  }
  return outputs;
}

async function writeBinaryOutputs(
  context: PlanContext,
  prepared: PreparedBinaryOutput[],
  input: RenderLivedocInput,
): Promise<Array<WriterResult & { dokId?: string }>> {
  const outputs: Array<WriterResult & { dokId?: string }> = [];
  for (const output of prepared) {
    const planned = findPlannedOutput(context, output.relativePath, output.format, output.dokId);
    throwIfAborted(input.signal);
    try {
      const bytes = await output.bytes();
      const path = await writePlannedArtifact(
        context.plan.output_root,
        planned,
        bytes,
      );
      outputs.push({
        path,
        bytes: bytes.byteLength,
        format: output.format,
        ...(output.dokId ? { dokId: output.dokId } : {}),
      });
    } catch (error) {
      throwWriterError(error, output.format, output.dokId ?? '__workspace__', planned.path);
    }
    input.onOutputWritten?.(planned);
    await abortCheckpoint(input.signal);
  }
  return outputs;
}

function throwWriterError(error: unknown, format: string, key: string, path: string): never {
  if (error instanceof OutputExistsError) {
    throw new EngineError({ code: 'OUTPUT_EXISTS', message: error.message, path });
  }
  if (isPathIdentityChangedError(error)) throw error;
  throw new EngineError({
    code: 'WRITER_FAILURE',
    message: `Writer '${format}' failed for ${key}: ${(error as Error).message}`,
    path,
  });
}

function isPathIdentityChangedError(
  error: unknown,
): error is Error & { code: 'PATH_IDENTITY_CHANGED'; retryable: true } {
  return error instanceof Error
    && 'code' in error
    && error.code === 'PATH_IDENTITY_CHANGED'
    && 'retryable' in error
    && error.retryable === true;
}

function collectTranslationWarnings(
  collector: TranslateCollector,
  stringsMissing: Set<string>,
  templateName: string,
  warnings: LivedocManifestWarning[],
): void {
  for (const term of [...collector.unresolved].sort(compareText)) {
    warnings.push({
      code: 'UNRESOLVED_TRANSLATABLE',
      message: `Could not resolve term '${term}' in any locale`,
      field: term,
    });
  }
  for (const key of [...stringsMissing].sort(compareText)) {
    warnings.push({
      code: 'MISSING_STRINGS_KEY',
      message: `Template '${templateName}' has no strings entry for '${key}'`,
      field: key,
    });
  }
}

function buildRenderManifest(args: {
  manifest: TemplateManifest;
  source: TemplateSource;
  input: RenderLivedocInput;
  primaryLocale: string;
  selectorApplied: boolean;
  outputs: Array<WriterResult & { dokId?: string }>;
  collector: TranslateCollector;
  stringsMissing: Set<string>;
  warnings: LivedocManifestWarning[];
  errors: EngineErrorDetail[];
  generatedAt: string;
}): LivedocManifest {
  return buildManifest({
    ...(args.input.preview ? { renderMode: 'draft-preview' as const } : {}),
    template: {
      name: args.manifest.name,
      version: args.manifest.version,
      source: args.source,
      stability: args.manifest.stability,
      audience: args.manifest.audience,
      purpose: args.manifest.purpose,
      job: args.manifest.job,
      required_input: args.manifest.required_input,
      variables: args.manifest.variables,
      output_formats: args.manifest.output_formats,
    },
    locale: args.input.locale,
    primaryLocale: args.primaryLocale,
    workspaceRoot: args.input.workspaceRoot,
    scope: args.manifest.scope,
    selectorApplied: args.selectorApplied,
    outputs: args.outputs,
    collector: args.collector,
    stringsMissing: args.stringsMissing,
    warnings: args.warnings,
    errors: args.errors,
    generatedAt: args.generatedAt,
  });
}

function selectStableWorkspaceDoks(args: {
  manifest: TemplateManifest;
  targets: SelectedTarget[];
  hub: HubModel;
  input: RenderLivedocInput;
  primaryLocale: string;
  variables: Record<string, string | boolean | number>;
  selectedFormats: OutputFormat[];
  compiledOutputs: Map<OutputFormat, CompiledTextOutput>;
  generatedAt: string;
}): {
  targets: SelectedTarget[];
  skipped: Array<{ dokId: string; violations: StableLintViolation[] }>;
  retainedRemovedSnapshots?: EvidenceDokSnapshot[];
} {
  if (args.manifest.stability !== 'stable' || args.manifest.scope !== 'workspace') {
    return { targets: args.targets, skipped: [] };
  }
  const target = args.targets[0];
  const candidates = target?.doks;
  if (!target || !candidates || candidates.length === 0) {
    return { targets: args.targets, skipped: [] };
  }

  const globalViolations = stableWorkspaceProbeViolations(args, []);
  if (globalViolations.length > 0) throw new StableLintError(globalViolations);

  const retained: Dok[] = [];
  const skipped: Array<{ dokId: string; violations: StableLintViolation[] }> = [];
  for (const dok of candidates) {
    const violations = stableWorkspaceProbeViolations(args, [dok], []);
    if (violations.length === 0) retained.push(dok);
    else skipped.push({ dokId: dok.dok_id, violations });
  }
  if (retained.length === 0 && skipped.length > 0) {
    throw new StableLintError(dedupeStableViolations(
      skipped.flatMap((entry) => entry.violations),
    ));
  }
  const changes = args.input.extraContext?.['changes'];
  const retainedRemovedSnapshots: EvidenceDokSnapshot[] = [];
  if (isDokChangeSet(changes)) {
    for (const snapshot of changes.removed) {
      const violations = stableWorkspaceProbeViolations(args, [], [snapshot]);
      if (violations.length === 0) retainedRemovedSnapshots.push(snapshot);
      else skipped.push({ dokId: snapshot.dok_id, violations });
    }
  }
  return {
    targets: [{ ...target, doks: retained }],
    skipped,
    ...(isDokChangeSet(changes) ? { retainedRemovedSnapshots } : {}),
  };
}

function stableWorkspaceProbeViolations(
  args: {
    manifest: TemplateManifest;
    hub: HubModel;
    input: RenderLivedocInput;
    primaryLocale: string;
    variables: Record<string, string | boolean | number>;
    selectedFormats: OutputFormat[];
    compiledOutputs: Map<OutputFormat, CompiledTextOutput>;
    generatedAt: string;
  },
  doks: Dok[],
  removedSnapshots: EvidenceDokSnapshot[] = [],
): StableLintViolation[] {
  const hub = { ...args.hub, doks };
  const collector = makeCollector();
  const stringsMissing = new Set<string>();
  const root = makeHelperRoot({
    locale: args.input.locale,
    primaryLocale: args.primaryLocale,
    hub,
    manifest: args.manifest,
    collector,
    stringsMissing,
    ...(args.input.audienceDictionary
      ? { audienceDictionary: args.input.audienceDictionary }
      : {}),
  });
  const context = {
    ...scopeStableWorkspaceExtraContext(
      args.input.extraContext,
      args.manifest,
      doks,
      removedSnapshots,
    ),
    dok: undefined,
    doks,
    changelog: buildChangelog(doks),
    workspace: hub.workspace,
    services: hub.services,
    hub,
    locale: args.input.locale,
    primaryLocale: args.primaryLocale,
    variables: args.variables,
    step_screenshots: [],
    step_screenshots_by_platform: {},
    step_annotations: [],
    step_annotations_by_platform: {},
    platforms: [],
  };
  const prepared = args.selectedFormats.map((format): PreparedTextOutput => {
    const output = args.compiledOutputs.get(format)!;
    try {
      return {
        relativePath: '__stable-workspace-probe__',
        format,
        content: output.body(context, {
          data: { root: { ...root, __outputSource: output.source } },
        }),
        source: output.source,
      };
    } catch (error) {
      throw new EngineError({
        code: 'TEMPLATE_COMPILE_ERROR',
        message: `Stable workspace probe failed for '${args.manifest.name}' (${format}): ${(error as Error).message}`,
      });
    }
  });
  return stablePreparedViolations(
    args.manifest,
    prepared,
    args.generatedAt,
    [
      ...doks.map((dok) => dok.dok_id),
      ...removedSnapshots.map((snapshot) => snapshot.dok_id),
    ],
    hub.workspace.stable_public_terms,
  );
}

function scopeStableWorkspaceExtraContext(
  extraContext: Record<string, unknown> | undefined,
  manifest: TemplateManifest,
  doks: Dok[],
  removedSnapshots: readonly EvidenceDokSnapshot[] | undefined,
): Record<string, unknown> {
  const context = { ...(extraContext ?? {}) };
  if (manifest.stability !== 'stable' || manifest.scope !== 'workspace') return context;
  const changes = context['changes'];
  if (!isDokChangeSet(changes)) return context;

  const selected = new Set(doks.map((dok) => dok.dok_id));
  const added = changes.added.filter((dok) => selected.has(dok.dok_id));
  const changed = changes.changed.filter((dok) => selected.has(dok.dok_id));
  const unchanged = changes.unchanged.filter((dok) => selected.has(dok.dok_id));
  const removed = [...(removedSnapshots ?? [])];
  const notes = Object.fromEntries(
    Object.entries(changes.notes).filter(([dokId]) => selected.has(dokId)),
  );
  const notesText = Object.fromEntries(
    Object.entries(changes.notes_text).filter(([dokId]) => selected.has(dokId)),
  );
  context['changes'] = {
    ...changes,
    added,
    changed,
    unchanged,
    removed,
    notes,
    notes_text: notesText,
    has_customer_changes:
      added.length > 0 || changed.length > 0 || removed.length > 0,
  } satisfies DokChangeSet;
  return context;
}

function isDokChangeSet(value: unknown): value is DokChangeSet {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Partial<DokChangeSet>;
  return Array.isArray(candidate.added)
    && Array.isArray(candidate.changed)
    && Array.isArray(candidate.unchanged)
    && Array.isArray(candidate.removed)
    && typeof candidate.notes === 'object'
    && candidate.notes !== null
    && typeof candidate.notes_text === 'object'
    && candidate.notes_text !== null;
}

function appendSkippedStableDokWarnings(
  warnings: LivedocManifestWarning[],
  skipped: Array<{ dokId: string; violations: StableLintViolation[] }>,
): void {
  for (const entry of skipped) {
    const counts = new Map<StableLintViolation['code'], number>();
    for (const violation of entry.violations) {
      counts.set(violation.code, (counts.get(violation.code) ?? 0) + 1);
    }
    const reasons = [...counts.entries()]
      .map(([code, count]) => `${code} (${count})`)
      .join(', ');
    warnings.push({
      code: 'SKIPPED_STABLE_DOK',
      dok_id: entry.dokId,
      message: `Skipped ${entry.dokId}: ${reasons}`,
    });
  }
}

function assertStablePrepared(
  manifest: TemplateManifest,
  prepared: PreparedTextOutput[],
  generatedAt: string,
  explicitDokIds?: readonly string[],
  allowTerms?: readonly string[],
): void {
  const violations = stablePreparedViolations(
    manifest,
    prepared,
    generatedAt,
    explicitDokIds,
    allowTerms,
  );
  if (violations.length > 0) throw new StableLintError(violations);
}

function selectStablePrepared(
  manifest: TemplateManifest,
  prepared: PreparedTextOutput[],
  generatedAt: string,
  explicitDokIds?: readonly string[],
  allowTerms?: readonly string[],
): {
  outputs: PreparedTextOutput[];
  skipped: Array<{ dokId: string; violations: StableLintViolation[] }>;
} {
  if (manifest.stability !== 'stable' || manifest.scope !== 'per_dok') {
    assertStablePrepared(manifest, prepared, generatedAt, explicitDokIds, allowTerms);
    return { outputs: prepared, skipped: [] };
  }

  const byDok = new Map<string, PreparedTextOutput[]>();
  for (const output of prepared) {
    if (!output.dokId) {
      assertStablePrepared(manifest, prepared, generatedAt, undefined, allowTerms);
      return { outputs: prepared, skipped: [] };
    }
    const group = byDok.get(output.dokId) ?? [];
    group.push(output);
    byDok.set(output.dokId, group);
  }
  if (byDok.size === 0) {
    assertStablePrepared(manifest, prepared, generatedAt, undefined, allowTerms);
    return { outputs: prepared, skipped: [] };
  }

  const outputs: PreparedTextOutput[] = [];
  const skipped: Array<{ dokId: string; violations: StableLintViolation[] }> = [];
  for (const [dokId, dokOutputs] of byDok) {
    const violations = stablePreparedViolations(manifest, dokOutputs, generatedAt, [dokId], allowTerms);
    if (violations.length === 0) outputs.push(...dokOutputs);
    else skipped.push({ dokId, violations });
  }
  if (outputs.length === 0 && skipped.length > 0) {
    throw new StableLintError(dedupeStableViolations(skipped.flatMap((entry) => entry.violations)));
  }
  return { outputs, skipped };
}

function stablePreparedViolations(
  manifest: TemplateManifest,
  prepared: PreparedTextOutput[],
  generatedAt: string,
  explicitDokIds?: readonly string[],
  allowTerms?: readonly string[],
): StableLintViolation[] {
  if (manifest.stability !== 'stable') return [];
  const contents = [...new Set(prepared.map((output) => (
    output.source === 'markdown'
      ? marked.parse(output.content) as string
      : output.content
  )))];
  if (contents.length === 0) contents.push('');
  const knownDokIds = [...new Set(explicitDokIds ?? prepared.flatMap((output) => (
    output.dokId ? [output.dokId] : []
  )))].sort(compareText);
  const violations: StableLintViolation[] = [];
  const seen = new Set<string>();
  for (const output of prepared) {
    if (output.format !== 'markdown') continue;
    for (const violation of lintStableMarkdown(output.content)) {
      const key = `${violation.code}\0${violation.message}\0${violation.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(violation);
    }
  }
  for (const html of contents) {
    for (const violation of lintStableArtifact({
      html,
      manifest,
      provenance: { generatedAt },
      knownDokIds,
      ...(allowTerms ? { allowTerms } : {}),
    })) {
      const key = `${violation.code}\0${violation.message}\0${violation.excerpt}`;
      if (seen.has(key)) continue;
      seen.add(key);
      violations.push(violation);
    }
  }
  return violations;
}

function dedupeStableViolations(
  violations: readonly StableLintViolation[],
): StableLintViolation[] {
  const seen = new Set<string>();
  return violations.filter((violation) => {
    const key = `${violation.code}\0${violation.message}\0${violation.excerpt}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function collectStableHelpWarnings(
  manifest: TemplateManifest,
  dok: Dok | undefined,
  screenshots: Awaited<ReturnType<typeof collectScreenshots>>,
  variables: Record<string, string | boolean | number>,
  warnings: LivedocManifestWarning[],
): void {
  if (manifest.stability !== 'stable' || manifest.name !== 'help-page' || !dok) return;
  const steps = dok.user_actions?.steps ?? [];
  const rules = dok.business_rules?.rules ?? [];
  const checks = dok.acceptance_criteria?.criteria ?? [];
  const warning = (code: string, message: string, field: string): void => {
    warnings.push({ code, message, dok_id: dok.dok_id, field });
  };
  if (steps.length === 0) {
    warning('OMITTED_ACTIONS', 'The actions section was omitted because no reviewed actions are available.', 'actions');
  }
  if (rules.length === 0) {
    warning('OMITTED_RULES', 'The rules and limitations section was omitted because no reviewed rules are available.', 'rules');
  }
  if (checks.length === 0) {
    warning('OMITTED_CHECKS', 'The completion checks section was omitted because no reviewed checks are available.', 'checks');
  }
  const platforms = Object.keys(screenshots.stepScreenshotsByPlatform);
  const hidesScreenshots = variables['hide_screenshots'] === true;
  const missingScreenshot = steps.length === 0 || steps.some((step, index) => {
    const hasReviewedScreenshot = platforms.length > 0
      ? platforms.some((platform) => Boolean(screenshots.stepScreenshotsByPlatform[platform]?.[index]))
      : Boolean(screenshots.stepScreenshots[index]);
    return hidesScreenshots || step.actor.kind === 'system' || !hasReviewedScreenshot;
  });
  if (missingScreenshot) {
    warning(
      'OMITTED_SCREENSHOTS',
      'Screenshots excluded by publication settings, step visibility, or missing reviewed assets were omitted.',
      'screenshots',
    );
  }
}

function canonicalGeneratedAt(hub: HubModel): string {
  return hub.workspace.updated_at ?? hub.workspace.created_at ?? CANONICAL_EPOCH;
}

function makeHelperRoot(args: {
  locale: string;
  primaryLocale: string;
  hub: HubModel;
  manifest: TemplateManifest;
  collector: TranslateCollector;
  stringsMissing: Set<string>;
  audienceDictionary?: AudienceDictionary;
}): ServiceAwareHelperRoot {
  return {
    __locale: args.locale,
    __primaryLocale: args.primaryLocale,
    __lexicon: args.hub.lexicon,
    __roles: args.hub.roles,
    __workspace: args.hub.workspace,
    __strings: args.manifest.strings,
    __defaultLocale: args.manifest.default_locale,
    __stringsMissing: args.stringsMissing,
    __collector: args.collector,
    ...(args.audienceDictionary ? { __audienceDictionary: args.audienceDictionary } : {}),
  };
}

function satisfiesMinVersion(have: string, required: string): boolean {
  const cleaned = required.replace(/^[\^>=~]+/, '').trim();
  const actual = parseSemver(have);
  const minimum = parseSemver(cleaned);
  if (!actual || !minimum) return true;
  if (actual[0] !== minimum[0]) return actual[0] > minimum[0];
  if (actual[1] !== minimum[1]) return actual[1] > minimum[1];
  return actual[2] >= minimum[2];
}

function parseSemver(value: string): [number, number, number] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
