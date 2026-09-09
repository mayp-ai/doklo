import { createHash } from 'node:crypto';
import { loadHubModel, resolveContainedPath } from '@doklo-beta/core';
import {
  buildPublicationArchive,
  PublicationFormatSchema,
  PublicationArchiveError,
  PublicationSelectionSchema,
  PublicationUpdateModeSchema,
  buildTemplateSelectionModel,
  coerceTemplateVariables,
  renderPublication,
  resolveTemplateSelection,
  resolveTemplate,
  writeArtifactAtomic,
  type PublicationRenderEvidence,
  type PublicationSelection,
  type PublicationV1,
} from '@doklo-beta/livedoc-engine';
import type { Command } from 'commander';
import { readFile, realpath } from 'node:fs/promises';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { CommandContractError, recordCommandResult } from '../lib/command-result.js';
import {
  createPublication,
  listPublications,
  loadPublication,
  loadPublicationDefinition,
  PublicationNotFoundError,
} from '../lib/publication-store.js';
import {
  stabilityDiagnostics,
  type VisibleTemplateStability,
} from '../lib/livedoc-stability.js';
import {
  executePublish,
  planPublish,
  PublishError,
  type PublishPlan,
} from '../lib/publication-publish.js';

type CreateOptions = {
  template: string;
  all?: boolean;
  dokId: string[];
  includeTag: string[];
  excludeTag: string[];
  status: string[];
  var: string[];
  format: string;
  locale?: string;
  displayName?: string;
  outputDir?: string;
  destination?: string;
  updateMode: string;
  overwrite?: boolean;
  json?: boolean;
  root?: string;
};

type RootOptions = { root?: string; json?: boolean };
type RenderOptions = RootOptions & {
  overwrite?: boolean;
  dryRun?: boolean;
  progressJson?: boolean;
};
type PublishOptions = RootOptions & { dryRun?: boolean };
type ExportOptions = RootOptions & { zipPath?: string };

