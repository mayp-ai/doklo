import { z } from 'zod';
import {
  runPublicationCli,
  type PublicationCommandResult,
  type PublicationCliOperation,
} from './publication-cli';
import type {
  PublicationReadModelEntry,
  PublicationDokReadModel,
  PublicationTemplateReadModel,
  PublicationWorkspaceModel,
} from './publication-read-model';

const DokStatusSchema = z.enum([
  'draft',
  'review',
  'active',
  'planned',
  'deprecated',
  'archived',
]);

const PublicationNameSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  'publication name must be lowercase kebab-case and at most 64 characters',
);

const PublicationFormatSchema = z.enum([
  'markdown',
  'html',
  'yaml',
  'json',
  'text',
  'hwpx',
  'pptx',
  'xlsx',
]);

const PublicationDestinationSchema = z.strictObject({
  kind: z.literal('repo_path'),
  path: z.string().trim().min(1).refine(isSafeDestinationPath, {
    message:
      'destination path must be a workspace-relative POSIX path outside .doklo, without "..", absolute prefixes, or backslashes',
  }),
});

const FilterDraftSchema = z.object({
  mode: z.literal('filter'),
  include_tags: z.array(z.string().trim().min(1)).default([]),
  exclude_tags: z.array(z.string().trim().min(1)).default([]),
  statuses: z.array(DokStatusSchema).default([]),
}).strict().refine((selection) => (
  selection.include_tags.length > 0
  || selection.exclude_tags.length > 0
  || selection.statuses.length > 0
), {
  message: 'Filter selection requires at least one criterion.',
});

export const StudioPublicationCreateSchema = z.object({
  name: PublicationNameSchema,
  display_name: z.string().trim().min(1),
  template: z.string().trim().min(1),
  selection: z.discriminatedUnion('mode', [
    z.object({ mode: z.literal('all_eligible') }).strict(),
    z.object({
      mode: z.literal('explicit'),
      dok_ids: z.array(z.string().trim().min(1)).min(1),
    }).strict(),
    FilterDraftSchema,
  ]),
  update_mode: z.enum(['manual', 'review']),
  locale: z.string().trim().min(1),
  format: PublicationFormatSchema,
  vars: z.record(z.string(), z.string()).default({}),
  destination: z.string().trim().min(1).optional(),
}).strict();

export type StudioPublicationCreateInput = z.infer<
  typeof StudioPublicationCreateSchema
>;

export const StudioPublicationActionSchema = z.object({
  action: z.enum([
    'resnapshot',
    'render',
    'approve',
    'publish',
    'export',
  ]),
  fingerprint: z.string().min(1),
}).strict();

export type StudioPublicationActionInput = z.infer<
  typeof StudioPublicationActionSchema
>;

export class StudioPublicationInputError extends Error {
  readonly code = 'PUBLICATION_INPUT_INVALID';

  constructor(message: string) {
    super(message);
    this.name = 'StudioPublicationInputError';
  }
}

export class PublicationAlreadyRunningError extends Error {
  readonly code = 'PUBLICATION_ALREADY_RUNNING';

  constructor(readonly name: string) {
    super(`An official action is already running for Publication '${name}'.`);
    this.name = 'PublicationAlreadyRunningError';
  }
}

export class PublicationCommandFailedError extends Error {
  readonly code: string;

  constructor(readonly result: PublicationCommandResult) {
    const diagnostic = result.diagnostics[0];
    super(diagnostic?.message ?? `Publication command ended with ${result.status}.`);
    this.name = 'PublicationCommandFailedError';
    this.code = diagnostic?.code ?? 'PUBLICATION_COMMAND_FAILED';
  }
}

const activeRuns = new Set<string>();

export function acquirePublicationRun(
  root: string,
  name: string,
): { release(): void } {
  const key = `${root}\0${name}`;
  if (activeRuns.has(key)) throw new PublicationAlreadyRunningError(name);
  activeRuns.add(key);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      activeRuns.delete(key);
    },
  };
}

export async function runPublicationCreate(input: {
  root: string;
  cliBin: string;
  value: StudioPublicationCreateInput;
  model: PublicationWorkspaceModel;
  signal?: AbortSignal;
}): Promise<
  | {
      status: 'success';
      completed: ['create', 'render'];
      create: PublicationCommandResult;
      render: PublicationCommandResult;
    }
  | {
      status: 'partial';
      completed: ['create'];
      create: PublicationCommandResult;
      failed: 'render';
      code: string;
      error: string;
      diagnostics: PublicationCommandResult['diagnostics'];
    }
