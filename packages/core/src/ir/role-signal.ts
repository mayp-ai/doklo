import { z } from 'zod';
import { RoleKindSchema } from '../schemas/role.js';

export const RoleSignalSourceSchema = z.enum(['explicit', 'middleware']);
export const RoleSignalIRSchema = z.object({
  value: z.string().min(1),
  kind: RoleKindSchema,
  source: RoleSignalSourceSchema,
  file: z.string().min(1),
  line: z.number().int().positive().optional(),
  detector: z.string().min(1),
});

export type RoleSignalSource = z.infer<typeof RoleSignalSourceSchema>;
export type RoleSignalIR = z.infer<typeof RoleSignalIRSchema>;
