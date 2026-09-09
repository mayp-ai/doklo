import {
  loadHubModel,
  resolveContainedPath,
  resolveTranslatable,
  type Dok,
} from '@doklo-beta/core';
import type {
  PublicationPublishRecord,
  PublicationRenderEvidence,
  PublicationStatus,
  PublicationV1,
  TemplateManifest,
  TemplateSelectionModel,
  TemplateStability,
  TemplateVariableDefinition,
} from '@doklo-beta/livedoc-engine';
import {
  createHash,
} from 'node:crypto';
import {
  readFile,
  readdir,
} from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import {
  publicationUiLocale,
  type PublicationUiLocale,
} from './publication-copy';

const EVIDENCE_FILE = 'publication-evidence.json';
const PUBLISH_LEDGER_FILE = 'doklo-publish.json';

export type PublicationTemplateReadModel = {
  name: string;
  version: string;
  source: 'workspace' | 'user' | 'builtin';
  stability: TemplateStability;
  display_name: string;
  description: string;
  audience: string;
  purpose: string;
  job: string;
  required_input: string;
  scope: TemplateManifest['scope'];
  default_format: TemplateManifest['default_format'];
  output_formats: TemplateManifest['output_formats'];
  supported_locales: string[];
  default_locale: string;
  variables: Record<string, TemplateVariableDefinition>;
  selection: TemplateSelectionModel;
};

export type PublicationDokReadModel = {
  dok_id: string;
  name: string;
  status: Dok['status'];
  tags: string[];
  surfaces: string[];
};

export type PublicationReadModelEntry = {
  publication: PublicationV1;
  effective_update_mode: 'manual' | 'review';
  definition_path: string;
  definition_sha256: string;
  template: PublicationTemplateReadModel;
  status: PublicationStatus;
  change_summary?: PublicationChangeSummary;
  evidence?: PublicationRenderEvidence;
};

export type PublicationChangeSummary = {
  added: PublicationChangeItem[];
  changed: PublicationChangeItem[];
  removed: PublicationChangeItem[];
  excluded: Array<PublicationChangeItem & {
    reason: 'unreviewed' | 'template_selector';
  }>;
};

export type PublicationChangeItem = {
  dok_id: string;
  name: string;
};

export type PublicationReadError = {
  code:
    | 'PUBLICATION_INVALID'
    | 'PUBLICATION_UNREADABLE'
    | 'PUBLICATION_TEMPLATE_MISSING'
    | 'PUBLICATION_EVIDENCE_INVALID';
  path: string;
  message: string;
};

export type PublicationWorkspaceModel = {
  locale: PublicationUiLocale;
  workspace_default_locale: string;
  templates: PublicationTemplateReadModel[];
  publications: PublicationReadModelEntry[];
  doks: PublicationDokReadModel[];
  errors: PublicationReadError[];
};

