// FROZEN v1 schema — do not edit. v2 lives in ia.ts.
//
// This is the pre-"Product Surface Model" IA contract, kept verbatim so that
// existing `.doklo/hub/services/<id>/ia.json` files stay readable. Only
// migration and read-only consumers may parse it; producers emit v2.
import { z } from 'zod';
import { DokIdSchema, ServiceIdSchema, TermRefSchema } from './ids.js';
import { PlatformSchema } from './dok.js';

// Translatable IA label — inline string or Lexicon ref.
// The label contract is identical in v2, so ia.ts re-exports this one instance
// as `IaLabelSchema` instead of declaring a second copy.
export const IaLabelV1Schema = z.union([z.string().min(1), TermRefSchema.strict()]);
export type IaLabelV1 = z.infer<typeof IaLabelV1Schema>;

export interface IaNodeV1 {
  path?: string;
  label: IaLabelV1;
  dok_ref?: string | null;
  // Narrows the tree-level platform. Useful when one node is desktop-only
  // (e.g. /admin) inside an otherwise platform-agnostic tree.
  platform?: z.infer<typeof PlatformSchema>;
  // Free-form annotations — "v2.0", "experimental", "2차-업데이트". Used by
  // the Sitemap view to group cards into background regions.
  tags?: string[];
  children: IaNodeV1[];
}

export const IaNodeV1Schema: z.ZodType<IaNodeV1> = z.lazy(() =>
  z.strictObject({
    path: z.string().optional(),                  // "/dashboard/analytics"
    label: IaLabelV1Schema,
    // null = container node (menu group not tied to a single feature)
    dok_ref: DokIdSchema.nullable().optional(),
    platform: PlatformSchema.optional(),
    tags: z.array(z.string()).default([]),
    children: z.array(IaNodeV1Schema).default([]),
  }),
);

export const IaTreeTypeV1Schema = z.enum(['navigation', 'sitemap', 'feature_group']);

// Platform-specific information architecture tree.
// "nav-desktop" and "nav-mobile" can coexist for the same service.
export const IaTreeV1Schema = z.strictObject({
  tree_id: z.string().min(1),
  type: IaTreeTypeV1Schema.default('navigation'),
  platform: PlatformSchema.default('all'),
  source: z.enum(['auto', 'manual', 'auto+manual']).default('auto'),
  nodes: z.array(IaNodeV1Schema).default([]),
}).superRefine((tree, ctx) => {
  const seen = new Set<string>();
  const visit = (nodes: IaNodeV1[]): void => {
    nodes.forEach((node, index) => {
      if (node.path !== undefined) {
        if (seen.has(node.path)) {
          ctx.addIssue({
            code: 'custom',
            message: `duplicate IA path in tree: ${node.path}`,
            path: ['nodes', index, 'path'],
          });
        }
        seen.add(node.path);
      }
      visit(node.children);
    });
  };
  visit(tree.nodes);
});

export const IaEdgeTypeV1Schema = z.enum([
  'requires',
  'navigates_to',
  'depends_on',
  'references',
  'extends',
]);

// Edges are a v1-only concept — v2 has no counterpart, so the export keeps its
// original name.
export const IaEdgeSchema = z.strictObject({
  from: DokIdSchema,
  to: DokIdSchema,
  type: IaEdgeTypeV1Schema,
});

// Per-service IA: services/<service_id>/ia.json
export const IaFileV1Schema = z.strictObject({
  service_id: ServiceIdSchema,
  trees: z.array(IaTreeV1Schema).default([]),
  edges: z.array(IaEdgeSchema).default([]),
  version: z.number().int().positive().default(1),
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

export type IaTreeTypeV1 = z.infer<typeof IaTreeTypeV1Schema>;
export type IaTreeV1 = z.infer<typeof IaTreeV1Schema>;
export type IaEdgeType = z.infer<typeof IaEdgeTypeV1Schema>;
export type IaEdge = z.infer<typeof IaEdgeSchema>;
export type IaFileV1 = z.infer<typeof IaFileV1Schema>;