> {
  const lease = acquirePublicationRun(input.root, input.value.name);
  try {
    const template = input.model.templates.find(
      (entry) => entry.name === input.value.template,
    );
    if (!template) {
      throw new StudioPublicationInputError(
        `Unknown Template '${input.value.template}'.`,
      );
    }
    validateTemplateOptions(template, input.value);
    const selectionArgs = publicationSelectionArgs({
      template,
      doks: input.model.doks,
      selection: input.value.selection,
    });
    const createArgs = [
      '--template',
      template.name,
      ...selectionArgs,
      '--format',
      input.value.format,
      '--locale',
      input.value.locale,
      '--display-name',
      input.value.display_name,
      '--update-mode',
      input.value.update_mode,
      ...Object.entries(input.value.vars)
        .sort(([left], [right]) => compareText(left, right))
        .flatMap(([key, value]) => ['--var', `${key}=${value}`]),
      ...(input.value.destination
        ? ['--destination', input.value.destination]
        : []),
    ];
    const create = await runChecked({
      cliBin: input.cliBin,
      root: input.root,
      operation: {
        kind: 'create',
        name: input.value.name,
        args: createArgs,
      },
      signal: input.signal,
    });
    try {
      const render = await runChecked({
        cliBin: input.cliBin,
        root: input.root,
        operation: {
          kind: 'render',
          name: input.value.name,
          overwrite: false,
          dryRun: false,
        },
        signal: input.signal,
      });
      return {
        status: 'success',
        completed: ['create', 'render'],
        create,
        render,
      };
    } catch (error) {
      const commandError = error instanceof PublicationCommandFailedError
        ? error
        : undefined;
      return {
        status: 'partial',
        completed: ['create'],
        create,
        failed: 'render',
        code: commandError?.code ?? 'PUBLICATION_RENDER_FAILED',
        error: error instanceof Error ? error.message : String(error),
        diagnostics: commandError?.result.diagnostics ?? [],
      };
    }
  } finally {
    lease.release();
  }
}

export type PublicationActionOutcome =
  | {
      status: 'success';
      completed: string[];
      result: PublicationCommandResult;
    }
  | {
      status: 'partial';
      completed: string[];
      failed: string;
      code: string;
      error: string;
      diagnostics: PublicationCommandResult['diagnostics'];
    };

export async function runPublicationAction(input: {
  root: string;
  cliBin: string;
  name: string;
  value: StudioPublicationActionInput;
  loadModel: () => Promise<PublicationWorkspaceModel>;
  signal?: AbortSignal;
}): Promise<PublicationActionOutcome> {
  const lease = acquirePublicationRun(input.root, input.name);
  try {
    const model = await input.loadModel();
    const entry = model.publications.find(
      (candidate) => candidate.publication.name === input.name,
    );
    if (!entry) {
      throw new StudioPublicationInputError(
        `Publication '${input.name}' was not found.`,
      );
    }
    if (entry.status.input_fingerprint !== input.value.fingerprint) {
      throw new PublicationFingerprintStaleError(
        input.value.fingerprint,
        entry.status.input_fingerprint,
      );
    }
    return await executePublicationAction({
      ...input,
      entry,
    });
  } finally {
    lease.release();
  }
}

export class PublicationFingerprintStaleError extends Error {
  readonly code = 'PUBLICATION_FINGERPRINT_STALE';

  constructor(
    readonly requested: string,
    readonly current: string,
  ) {
    super('The Dok Hub changed. Refresh before running this action.');
    this.name = 'PublicationFingerprintStaleError';
  }
}