export function registerPublicationCommands(parent: Command): void {
  const owner = commandRoot(parent);
  const publication = parent
    .command('publication')
    .description('Manage saved Live Docs publications');

  publication
    .command('create <name>')
    .description('Create or explicitly overwrite a saved Publication')
    .requiredOption('--template <name>', 'template name')
    .option('--all', 'snapshot every current Dok')
    .option('--dok-id <id>', 'snapshot an explicit Dok (repeatable)', collect, [])
    .option('--include-tag <tag>', 'require a Dok tag (repeatable)', collect, [])
    .option('--exclude-tag <tag>', 'exclude a Dok tag (repeatable)', collect, [])
    .option('--status <status>', 'allow a Dok status (repeatable)', collect, [])
    .option('--var <key=value>', 'template variable (repeatable)', collect, [])
    .requiredOption('--format <format>', 'one declared template output format')
    .option('--locale <code>', 'output locale')
    .option('--display-name <name>', 'human-readable Publication name')
    .option('--output-dir <path>', 'directory beneath .doklo/output')
    .option(
      '--destination <path>',
      'workspace-relative folder to publish rendered outputs into',
    )
    .option(
      '--update-mode <mode>',
      'local update mode: manual or review',
      'manual',
    )
    .option('--overwrite', 'replace an existing definition and preserve created_at')
    .option('--json', 'emit one machine result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (name: string, options: CreateOptions) => {
      const workspaceRoot = resolve(options.root ?? process.cwd());
      const selection = selectionFromOptions(options);
      const hub = await loadHubModel(workspaceRoot);
      const template = await resolveTemplate(options.template, { workspaceRoot });
      const selectedDokIds = resolveTemplateSelection(
        buildTemplateSelectionModel({
          manifest: template.parsed.manifest,
          doks: hub.doks,
        }),
        selection,
        hub.doks,
      );
      const format = PublicationFormatSchema.parse(options.format);
      if (!template.parsed.manifest.output_formats.includes(format)) {
        throw codedError(
          'OUTPUT_FORMAT_REJECTED',
          `Template '${options.template}' does not declare output format '${format}'`,
        );
      }
      const locale = options.locale ?? template.parsed.manifest.default_locale;
      if (!template.parsed.manifest.supported_locales.includes(locale)) {
        throw codedError(
          'PUBLICATION_LOCALE_UNSUPPORTED',
          `Template '${options.template}' does not support locale '${locale}'`,
        );
      }
      const vars = parseVars(options.var);
      coerceTemplateVariables(template.parsed.manifest, vars);
      const updateMode = PublicationUpdateModeSchema.parse(options.updateMode);

      let createdAt = new Date().toISOString();
      let overwriteExisting = false;
      if (options.overwrite) {
        try {
          createdAt = (await loadPublication(workspaceRoot, name)).created_at;
          overwriteExisting = true;
        } catch (error) {
          if (!(error instanceof PublicationNotFoundError)) throw error;
        }
      }
      const value: PublicationV1 = {
        schema_version: 1,
        name,
        display_name: options.displayName ?? name,
        template: options.template,
        selection,
        selected_dok_ids: selectedDokIds,
        format,
        locale,
        vars,
        output_dir: options.outputDir ?? `${options.template}/${name}`,
        ...(options.destination
          ? {
              destination: {
                kind: 'repo_path' as const,
                path: options.destination,
              },
            }
          : {}),
        ...(updateMode === 'review' ? { update_mode: updateMode } : {}),
        created_at: createdAt,
      };
      await createPublication(workspaceRoot, value, { overwrite: overwriteExisting });
      const definition = await loadPublicationDefinition(workspaceRoot, name);
      const templateStability = template.parsed.manifest.stability;
      const result = {
        schema_version: 1 as const,
        command: 'live-docs.publication.create',
        status: 'success' as const,
        data: { ...definition, template_stability: templateStability },
        diagnostics: stabilityDiagnostics(options.template, templateStability),
      };
      if (!options.json) {
        process.stdout.write(
          `Created Publication ${name} (${selectedDokIds.length} Doks, ${format}) [${templateStability}]\n`,
        );
      }
      recordCommandResult(owner, result);
    });

  publication
    .command('list')
    .description('List saved Publications')
    .option('--json', 'emit one machine result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (options: RootOptions) => {
      const workspaceRoot = resolve(options.root ?? process.cwd());
      const values = await listPublications(workspaceRoot);
      const visibleValues = await Promise.all(values.map(async (value) => {
        const status = await publicationTemplateStatus(workspaceRoot, value.template);
        return { ...value, template_stability: status.stability, diagnostics: status.diagnostics };
      }));
      if (!options.json) {
        if (visibleValues.length === 0) process.stdout.write('No saved Publications.\n');
        else for (const value of visibleValues) {
          process.stdout.write(
            `${value.name}\t${value.template}\t[${value.template_stability}]\t${value.format}\t${value.selected_dok_ids.length} Doks\n`,
          );
        }
      }
      recordCommandResult(owner, {
        schema_version: 1,
        command: 'live-docs.publication.list',
        status: 'success',
        data: visibleValues.map(({ diagnostics: _diagnostics, ...value }) => value),
        diagnostics: visibleValues.flatMap((value) => value.diagnostics),
      });
    });

  publication
    .command('inspect <name>')
    .description('Inspect a saved Publication')
    .option('--json', 'emit one machine result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (name: string, options: RootOptions) => {
      const workspaceRoot = resolve(options.root ?? process.cwd());
      const definition = await loadPublicationDefinition(
        workspaceRoot,
        name,
      );
      const templateStatus = await publicationTemplateStatus(
        workspaceRoot,
        definition.publication.template,
      );
      const visibleDefinition = {
        ...definition,
        template_stability: templateStatus.stability,
      };
      if (!options.json) {
        process.stdout.write(`Template stability: ${templateStatus.stability}\n`);
        process.stdout.write(`${JSON.stringify(definition, null, 2)}\n`);
      }
      recordCommandResult(owner, {
        schema_version: 1,
        command: 'live-docs.publication.inspect',
        status: 'success',
        data: visibleDefinition,
        diagnostics: templateStatus.diagnostics,
      });
    });

  publication
    .command('render <name>')
    .description('Render a saved Publication from its persisted Dok snapshot')
    .option('--overwrite', 'replace every existing planned output')
    .option('--dry-run', 'print the complete output plan without writing')
    .option('--progress-json', 'emit render progress as JSONL on stderr')
    .option('--json', 'emit one machine result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (name: string, options: RenderOptions) => {
      const workspaceRoot = resolve(options.root ?? process.cwd());
      const definition = await loadPublicationDefinition(workspaceRoot, name);
      const templateStatus = await publicationTemplateStatus(
        workspaceRoot,
        definition.publication.template,
      );
      const controller = new AbortController();
      const interrupt = (): void => controller.abort(new Error('SIGINT'));
      process.once('SIGINT', interrupt);
      let result;
      try {
        result = await renderPublication({
          workspaceRoot,
          publication: definition.publication,
          definition: { path: definition.path, sha256: definition.sha256 },
          overwrite: options.overwrite === true,
          dryRun: options.dryRun === true,
          signal: controller.signal,
          ...(options.progressJson ? {
            onPlan(plan) {
              writeProgress({ stage: 'plan', publication: name, outputs: plan.outputs });
            },
            onArtifactWritten(output) {
              writeProgress({ stage: 'artifact', publication: name, output });
            },
          } : {}),
        });
      } finally {
        process.removeListener('SIGINT', interrupt);
      }
      if (result.status === 'cancelled') {
        throw new CommandContractError(result, 130);
      }
      if (!options.json && !options.progressJson && result.status === 'success') {
        process.stdout.write(`[${templateStatus.stability}] ${definition.publication.template}\n`);
        if (options.dryRun) process.stdout.write(`${JSON.stringify(result.data!.plan, null, 2)}\n`);
        else process.stdout.write(
          `Rendered Publication ${name} → ${result.data!.manifest_path}\n`,
        );
      }
      recordCommandResult(owner, {
        ...result,
        diagnostics: [...result.diagnostics, ...templateStatus.diagnostics],
      });
    });

  publication
    .command('publish <name>')
    .description(
      'Copy the last rendered outputs to the publication destination',
    )
    .option('--dry-run', 'show the publish plan without writing')
    .option('--json', 'emit one machine result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (name: string, options: PublishOptions) => {
      const workspaceRoot = resolve(options.root ?? process.cwd());
      const definition = await loadPublicationDefinition(
        workspaceRoot,
        name,
      );
      if (!definition.publication.destination) {
        throw codedError(
          'PUBLICATION_DESTINATION_MISSING',
          'This Publication has no destination. Re-create it with --destination <path>.',
        );
      }
      const evidence = await loadPublicationEvidence(
        workspaceRoot,
        definition.publication.output_dir,
      );
      if (
        evidence.publication.name !== definition.publication.name
        || evidence.publication.definition_sha256 !== definition.sha256
      ) {
        throw codedError(
          'PUBLICATION_EVIDENCE_STALE',
          'Publication definition changed after the last render. Render this Publication again before publishing.',
        );
      }

      let plan: PublishPlan;
      try {
        plan = await planPublish({
          workspaceRoot,
          publication: definition.publication,
          evidence,
        });
      } catch (error) {
        if (error instanceof PublishError) {
          throw codedError(error.code, error.message);
        }
        throw error;
      }
      const visiblePlan = {
        destination_path: plan.destinationPath,
        entries: plan.entries.map(({ path, action }) => ({ path, action })),
        blocked: plan.blocked,
      };

      if (options.dryRun) {
        if (!options.json) {
          process.stdout.write(`${JSON.stringify(visiblePlan, null, 2)}\n`);
        }
        recordCommandResult(owner, {
          schema_version: 1,
          command: 'live-docs.publication.publish',
          status: 'success',
          data: {
            destination: plan.destinationPath,
            plan: visiblePlan,
          },
          diagnostics: [],
        });
        return;
      }

      let counts: Awaited<ReturnType<typeof executePublish>>;
      try {
        counts = await executePublish({
          workspaceRoot,
          publication: definition.publication,
          definitionSha256: definition.sha256,
          plan,
        });
      } catch (error) {
        if (error instanceof PublishError) {
          throw codedError(error.code, error.message);
        }
        throw error;
      }
      if (!options.json) {
        process.stdout.write(
          `Published ${name} → ${plan.destinationPath} (${counts.written} written, ${counts.deleted} deleted, ${counts.unchanged} unchanged)\n`,
        );
      }
      recordCommandResult(owner, {
        schema_version: 1,
        command: 'live-docs.publication.publish',
        status: 'success',
        data: {
          destination: plan.destinationPath,
          ...counts,
          plan: visiblePlan,
        },
        diagnostics: [],
      });
    });

  publication
    .command('export <name>')
    .description(
      'Package the last rendered outputs and evidence as a deterministic zip',
    )
    .option('--zip-path <path>', 'workspace-relative output zip path')
    .option('--json', 'emit one machine result envelope')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .action(async (name: string, options: ExportOptions) => {
      const workspaceRoot = await realpath(
        resolve(options.root ?? process.cwd()),
      );
      const definition = await loadPublicationDefinition(
        workspaceRoot,
        name,
      );
      const evidence = await loadPublicationEvidence(
        workspaceRoot,
        definition.publication.output_dir,
      );
      const requestedZipPath =
        options.zipPath
        ?? `.doklo/output/${definition.publication.output_dir}.zip`;
      let zipPath: string;
      try {
        zipPath = await resolveContainedPath(
          workspaceRoot,
          requestedZipPath,
          { allowMissingLeaf: true, rejectSymlinkLeaf: true },
        );
      } catch {
        throw codedError(
          'PUBLICATION_EXPORT_PATH_INVALID',
          `Zip path must stay inside the workspace: ${requestedZipPath}`,
        );
      }
      const publicationOutputPath = resolve(
        workspaceRoot,
        '.doklo/output',
        definition.publication.output_dir,
      );
      if (isContainedPath(publicationOutputPath, zipPath)) {
        throw codedError(
          'PUBLICATION_EXPORT_PATH_INVALID',
          'Zip path must be outside the Publication output directory so later renders remain clean.',
        );
      }

      let archive: Buffer;
      try {
        archive = await buildPublicationArchive({
          workspaceRoot,
          publication: definition.publication,
          evidence,
        });
      } catch (error) {
        if (error instanceof PublicationArchiveError) {
          throw codedError(error.code, error.message);
        }
        throw error;
      }
      await writeArtifactAtomic(
        workspaceRoot,
        relative(workspaceRoot, zipPath),
        archive,
        { overwrite: true },
      );
      const digest = createHash('sha256').update(archive).digest('hex');
      if (!options.json) {
        process.stdout.write(
          `Exported ${name} → ${zipPath} (${archive.byteLength} bytes)\n`,
        );
      }
      recordCommandResult(owner, {
        schema_version: 1,
        command: 'live-docs.publication.export',
        status: 'success',
        data: {
          zip_path: zipPath,
          bytes: archive.byteLength,
          sha256: digest,
        },
        diagnostics: [],
      });
    });
}