export async function loadPublicationWorkspaceModel(options: {
  root: string;
  includeExperimental?: boolean;
}): Promise<PublicationWorkspaceModel> {
  const engine = await loadEngine();
  const hub = await loadHubModel(options.root);
  const locale = publicationUiLocale(hub.workspace.default_locale);
  const templates = await loadTemplateCatalog({
    root: options.root,
    locale,
    doks: hub.doks,
    includeExperimental: options.includeExperimental ?? true,
    engine,
  });
  const templateByName = new Map(
    templates.map((template) => [template.name, template]),
  );
  const errors: PublicationReadError[] = [];
  const publications: PublicationReadModelEntry[] = [];
  const directory = join(
    options.root,
    '.doklo',
    'livedocs',
    'publications',
  );
  let names: string[] = [];
  try {
    names = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
      .map((entry) => entry.name)
      .sort(compareText);
  } catch (error) {
    if (!isMissingError(error)) {
      errors.push({
        code: 'PUBLICATION_UNREADABLE',
        path: directory,
        message: errorMessage(error),
      });
    }
  }

  for (const fileName of names) {
    const path = join(directory, fileName);
    let publication: PublicationV1;
    try {
      publication = engine.parsePublication(
        JSON.parse(await readFile(path, 'utf8')) as unknown,
      );
      const expectedName = fileName.slice(0, -'.json'.length);
      if (publication.name !== expectedName) {
        throw new Error(
          `file name requires Publication name "${expectedName}"`,
        );
      }
    } catch (error) {
      errors.push({
        code: isSyntaxOrValidationError(error)
          ? 'PUBLICATION_INVALID'
          : 'PUBLICATION_UNREADABLE',
        path,
        message: errorMessage(error),
      });
      continue;
    }

    const template = templateByName.get(publication.template);
    if (!template) {
      errors.push({
        code: 'PUBLICATION_TEMPLATE_MISSING',
        path,
        message: `Template '${publication.template}' is not available.`,
      });
      continue;
    }
    const resolvedTemplate = await engine.resolveTemplate(publication.template, {
      workspaceRoot: options.root,
    });
    const definitionSha256 = engine.publicationDigest(publication);
    const evidenceResult = await readEvidence(options.root, publication);
    if (evidenceResult.error) errors.push(evidenceResult.error);
    const publishResult = await readPublishRecord(
      options.root,
      publication,
    );
    let resolvedForDigest: string[];
    try {
      resolvedForDigest = engine.resolveTemplateSelection(
        engine.buildTemplateSelectionModel({
          manifest: resolvedTemplate.parsed.manifest,
          doks: hub.doks,
        }),
        publication.selection,
        hub.doks,
      );
    } catch {
      resolvedForDigest = [...publication.selected_dok_ids].sort(compareText);
    }
    const renderInputSha256 = await engine.effectiveRenderInputDigest({
      workspaceRoot: options.root,
      templateRef: publication.template,
      templateSource: resolvedTemplate.source,
      locale: publication.locale,
      primaryLocale: hub.workspace.default_locale,
      format: publication.format,
      variables: publication.vars,
      selectedDokIds: resolvedForDigest,
      hub,
      resolvedTemplate,
    });
    let status = engine.projectPublicationStatus({
      publication,
      definition_sha256: definitionSha256,
      manifest: resolvedTemplate.parsed.manifest,
      doks: hub.doks,
      render_input_sha256: renderInputSha256,
      ...(evidenceResult.evidence
        ? { evidence: evidenceResult.evidence }
        : {}),
      ...(publishResult.record
        ? { publish_record: publishResult.record }
        : {}),
      ...(publishResult.blocked ? { publish_blocked: true } : {}),
    });
    if (evidenceResult.error) {
      status = {
        ...status,
        render_state: 'blocked',
        reasons: Array.from(new Set([
          ...status.reasons,
          'evidence_invalid' as const,
        ])),
      };
    }
    const currentDoks = status.resolved_dok_ids
      .map((dokId) => hub.doks.find((dok) => dok.dok_id === dokId))
      .filter((dok): dok is Dok => dok !== undefined);
    const changes = engine.classifyDokChanges(
      currentDoks,
      evidenceResult.evidence?.dok_snapshots,
    );
    const displayName = (dok: Dok): string => resolveTranslatable(dok.name, {
      locale,
      primaryLocale: hub.workspace.default_locale,
      lexicon: hub.lexicon,
      roles: hub.roles,
    });
    publications.push({
      publication,
      effective_update_mode:
        engine.effectivePublicationUpdateMode(publication),
      definition_path: path,
      definition_sha256: definitionSha256,
      template,
      status,
      change_summary: {
        added: changes.added.map((dok) => ({
          dok_id: dok.dok_id,
          name: displayName(dok),
        })),
        changed: changes.changed.map((dok) => ({
          dok_id: dok.dok_id,
          name: displayName(dok),
        })),
        removed: changes.removed.map((snapshot) => ({
          dok_id: snapshot.dok_id,
          name: snapshot.name,
        })),
        excluded: template.selection.excluded.map((excluded) => {
          const dok = hub.doks.find(
            (candidate) => candidate.dok_id === excluded.dok_id,
          );
          return {
            dok_id: excluded.dok_id,
            name: dok ? displayName(dok) : excluded.dok_id,
            reason: excluded.reason,
          };
        }),
      },
      ...(evidenceResult.evidence
        ? { evidence: evidenceResult.evidence }
        : {}),
    });
  }

  return {
    locale,
    workspace_default_locale: hub.workspace.default_locale,
    templates,
    publications: publications.sort((left, right) =>
      compareText(left.publication.name, right.publication.name),
    ),
    doks: [...hub.doks].sort(byDokId).map((dok) => ({
      dok_id: dok.dok_id,
      name: resolveTranslatable(dok.name, {
        locale,
        primaryLocale: hub.workspace.default_locale,
        lexicon: hub.lexicon,
        roles: hub.roles,
      }),
      status: dok.status,
      tags: [...dok.tags],
      surfaces: [...dok.surfaces],
    })),
    errors,
  };
}

