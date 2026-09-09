import { z } from 'zod';
import { RoleIdSchema, TermRefSchema } from './ids.js';
import { CodeAnchorSchema } from './code-anchor.js';

export const RoleScopeSchema = z.enum(['global', 'tenant', 'resource']);
export const RoleKindSchema = z.enum(['access', 'actor_type']);
export const RoleConfidenceSchema = z.enum(['high', 'medium', 'low']);
export const RoleExtractionMetaSchema = z.object({
  confidence: RoleConfidenceSchema,
  evidence: z.array(z.string().min(1)).default([]),
}).passthrough();

// Translatable role name — either inline string or pointer to Lexicon
export const RoleNameSchema = z.union([z.string().min(1), TermRefSchema]);

export const RoleSchema = z.object({
  role_id: RoleIdSchema,
  name: RoleNameSchema,
  description: z.string().optional(),
  kind: RoleKindSchema.default('access'),
  // RBAC hierarchy — this role inherits from listed roles
  extends: z.array(RoleIdSchema).default([]),
  scope: RoleScopeSchema.default('global'),
  // Where in the codebase this role is defined
  code_anchor: CodeAnchorSchema.optional(),
  _meta: z.object({ extraction: RoleExtractionMetaSchema.optional() }).passthrough().optional(),
}).passthrough();

export const RolesFileSchema = z.object({
  roles: z.array(RoleSchema),
  version: z.number().int().positive().default(1),
  updated_at: z.string().datetime().optional(),
}).passthrough();

export type RoleScope = z.infer<typeof RoleScopeSchema>;
export type RoleKind = z.infer<typeof RoleKindSchema>;
export type RoleConfidence = z.infer<typeof RoleConfidenceSchema>;
export type RoleExtractionMeta = z.infer<typeof RoleExtractionMetaSchema>;
export type RoleName = z.infer<typeof RoleNameSchema>;
export type Role = z.infer<typeof RoleSchema>;
export type RolesFile = z.infer<typeof RolesFileSchema>;