async function loadPublicationEvidence(
  workspaceRoot: string,
  outputDir: string,
): Promise<PublicationRenderEvidence> {
  const relativePath = `.doklo/output/${outputDir}/publication-evidence.json`;
  let canonicalPath: string;
  try {
    canonicalPath = await resolveContainedPath(workspaceRoot, relativePath, {
      rejectSymlinkLeaf: true,
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw codedError(
        'PUBLICATION_EVIDENCE_MISSING',
        'Render this Publication before publishing or exporting.',
      );
    }
    throw error;
  }
  let raw: string;
  try {
    raw = await readFile(canonicalPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw codedError(
        'PUBLICATION_EVIDENCE_MISSING',
        'Render this Publication before publishing or exporting.',
      );
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Publication evidence is not valid JSON: ${canonicalPath}`,
    );
  }
  if (!isPublicationEvidence(parsed)) {
    throw codedError(
      'PUBLICATION_EVIDENCE_INVALID',
      `Publication evidence has an invalid shape: ${canonicalPath}`,
    );
  }
  return parsed;
}

function isPublicationEvidence(
  value: unknown,
): value is PublicationRenderEvidence {
  if (!value || typeof value !== 'object') return false;
  const evidence = value as Record<string, unknown>;
  const publication = evidence.publication as
    | Record<string, unknown>
    | undefined;
  const template = evidence.template as Record<string, unknown> | undefined;
  return evidence.schema_version === 1
    && evidence.command === 'live-docs.publication.render'
    && typeof publication?.name === 'string'
    && typeof publication.definition_sha256 === 'string'
    && typeof template?.name === 'string'
    && (
      evidence.rendered_dok_ids === undefined
      || (
        Array.isArray(evidence.rendered_dok_ids)
        && evidence.rendered_dok_ids.every((dokId) => typeof dokId === 'string')
      )
    )
    && Array.isArray(evidence.outputs)
    && evidence.outputs.every((output) => {
      if (!output || typeof output !== 'object') return false;
      const item = output as Record<string, unknown>;
      return typeof item.relative_path === 'string'
        && typeof item.format === 'string'
        && typeof item.bytes === 'number'
        && typeof item.sha256 === 'string';
    });
}

function isContainedPath(root: string, candidate: string): boolean {
  const fromRoot = relative(root, candidate);
  return fromRoot === ''
    || (
      fromRoot !== '..'
      && !fromRoot.startsWith(`..${sep}`)
      && !isAbsolute(fromRoot)
    );
}

async function publicationTemplateStatus(
  workspaceRoot: string,
  template: string,
): Promise<{
  stability: VisibleTemplateStability;
  diagnostics: ReturnType<typeof stabilityDiagnostics>;
}> {
  try {
    const resolved = await resolveTemplate(template, { workspaceRoot });
    const stability = resolved.parsed.manifest.stability;
    return { stability, diagnostics: stabilityDiagnostics(template, stability) };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    return {
      stability: 'unavailable',
      diagnostics: stabilityDiagnostics(template, 'unavailable', detail),
    };
  }
}

function writeProgress(value: Record<string, unknown>): void {
  process.stderr.write(`${JSON.stringify(value)}\n`);
}

function selectionFromOptions(options: CreateOptions): PublicationSelection {
  const filterSelected = options.includeTag.length > 0
    || options.excludeTag.length > 0
    || options.status.length > 0;
  const categories = Number(options.all === true)
    + Number(options.dokId.length > 0)
    + Number(filterSelected);
  if (categories !== 1) {
    throw codedError(
      'PUBLICATION_SELECTION_FLAGS',
      'Choose exactly one selection mode: --all, --dok-id, or filter flags',
    );
  }
  if (options.all) return { mode: 'all' };
  if (options.dokId.length > 0) {
    return PublicationSelectionSchema.parse({ mode: 'explicit', dok_ids: options.dokId });
  }
  return PublicationSelectionSchema.parse({
    mode: 'filter',
    ...(options.includeTag.length > 0 ? { include_tags: options.includeTag } : {}),
    ...(options.excludeTag.length > 0 ? { exclude_tags: options.excludeTag } : {}),
    ...(options.status.length > 0 ? { statuses: options.status } : {}),
  });
}

function parseVars(pairs: string[]): Record<string, string> {
  const values: Record<string, string> = {};
  for (const pair of pairs) {
    const separator = pair.indexOf('=');
    if (separator < 1) {
      throw codedError('PUBLICATION_VARIABLE_INVALID', `Expected --var key=value, received '${pair}'`);
    }
    values[pair.slice(0, separator)] = pair.slice(separator + 1);
  }
  return values;
}

function collect(value: string, previous: string[]): string[] {
  return [...previous, value];
}

function commandRoot(command: Command): Command {
  let current = command;
  while (current.parent) current = current.parent;
  return current;
}

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}