async function loadTemplateCatalog(input: {
  root: string;
  locale: PublicationUiLocale;
  doks: Dok[];
  includeExperimental: boolean;
  engine: LivedocEngineModule;
}): Promise<PublicationTemplateReadModel[]> {
  const listed = await input.engine.listTemplates({
    workspaceRoot: input.root,
    includeExperimental: input.includeExperimental,
  });
  const active = listed.filter((entry) => entry.active);
  const templates = await Promise.all(active.map(async (entry) => {
    const resolved = await input.engine.resolveTemplate(entry.name, {
      workspaceRoot: input.root,
    });
    const manifest = resolved.parsed.manifest;
    return {
      name: manifest.name,
      version: manifest.version,
      source: resolved.source,
      stability: manifest.stability,
      display_name: localized(
        manifest.display_name,
        input.locale,
        manifest.default_locale,
        manifest.name,
      ),
      description: localized(
        manifest.description,
        input.locale,
        manifest.default_locale,
        manifest.name,
      ),
      audience: localized(
        manifest.audience,
        input.locale,
        manifest.default_locale,
        manifest.name,
      ),
      purpose: localized(
        manifest.purpose,
        input.locale,
        manifest.default_locale,
        manifest.name,
      ),
      job: localized(
        manifest.job,
        input.locale,
        manifest.default_locale,
        manifest.name,
      ),
      required_input: localized(
        manifest.required_input,
        input.locale,
        manifest.default_locale,
        manifest.name,
      ),
      scope: manifest.scope,
      default_format: manifest.default_format,
      output_formats: [...manifest.output_formats],
      supported_locales: [...manifest.supported_locales],
      default_locale: manifest.default_locale,
      variables: manifest.variables,
      selection: input.engine.buildTemplateSelectionModel({
        manifest,
        doks: input.doks,
      }),
    } satisfies PublicationTemplateReadModel;
  }));
  return templates.sort(comparePublicationTemplates);
}

type LivedocEngineModule = typeof import('@doklo-beta/livedoc-engine');

async function loadEngine(): Promise<LivedocEngineModule> {
  return import(
    /* webpackIgnore: true */
    '@doklo-beta/livedoc-engine'
  );
}

