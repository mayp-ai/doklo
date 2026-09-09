import { z } from 'zod';
import { SourceAnchorSchema } from './code-anchor.js';
import { PlatformSchema, type Platform } from './dok.js';
import { DokIdSchema, ServiceIdSchema } from './ids.js';
import {
  IaFileV1Schema,
  IaLabelV1Schema,
  type IaFileV1,
  type IaLabelV1,
} from './ia-v1.js';

// IA v2 — the "Product Surface Model".
//
// A tree describes one way of looking at the product surface:
//   route_hierarchy  the URL structure, derived from code by a producer
//   organization     product areas a human curated
//   navigation       menus a human curated
//
// A node is either a `destination` (a real, reachable surface — carries a
// path) or a `group` (a container: an auto synthetic prefix, or a curated
// heading). Only destinations of the auto route_hierarchy tree *define* a
// surface, so only they carry `bindings` (which Doks live there) and
// `evidence` (the source file proving the route exists). A destination in a
// curated tree is a placement: it re-uses the path and carries its own label,
// never a copy of the bindings.

// Translatable IA label — inline string or Lexicon ref. Identical contract in
// v1 and v2, so the single declaration in ia-v1.ts is reused here.
export const IaLabelSchema = IaLabelV1Schema;
export type IaLabel = IaLabelV1;

/** Who claims a binding: the producer (`auto`) or a person in Studio (`manual`). */
export const IaBindingSourceSchema = z.enum(['auto', 'manual']);
export type IaBindingSource = z.infer<typeof IaBindingSourceSchema>;

// A Dok bound to the destination that defines it. Provenance has no default:
// every persisted binding states who claimed it, so a producer rerun can drop
// exactly the claims code no longer proves.
export const IaBindingSchema = z.strictObject({
  dok_ref: DokIdSchema,
  source: IaBindingSourceSchema,
});
export type IaBinding = z.infer<typeof IaBindingSchema>;

// Producer-written proof that a destination exists in code. Never authored by
// a person, never curated, re-derived on every generate.
export const IaRouteEvidenceSchema = SourceAnchorSchema.extend({
  kind: z.literal('route_source'),
});
export type IaRouteEvidence = z.infer<typeof IaRouteEvidenceSchema>;

// Fields a person froze on a producer-owned node. Listed fields survive the
// next generate untouched; everything else is re-derived.
export const IaCuratedFieldSchema = z.enum(['label', 'tags', 'platform']);
export type IaCuratedField = z.infer<typeof IaCuratedFieldSchema>;

export interface IaDestinationNodeV2 {
  path: string;
  kind: 'destination';
  label: IaLabel;
  curated_fields: IaCuratedField[];
  bindings: IaBinding[];
  evidence?: IaRouteEvidence[];
  // Narrows the tree-level platform (e.g. one desktop-only destination).
  platform?: Platform;
  tags: string[];
  children: IaNodeV2[];
}

export interface IaGroupNodeV2 {
  // Auto synthetic prefixes keep their canonical prefix path so deep-link
  // targets stay stable; curated headings have no path.
  path?: string;
  kind: 'group';
  label: IaLabel;
  curated_fields: IaCuratedField[];
  platform?: Platform;
  tags: string[];
  children: IaNodeV2[];
}

export type IaNodeV2 = IaDestinationNodeV2 | IaGroupNodeV2;

// `group` is a strict object *without* bindings/evidence keys, so a group that
// carries either fails both union members instead of being silently accepted.
export const IaNodeV2Schema: z.ZodType<IaNodeV2> = z.lazy(() =>
  z.union([
    z.strictObject({
      path: z.string().min(1),
      kind: z.literal('destination'),
      label: IaLabelSchema,
      curated_fields: z.array(IaCuratedFieldSchema).default([]),
      bindings: z.array(IaBindingSchema).default([]),
      evidence: z.array(IaRouteEvidenceSchema).optional(),
      platform: PlatformSchema.optional(),
      tags: z.array(z.string()).default([]),
      children: z.array(IaNodeV2Schema).default([]),
    }),
    z.strictObject({
      path: z.string().min(1).optional(),
      kind: z.literal('group'),
      label: IaLabelSchema,
      curated_fields: z.array(IaCuratedFieldSchema).default([]),
      platform: PlatformSchema.optional(),
      tags: z.array(z.string()).default([]),
      children: z.array(IaNodeV2Schema).default([]),
    }),
  ]),
);

export const IaTreeTypeV2Schema = z.enum(['route_hierarchy', 'organization', 'navigation']);
export type IaTreeTypeV2 = z.infer<typeof IaTreeTypeV2Schema>;

/** Where the *structure* came from — not where its bindings or labels came from. */
export const IaTreeSourceV2Schema = z.enum(['auto', 'manual']);
export type IaTreeSourceV2 = z.infer<typeof IaTreeSourceV2Schema>;

/** A repo-relative POSIX path: no leading slash, no backslash, no parent segment. */
function isPosixRelativePath(file: string): boolean {
  return (
    !file.startsWith('/') &&
    !file.includes('\\') &&
    !file.split('/').includes('..')
  );
}

function definesSurfaces(tree: { type: IaTreeTypeV2; source: IaTreeSourceV2 }): boolean {
  return tree.source === 'auto' && tree.type === 'route_hierarchy';
}

function walkIaNodesV2(
  nodes: readonly IaNodeV2[],
  visit: (node: IaNodeV2, at: (string | number)[]) => void,
  at: (string | number)[] = ['nodes'],
): void {
  nodes.forEach((node, index) => {
    const here = [...at, index];
    visit(node, here);
    walkIaNodesV2(node.children, visit, [...here, 'children']);
  });
}

