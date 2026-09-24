export { ENGINE_VERSION } from './version.js';
export { renderLivedoc, renderPublication } from './render.js';
export type {
  PublicationRenderCommandResult,
  PublicationRenderCancellation,
  PublicationRenderEvidence,
  PublicationRenderSuccessData,
  RenderPublicationInput,
  RenderLivedocInput,
  RenderLivedocResult,
} from './render.js';
export {
  listTemplates,
  resolveTemplate,
  TemplateNotFoundError,
} from './template-loader.js';
export type {
  ListEntry,
  ResolvedTemplate,
  TemplateSource,
} from './template-loader.js';
export {
  parseTemplate,
  listTemplateDirs,
  TemplateParseError,
} from './template-parser.js';
export type { ParsedTemplate, ParseTemplateOptions } from './template-parser.js';
export {
  parseTemplateManifest,
  coerceTemplateVariables,
  TemplateManifestSchema,
  TemplateStabilitySchema,
  TemplateVariableDefinitionSchema,
  TemplateSelectorSchema,
  TemplateOutputSourceSchema,
  OutputFormatV1,
} from './template-manifest.js';
export type {
  TemplateManifest,
  TemplateOutputRecipe,
  TemplateOutputSource,
  TemplateStability,
  TemplateVariableDefinition,
  TemplateScope,
  TemplateSelector,
  OutputFormat,
} from './template-manifest.js';
export { selectDoks } from './selector.js';
export { EngineError } from './errors.js';
export type { EngineErrorCode, EngineErrorDetail } from './errors.js';
export { ThemeFileSchema, ENGINE_DEFAULT_THEME, resolveTheme } from './theme.js';
export type { ThemeFile, ResolvedTheme, ResolveThemeArgs } from './theme.js';
export {
  assertSafeTemplateSegment,
  assertTemplateTreeHasNoSymlinks,
  resolveTemplatePath,
  TemplatePathError,
} from './path-security.js';
export type {
  LivedocManifest,
  LivedocManifestOutputEntry,
  LivedocManifestWarning,
} from './manifest.js';
export { lintStableArtifact, StableLintError } from './stable-lint.js';
export type { StableLintViolation } from './stable-lint.js';
export { loadWorkspaceAudienceDictionary } from './audience-dictionary.js';
export type { WorkspaceAudienceDictionaryResult } from './audience-dictionary.js';
export {
  OutputExistsError,
  writeArtifactAtomic,
  writePlannedArtifact,
} from './atomic-output.js';
export {
  DuplicateOutputError,
  planRenderOutputs,
  plannedRelativePath,
  reproducibleRenderOutputPlan,
  resolveOutputDestination,
} from './output-plan.js';
export type {
  PlannedOutput,
  ReproduciblePlannedOutput,
  ReproducibleRenderOutputPlan,
  RenderOutputPlan,
  RenderPlanInputs,
  RenderPlanWarning,
} from './output-plan.js';
export {
  effectivePublicationUpdateMode,
  parsePublication,
  publicationDigest,
  PublicationFormatSchema,
  PublicationDestinationSchema,
  PublicationNameSchema,
  PublicationSchema,
  PublicationSelectionSchema,
  PublicationUpdateModeSchema,
  serializePublication,
} from './publication.js';
export type {
  PublicationDestination,
  PublicationFormat,
  PublicationSelection,
  PublicationUpdateMode,
  PublicationV1,
} from './publication.js';
export {
  PublicationSelectionError,
  resolvePublicationDokIds,
  selectPublicationDoks,
} from './render-selection.js';
export type { PublicationTarget } from './render-selection.js';
export {
  buildTemplateSelectionModel,
  resolveTemplateSelection,
  TemplateSelectionError,
} from './template-selection-model.js';
export type {
  TemplateSelectionExclusionReason,
  TemplateSelectionKind,
  TemplateSelectionModel,
} from './template-selection-model.js';
export { projectPublicationStatus } from './publication-status.js';
export type {
  PublicationPublishRecord,
  PublicationPublishState,
  PublicationRenderState,
  PublicationStatus,
  PublicationStatusReason,
} from './publication-status.js';
export {
  buildChangelog,
  classifyDokHistory,
  type Changelog,
  type ChangelogGroup,
  type ChangelogItem,
} from './changelog.js';
export {
  buildDokSnapshots,
  classifyDokChanges,
  dokContentDigest,
  type DokChangeSet,
  type EvidenceDokSnapshot,
} from './dok-changes.js';
export { effectiveRenderInputDigest } from './render-input-digest.js';
export {
  buildIaIndex,
  type IaIndexEntry,
  type IaIndexNode,
  type IaIndexResult,
} from './helpers/ia-index.js';
export {
  buildPublicationArchive,
  PublicationArchiveError,
} from './publication-archive.js';

export { hasDraftPreviewMarker } from './manifest.js';
