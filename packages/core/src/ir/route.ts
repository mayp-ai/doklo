import { z } from 'zod';

export const RouteKindSchema = z.enum([
  'page',         // user-facing page route
  'api',          // server endpoint
  'layout',       // wrapping layout
  'middleware',   // request middleware
  'route_group',  // organizational grouping (no own URL)
]);

// One discovered route in the project.
// Framework-specific extras live under `framework_specific` so generic
// downstream code can ignore them.
export const RouteIRSchema = z.object({
  // Logical URL path (e.g., "/users/[id]/posts").
  path: z.string().min(1),
  kind: RouteKindSchema,
  // HTTP method for `api` kind. Undefined for pages/layouts.
  http_method: z.string().optional(),
  // Source file relative to project root.
  file: z.string().min(1),
  // Names of dynamic segments (e.g., ["id"] for /users/[id]).
  dynamic_params: z.array(z.string()).default([]),
  // Parent layout files, root → leaf.
  layout_chain: z.array(z.string()).default([]),
  // Next.js App Router specific. Undefined when irrelevant.
  is_server_component: z.boolean().optional(),
  framework_specific: z.record(z.string(), z.unknown()).optional(),
});

export type RouteKind = z.infer<typeof RouteKindSchema>;
export type RouteIR = z.infer<typeof RouteIRSchema>;