export const IaTreeV2Schema = z.strictObject({
  tree_id: z.string().min(1),
  type: IaTreeTypeV2Schema,
  source: IaTreeSourceV2Schema,
  // Identifies the code that owns an auto tree, e.g. "doklo-route-hierarchy@1".
  producer: z.string().min(1).optional(),
  platform: PlatformSchema.default('all'),
  nodes: z.array(IaNodeV2Schema).default([]),
}).superRefine((tree, ctx) => {
  const surfaceDefiner = definesSurfaces(tree);

  // R7 — curated tree types are manual only; auto trees name their producer.
  if (tree.type !== 'route_hierarchy' && tree.source !== 'manual') {
    ctx.addIssue({
      code: 'custom',
      message: `${tree.type} trees must declare source: manual`,
      path: ['source'],
    });
  }
  if (tree.source === 'auto' && tree.producer === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: 'auto tree requires a producer id',
      path: ['producer'],
    });
  }

  const seenPaths = new Set<string>();

  walkIaNodesV2(tree.nodes, (node, at) => {
    // Path uniqueness covers group paths too — deep-link targets must be unique.
    if (node.path !== undefined) {
      if (seenPaths.has(node.path)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate IA path in tree: ${node.path}`,
          path: [...at, 'path'],
        });
      }
      seenPaths.add(node.path);
    }

    if (node.kind !== 'destination') return;

    // R3 — a surface is defined once, by the auto route_hierarchy tree.
    if (!surfaceDefiner && node.bindings.length > 0) {
      ctx.addIssue({
        code: 'custom',
        message:
          'bindings live on auto route_hierarchy destinations only; a placement carries a label, not a binding',
        path: [...at, 'bindings'],
      });
    }

    // R4 — bindings are a set keyed by dok_ref: one provenance per Dok.
    const seenRefs = new Set<string>();
    node.bindings.forEach((binding, index) => {
      if (seenRefs.has(binding.dok_ref)) {
        ctx.addIssue({
          code: 'custom',
          message: `duplicate dok_ref in bindings: ${binding.dok_ref}`,
          path: [...at, 'bindings', index, 'dok_ref'],
        });
      }
      seenRefs.add(binding.dok_ref);
    });

    // R5 — evidence is producer-only and mandatory where the producer writes.
    if (!surfaceDefiner) {
      if (node.evidence !== undefined) {
        ctx.addIssue({
          code: 'custom',
          message: 'evidence is written by the route producer only',
          path: [...at, 'evidence'],
        });
      }
      return;
    }

    if (node.evidence === undefined || node.evidence.length === 0) {
      ctx.addIssue({
        code: 'custom',
        message: 'auto route_hierarchy destination requires route_source evidence',
        path: [...at, 'evidence'],
      });
      return;
    }

    node.evidence.forEach((item, index) => {
      if (!isPosixRelativePath(item.file)) {
        ctx.addIssue({
          code: 'custom',
          message: `evidence file must be a repo-relative POSIX path: ${item.file}`,
          path: [...at, 'evidence', index, 'file'],
        });
      }
    });
  });
});
export type IaTreeV2 = z.infer<typeof IaTreeV2Schema>;

// Per-service IA: services/<service_id>/ia.json
export const IaFileV2Schema = z.strictObject({
  service_id: ServiceIdSchema,
  version: z.literal(2),
  trees: z.array(IaTreeV2Schema).default([]),
  updated_at: z.string().datetime().optional(),
}).superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.trees.forEach((tree, index) => {
    if (seen.has(tree.tree_id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate IA tree_id: ${tree.tree_id}`,
        path: ['trees', index, 'tree_id'],
      });
    }
    seen.add(tree.tree_id);
  });
});
export type IaFileV2 = z.infer<typeof IaFileV2Schema>;

/**
 * R3 placement check. A curated destination that points at a path no route
 * destination defines is reported as a warning, never a validation error: the
 * route may simply not exist yet, and a stale placement must not make the whole
 * file unreadable.
 */
export function collectIaPlacementWarnings(file: IaFileV2): string[] {
  const routePaths = new Set<string>();
  for (const tree of file.trees) {
    if (!definesSurfaces(tree)) continue;
    walkIaNodesV2(tree.nodes, (node) => {
      if (node.kind === 'destination') routePaths.add(node.path);
    });
  }

  const warnings: string[] = [];
  for (const tree of file.trees) {
    if (definesSurfaces(tree)) continue;
    walkIaNodesV2(tree.nodes, (node) => {
      if (node.kind !== 'destination') return;
      if (routePaths.has(node.path)) return;
      warnings.push(
        `IA placement "${node.path}" in tree "${tree.tree_id}" matches no route destination`,
      );
    });
  }
  return warnings;
}

/**
 * Reads an ia.json of either contract. Producers always write v2; read-only
 * consumers (Studio, hub loader) accept both. Parse failures propagate — a file
 * that is neither contract is an error, not a v1 fallback.
 */
export function parseIaFileAnyVersion(
  value: unknown,
): { version: 2; file: IaFileV2 } | { version: 1; file: IaFileV1 } {
  const stamped = (value ?? {}) as { version?: unknown };
  if (stamped.version === 2) {
    return { version: 2, file: IaFileV2Schema.parse(value) };
  }
  return { version: 1, file: IaFileV1Schema.parse(value) };
}
