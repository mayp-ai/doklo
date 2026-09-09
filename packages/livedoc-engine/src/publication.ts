import { createHash } from 'node:crypto';
import { isAbsolute, posix, win32 } from 'node:path';
import { DokIdSchema, DokStatusSchema } from '@doklo-beta/core';
import { z } from 'zod';

export const PublicationNameSchema = z.string().regex(
  /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/,
  'publication name must be lowercase kebab-case and at most 64 characters',
);

export const PublicationFormatSchema = z.enum([
  'markdown',
  'html',
  'yaml',
  'json',
  'text',
  'hwpx',
  'pptx',
  'xlsx',
]);

export const PublicationUpdateModeSchema = z.enum(['manual', 'review']);

const ExplicitSelectionSchema = z.object({
  mode: z.literal('explicit'),
  dok_ids: z.array(DokIdSchema).min(1),
}).strict().superRefine((selection, context) => {
  addDuplicateIssues(selection.dok_ids, context, ['dok_ids']);
});

const FilterSelectionSchema = z.object({
  mode: z.literal('filter'),
  include_tags: z.array(z.string().min(1)).optional(),
  exclude_tags: z.array(z.string().min(1)).optional(),
  statuses: z.array(DokStatusSchema).optional(),
}).strict().superRefine((selection, context) => {
  addDuplicateIssues(selection.include_tags ?? [], context, ['include_tags']);
  addDuplicateIssues(selection.exclude_tags ?? [], context, ['exclude_tags']);
  addDuplicateIssues(selection.statuses ?? [], context, ['statuses']);
  if (
    (selection.include_tags?.length ?? 0) === 0
    && (selection.exclude_tags?.length ?? 0) === 0
    && (selection.statuses?.length ?? 0) === 0
  ) {
    context.addIssue({
      code: 'custom',
      message: 'filter selection requires at least one criterion',
    });
  }
});

export const PublicationSelectionSchema = z.discriminatedUnion('mode', [
  z.object({ mode: z.literal('all') }).strict(),
  ExplicitSelectionSchema,
  FilterSelectionSchema,
]);

export const PublicationDestinationSchema = z.strictObject({
  kind: z.literal('repo_path'),
  path: z.string().trim().min(1).refine(isSafeDestinationPath, {
    message:
      'destination path must be a workspace-relative POSIX path outside .doklo, without "..", absolute prefixes, or backslashes',
  }),
});

export const PublicationSchema = z.object({
  schema_version: z.literal(1),
  name: PublicationNameSchema,
  display_name: z.string().trim().min(1),
  template: z.string().trim().min(1),
  selection: PublicationSelectionSchema,
  selected_dok_ids: z.array(DokIdSchema).min(1),
  format: PublicationFormatSchema,
  locale: z.string().trim().min(1),
  vars: z.record(z.string(), z.string()),
  output_dir: z.string().min(1).refine(isSafeOutputDirectory, {
    message: 'output_dir must be a relative path contained under .doklo/output',
  }),
  destination: PublicationDestinationSchema.optional(),
  update_mode: PublicationUpdateModeSchema.optional(),
  created_at: z.string().datetime({ offset: true }),
}).strict().superRefine((publication, context) => {
  addDuplicateIssues(publication.selected_dok_ids, context, ['selected_dok_ids']);
});

export type PublicationSelection = z.infer<typeof PublicationSelectionSchema>;
export type PublicationFormat = z.infer<typeof PublicationFormatSchema>;
export type PublicationUpdateMode = z.infer<
  typeof PublicationUpdateModeSchema
>;
export type PublicationDestination = z.infer<
  typeof PublicationDestinationSchema
>;
export type PublicationV1 = z.infer<typeof PublicationSchema>;

export function parsePublication(value: unknown): PublicationV1 {
  return PublicationSchema.parse(value);
}

export function serializePublication(value: PublicationV1): string {
  return `${stableStringify(parsePublication(value))}\n`;
}

export function publicationDigest(publication: PublicationV1): string {
  return createHash('sha256')
    .update(serializePublication(publication), 'utf8')
    .digest('hex');
}

export function effectivePublicationUpdateMode(
  publication: Pick<PublicationV1, 'update_mode'>,
): PublicationUpdateMode {
  return publication.update_mode ?? 'manual';
}

function addDuplicateIssues(
  values: readonly string[],
  context: z.RefinementCtx,
  path: PropertyKey[],
): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) {
      context.addIssue({
        code: 'custom',
        message: `duplicate value: ${value}`,
        path,
      });
    }
    seen.add(value);
  }
}

function isSafeOutputDirectory(value: string): boolean {
  if (
    value.includes('\0')
    || value.includes('\\')
    || value.trim() !== value
    || isAbsolute(value)
    || win32.isAbsolute(value)
    || posix.normalize(value) !== value
  ) {
    return false;
  }
  return value.split('/').every(
    (segment) => segment !== '' && segment !== '.' && segment !== '..',
  );
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
  if (
    segments.some(
      (segment) => segment === '' || segment === '.' || segment === '..',
    )
  ) {
    return false;
  }
  return segments[0] !== '.doklo';
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    const serialized = JSON.stringify(value);
    if (serialized === undefined) throw new TypeError('Publication contains a non-JSON value');
    return serialized;
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableStringify(record[key])}`
  )).join(',')}}`;
}
