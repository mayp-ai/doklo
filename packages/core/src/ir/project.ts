import { z } from 'zod';
import { FrameworkSchema } from '../schemas/workspace.js';
import { RouteIRSchema } from './route.js';
import { ComponentIRSchema } from './component.js';
import { StoreIRSchema } from './store.js';
import { RoleSignalIRSchema } from './role-signal.js';

// ProjectIR — framework-agnostic snapshot of one service's source code.
//
// Adapters (e.g., adapter-nextjs) produce this; downstream packages
// (generator, evaluator) consume it without knowing the source framework.
//
// One ProjectIR = one service. A multi-service workspace produces N
// ProjectIRs, one per Service entry in workspace.json.
export const ProjectIRSchema = z.object({
  framework: FrameworkSchema,
  framework_version: z.string().optional(),
  // Project root directory (absolute or relative — adapter's choice).
  root: z.string().min(1),
  // All discovered source files relative to `root`.
  files: z.array(z.string()).default([]),
  routes: z.array(RouteIRSchema).default([]),
  components: z.array(ComponentIRSchema).default([]),
  stores: z.array(StoreIRSchema).default([]),
  role_signals: z.array(RoleSignalIRSchema).default([]),
  // Adapter-specific extras with no IR home yet (deps, config, env vars).
  // Generic consumers should ignore this; specialized consumers may opt in.
  framework_specific: z.record(z.string(), z.unknown()).optional(),
});

export type ProjectIR = z.infer<typeof ProjectIRSchema>;