async function executePublicationAction(input: {
  root: string;
  cliBin: string;
  name: string;
  value: StudioPublicationActionInput;
  entry: PublicationReadModelEntry;
  signal?: AbortSignal;
}): Promise<PublicationActionOutcome> {
  const completed: string[] = [];
  if (input.value.action === 'export') {
    const result = await runChecked({
      cliBin: input.cliBin,
      root: input.root,
      operation: { kind: 'export', name: input.name },
      signal: input.signal,
    });
    return { status: 'success', completed: ['export'], result };
  }

  if (input.value.action === 'resnapshot') {
    const result = await runChecked({
      cliBin: input.cliBin,
      root: input.root,
      operation: overwriteOperation(input.entry),
      signal: input.signal,
    });
    return { status: 'success', completed: ['resnapshot'], result };
  }

  if (input.value.action === 'render') {
    if (input.entry.publication.selection.mode !== 'explicit') {
      const refreshFailure = await tryActionStep({
        input,
        operation: overwriteOperation(input.entry),
        completed,
        label: 'resnapshot',
      });
      if (refreshFailure) return refreshFailure;
    }
    const renderFailure = await tryActionStep({
      input,
      operation: {
        kind: 'render',
        name: input.name,
        overwrite: true,
        dryRun: false,
      },
      completed,
      label: 'render',
    });
    if (renderFailure) return renderFailure;
    return {
      status: 'success',
      completed,
      result: successSummary('render', completed),
    };
  }

  if (input.value.action === 'publish') {
    const dryRun = await runChecked({
      cliBin: input.cliBin,
      root: input.root,
      operation: {
        kind: 'publish',
        name: input.name,
        dryRun: true,
      },
      signal: input.signal,
    });
    assertPublishPlanUnblocked(dryRun);
    completed.push('publish-dry-run');
    const result = await runChecked({
      cliBin: input.cliBin,
      root: input.root,
      operation: {
        kind: 'publish',
        name: input.name,
        dryRun: false,
      },
      signal: input.signal,
    });
    return {
      status: 'success',
      completed: [...completed, 'publish'],
      result,
    };
  }

  if (input.entry.publication.selection.mode !== 'explicit') {
    const failure = await tryActionStep({
      input,
      operation: overwriteOperation(input.entry),
      completed,
      label: 'resnapshot',
    });
    if (failure) return failure;
  }
  const renderFailure = await tryActionStep({
    input,
    operation: {
      kind: 'render',
      name: input.name,
      overwrite: true,
      dryRun: false,
    },
    completed,
    label: 'render',
  });
  if (renderFailure) return renderFailure;

  if (!input.entry.publication.destination) {
    return {
      status: 'success',
      completed,
      result: successSummary('approve', completed),
    };
  }
  const dryRunFailure = await tryActionStep({
    input,
    operation: {
      kind: 'publish',
      name: input.name,
      dryRun: true,
    },
    completed,
    label: 'publish-dry-run',
    validate: assertPublishPlanUnblocked,
  });
  if (dryRunFailure) return dryRunFailure;
  const publishFailure = await tryActionStep({
    input,
    operation: {
      kind: 'publish',
      name: input.name,
      dryRun: false,
    },
    completed,
    label: 'publish',
  });
  if (publishFailure) return publishFailure;
  return {
    status: 'success',
    completed,
    result: successSummary('approve', completed),
  };
}

async function tryActionStep(input: {
  input: {
    root: string;
    cliBin: string;
    signal?: AbortSignal;
  };
  operation: PublicationCliOperation;
  completed: string[];
  label: string;
  validate?: (result: PublicationCommandResult) => void;
}): Promise<Extract<PublicationActionOutcome, { status: 'partial' }> | null> {
  try {
    const result = await runChecked({
      cliBin: input.input.cliBin,
      root: input.input.root,
      operation: input.operation,
      signal: input.input.signal,
    });
    input.validate?.(result);
    input.completed.push(input.label);
    return null;
  } catch (error) {
    if (
      input.completed.length === 0
      || !(error instanceof PublicationCommandFailedError)
    ) {
      throw error;
    }
    return {
      status: 'partial',
      completed: [...input.completed],
      failed: input.label,
      code: error.code,
      error: error.message,
      diagnostics: error.result.diagnostics,
    };
  }
}

async function runChecked(input: {
  cliBin: string;
  root: string;
  operation: PublicationCliOperation;
  signal?: AbortSignal;
}): Promise<PublicationCommandResult> {
  const result = await runPublicationCli(input);
  if (result.status !== 'success') {
    throw new PublicationCommandFailedError(result);
  }
  return result;
}

function overwriteOperation(
  entry: PublicationReadModelEntry,
): Extract<PublicationCliOperation, { kind: 'create' }> {
  const publication = entry.publication;
  const selectionArgs = publication.selection.mode === 'all'
    ? ['--all']
    : publication.selection.mode === 'explicit'
      ? publication.selection.dok_ids.flatMap((dokId) => [
          '--dok-id',
          dokId,
        ])
      : [
          ...(publication.selection.include_tags ?? []).flatMap((tag) => [
            '--include-tag',
            tag,
          ]),
          ...(publication.selection.exclude_tags ?? []).flatMap((tag) => [
            '--exclude-tag',
            tag,
          ]),
          ...(publication.selection.statuses ?? []).flatMap((status) => [
            '--status',
            status,
          ]),
        ];
  return {
    kind: 'create',
    name: publication.name,
    args: [
      '--template',
      publication.template,
      ...selectionArgs,
      '--format',
      publication.format,
      '--locale',
      publication.locale,
      '--display-name',
      publication.display_name,
      '--output-dir',
      publication.output_dir,
      '--update-mode',
      entry.effective_update_mode,
      ...Object.entries(publication.vars)
        .sort(([left], [right]) => compareText(left, right))
        .flatMap(([key, value]) => ['--var', `${key}=${value}`]),
      ...(publication.destination
        ? ['--destination', publication.destination.path]
        : []),
      '--overwrite',
    ],
  };
}

