import { z } from 'zod';
import { DokIdSchema, ServiceIdSchema } from './ids.js';

export const CodeMappingFileEntrySchema = z.strictObject({
  path: z.string().min(1),
  functions: z.array(z.string()).default([]),
  components: z.array(z.string()).default([]),
  lines: z.string().optional(), // "45-120"
  last_commit: z.string().optional(),
});

// API endpoint, used for both `exposes_apis` (backend) and `consumes_apis` (frontend).
// The string form ("POST /auth/signup") is the join key for cross-service contract sync.
export const ApiEndpointSchema = z.strictObject({
  method: z.string().min(1),
  endpoint: z.string().min(1),
});

export const SyncStatusSchema = z.enum([
  'synced',
  'outdated',
  'pending_dcr',
  'conflict',
]);

// Coarse Dok ↔ code mapping for a single service.
// Lives at services/<service_id>/code-mapping.json
export const ServiceCodeMappingEntrySchema = z.strictObject({
  dok_id: DokIdSchema,
  files: z.array(CodeMappingFileEntrySchema).default([]),
  // APIs this service exposes (backend services)
  exposes_apis: z.array(ApiEndpointSchema).optional(),
  // APIs this service consumes (frontend services) — drives cross-service contract sync
  consumes_apis: z.array(ApiEndpointSchema).optional(),
  db_tables: z.array(z.string()).optional(),
  // Hash of mapped code — change detection
  content_hash: z.string().optional(),
  sync_status: SyncStatusSchema.default('synced'),
  last_synced_at: z.string().datetime().optional(),
}).superRefine((entry, ctx) => {
  const seen = new Set<string>();
  entry.files.forEach((file, index) => {
    if (seen.has(file.path)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate mapped file path: ${file.path}`,
        path: ['files', index, 'path'],
      });
    }
    seen.add(file.path);
  });
});

export const ServiceCodeMappingFileSchema = z.strictObject({
  service_id: ServiceIdSchema,
  entries: z.array(ServiceCodeMappingEntrySchema),
  version: z.number().int().positive().default(1),
  updated_at: z.string().datetime().optional(),
}).superRefine((file, ctx) => {
  const seen = new Set<string>();
  file.entries.forEach((entry, index) => {
    if (seen.has(entry.dok_id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate mapping dok_id: ${entry.dok_id}`,
        path: ['entries', index, 'dok_id'],
      });
    }
    seen.add(entry.dok_id);
  });
});

export type CodeMappingFileEntry = z.infer<typeof CodeMappingFileEntrySchema>;
export type ApiEndpoint = z.infer<typeof ApiEndpointSchema>;
export type SyncStatus = z.infer<typeof SyncStatusSchema>;
export type ServiceCodeMappingEntry = z.infer<typeof ServiceCodeMappingEntrySchema>;
export type ServiceCodeMappingFile = z.infer<typeof ServiceCodeMappingFileSchema>;