async function readEvidence(
  root: string,
  publication: PublicationV1,
): Promise<{
  evidence?: PublicationRenderEvidence;
  error?: PublicationReadError;
}> {
  const relativePath = `.doklo/output/${publication.output_dir}/${EVIDENCE_FILE}`;
  let path = join(root, relativePath);
  try {
    path = await resolveContainedPath(root, relativePath, {
      rejectSymlinkLeaf: true,
    });
    const parsed = PublicationEvidenceSchema.parse(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    return { evidence: parsed as PublicationRenderEvidence };
  } catch (error) {
    if (isMissingError(error)) return {};
    return {
      error: {
        code: 'PUBLICATION_EVIDENCE_INVALID',
        path,
        message: errorMessage(error),
      },
    };
  }
}

async function readPublishRecord(
  root: string,
  publication: PublicationV1,
): Promise<{ record?: PublicationPublishRecord; blocked: boolean }> {
  if (!publication.destination) return { blocked: false };
  try {
    const destinationRoot = await resolveContainedPath(
      root,
      publication.destination.path,
      { rejectSymlinkLeaf: true },
    );
    const path = await resolveContainedPath(
      destinationRoot,
      PUBLISH_LEDGER_FILE,
      {
        rejectSymlinkLeaf: true,
      },
    );
    const parsed = PublishRecordSchema.parse(
      JSON.parse(await readFile(path, 'utf8')) as unknown,
    );
    for (const file of parsed.files) {
      const ownedPath = await resolveContainedPath(
        destinationRoot,
        file.path,
        {
          rejectSymlinkLeaf: true,
        },
      );
      const bytes = await readFile(ownedPath);
      if (createHash('sha256').update(bytes).digest('hex') !== file.sha256) {
        return { blocked: true };
      }
    }
    return {
      record: parsed,
      blocked: false,
    };
  } catch (error) {
    if (isMissingError(error)) return { blocked: false };
    return { blocked: true };
  }
}

const PublishRecordSchema = z.object({
  schema_version: z.literal(1),
  publication: z.string(),
  definition_sha256: z.string(),
  published_at: z.string(),
  files: z.array(z.object({
    path: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }).strict()),
}).passthrough();

const PublicationEvidenceSchema = z.object({
  schema_version: z.literal(1),
  command: z.literal('live-docs.publication.render'),
  publication: z.object({
    name: z.string(),
    definition_path: z.string(),
    definition_sha256: z.string(),
  }).passthrough(),
  template: z.object({
    name: z.string(),
    version: z.string(),
    stability: z.enum(['stable', 'experimental']),
  }).passthrough(),
  selected_dok_ids: z.array(z.string()),
  rendered_dok_ids: z.array(z.string()).optional(),
  dok_snapshots: z.array(z.object({
    dok_id: z.string(),
    name: z.string(),
    logic_hash: z.string().optional(),
    content_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
    status: z.enum([
      'draft',
      'review',
      'active',
      'planned',
      'deprecated',
      'archived',
    ]),
  }).passthrough()),
  render_input_sha256: z.string().regex(/^[a-f0-9]{64}$/u).optional(),
  plan: z.unknown(),
  outputs: z.array(z.object({
    path: z.string(),
    relative_path: z.string(),
    format: z.string(),
    bytes: z.number().nonnegative(),
    sha256: z.string(),
    dok_id: z.string().optional(),
  }).passthrough()),
  warnings: z.array(z.string()),
  manifest_path: z.string(),
}).passthrough();

function localized(
  values: Record<string, string> | undefined,
  locale: PublicationUiLocale,
  templateDefault: string,
  fallback: string,
): string {
  return values?.[locale]
    ?? values?.[templateDefault]
    ?? values?.en
    ?? fallback;
}

function isMissingError(error: unknown): boolean {
  return (
    error !== null
    && typeof error === 'object'
    && 'code' in error
    && (
      (error as { code?: unknown }).code === 'ENOENT'
      || (error as { code?: unknown }).code === 'ENOTDIR'
    )
  );
}

function isSyntaxOrValidationError(error: unknown): boolean {
  return error instanceof SyntaxError || error instanceof z.ZodError;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function byDokId(left: Dok, right: Dok): number {
  return compareText(left.dok_id, right.dok_id);
}

export function comparePublicationTemplates(
  left: PublicationTemplateReadModel,
  right: PublicationTemplateReadModel,
): number {
  const maturity = stabilityRank(left.stability) - stabilityRank(right.stability);
  return maturity || compareText(left.display_name, right.display_name);
}

function stabilityRank(stability: TemplateStability): number {
  return stability === 'stable' ? 0 : 1;
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