function assertPublishPlanUnblocked(
  result: PublicationCommandResult,
): void {
  const data = isRecord(result.data) ? result.data : undefined;
  const plan = data && isRecord(data.plan) ? data.plan : undefined;
  const blocked = plan?.blocked;
  if (!Array.isArray(blocked) || blocked.length === 0) return;
  const failed: PublicationCommandResult = {
    schema_version: 1,
    command: 'live-docs.publication.publish',
    status: 'failed',
    data: null,
    diagnostics: [{
      code: 'PUBLICATION_PUBLISH_BLOCKED',
      message: `Destination contains files Doklo cannot safely replace: ${blocked.join(', ')}.`,
    }],
    stderr_tail: result.stderr_tail,
  };
  throw new PublicationCommandFailedError(failed);
}

function successSummary(
  action: string,
  completed: string[],
): PublicationCommandResult {
  return {
    schema_version: 1,
    command: `studio.publication.${action}`,
    status: 'success',
    data: { completed: [...completed] },
    diagnostics: [],
    stderr_tail: '',
  };
}

function validateTemplateOptions(
  template: PublicationTemplateReadModel,
  input: StudioPublicationCreateInput,
): void {
  if (!template.supported_locales.includes(input.locale)) {
    throw new StudioPublicationInputError(
      `Template '${template.name}' does not support locale '${input.locale}'.`,
    );
  }
  if (!template.output_formats.includes(input.format)) {
    throw new StudioPublicationInputError(
      `Template '${template.name}' does not support format '${input.format}'.`,
    );
  }
  if (input.destination) {
    PublicationDestinationSchema.parse({
      kind: 'repo_path',
      path: input.destination,
    });
  }
  const unknown = Object.keys(input.vars)
    .filter((key) => template.variables[key] === undefined)
    .sort(compareText);
  if (unknown.length > 0) {
    throw new StudioPublicationInputError(
      `Unknown Template variables: ${unknown.join(', ')}.`,
    );
  }
  const missing = Object.entries(template.variables)
    .filter(([name, definition]) => (
      definition.required
      && definition.default === undefined
      && !input.vars[name]
    ))
    .map(([name]) => name)
    .sort(compareText);
  if (missing.length > 0) {
    throw new StudioPublicationInputError(
      `Required Template variables are missing: ${missing.join(', ')}.`,
    );
  }
}

function publicationSelectionArgs(input: {
  template: PublicationTemplateReadModel;
  doks: PublicationDokReadModel[];
  selection: StudioPublicationCreateInput['selection'];
}): string[] {
  const eligible = new Set(input.template.selection.eligible_dok_ids);
  let selected: string[];
  if (input.selection.mode === 'all_eligible') {
    selected = [...eligible].sort(compareText);
  } else if (input.selection.mode === 'explicit') {
    selected = [...input.selection.dok_ids].sort(compareText);
  } else {
    const filter = input.selection;
    selected = input.doks
      .filter((dok) => eligible.has(dok.dok_id))
      .filter((dok) => matchesFilter(dok, filter))
      .map((dok) => dok.dok_id)
      .sort(compareText);
  }
  if (selected.length === 0) {
    throw new StudioPublicationInputError(
      'Publication selection resolved to 0 eligible Doks.',
    );
  }
  const invalid = selected.filter((dokId) => !eligible.has(dokId));
  if (invalid.length > 0) {
    throw new StudioPublicationInputError(
      `Doks are not eligible for this Template: ${invalid.join(', ')}.`,
    );
  }

  if (input.selection.mode === 'explicit') {
    return selected.flatMap((dokId) => ['--dok-id', dokId]);
  }

  if (input.selection.mode === 'all_eligible') {
    return ['--all'];
  }

  return [
    ...input.selection.include_tags.flatMap((tag) => [
      '--include-tag',
      tag,
    ]),
    ...input.selection.exclude_tags.flatMap((tag) => [
      '--exclude-tag',
      tag,
    ]),
    ...input.selection.statuses.flatMap((status) => [
      '--status',
      status,
    ]),
  ];
}

function matchesFilter(
  dok: PublicationDokReadModel,
  selection: Extract<
    StudioPublicationCreateInput['selection'],
    { mode: 'filter' }
  >,
): boolean {
  const tags = new Set(dok.tags);
  return selection.include_tags.every((tag) => tags.has(tag))
    && !selection.exclude_tags.some((tag) => tags.has(tag))
    && (
      selection.statuses.length === 0
      || selection.statuses.includes(dok.status)
    );
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isSafeDestinationPath(value: string): boolean {
  if (
    value.startsWith('/')
    || /^[A-Za-z]:/u.test(value)
    || value.includes('\\')
  ) {
    return false;
  }
  const segments = value.split('/');
  return segments.length > 0
    && segments[0] !== '.doklo'
    && segments.every(
      (segment) => segment !== '' && segment !== '.' && segment !== '..',
    );
}

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}
