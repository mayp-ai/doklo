import { z } from 'zod';
import { ServiceIdSchema } from './ids.js';
import { KoreanCustomerToneSchema } from './writing-policy.js';

export const ServiceTypeSchema = z.enum([
  'frontend',  // web app, mobile web, etc.
  'backend',   // API server
  'admin',     // admin panel
  'mobile',    // native mobile app
  'cli',       // command-line tool
  'desktop',   // desktop app
  'worker',    // background worker
]);

export const FrameworkSchema = z.enum([
  // Frontend
  'nextjs',
  'react-vite',
  'vue',
  'nuxt',
  'svelte',
  'sveltekit',
  'angular',
  // Mobile
  'react-native',
  'flutter',
  // Backend
  'spring-boot',
  'nestjs',
  'express',
  'fastify',
  'fastapi',
  'django',
  'rails',
  'aspnet',
  // Catch-all
  'unknown',
]);

export const ServiceSchema = z.object({
  service_id: ServiceIdSchema,
  type: ServiceTypeSchema,
  framework: FrameworkSchema,
  // Path to the service's code root, relative to workspace root
  code_root: z.string().min(1).refine(isContainedRelativeCodeRoot, {
    message: 'code_root must be a contained relative path',
  }),
  description: z.string().optional(),
});

export const WorkspaceSchema = z.object({
  workspace_id: z.string().min(1),
  name: z.string().min(1),
  services: z.array(ServiceSchema),
  // Language used in inline Dok text (description, intent, outcome).
  // Drives the LLM prompt's "respond in <locale>" instruction.
  default_locale: z.string().default('en'),
  // Absent means formal, preserving the existing Korean generation default.
  korean_customer_tone: KoreanCustomerToneSchema.optional(),
  // User-facing UI locales tracked by the Lexicon.
  // May differ from default_locale (e.g., PM writes in en, users see ko/en/ja).
  supported_locales: z.array(z.string()).default(['en', 'ko']),
  // Customer-facing proper nouns (product, company, vendor names) that the
  // stable Live Docs identifier lint must not treat as internal code symbols.
  // Anything listed here is published verbatim, so keep it to public names.
  stable_public_terms: z.array(z.string().min(1)).optional(),
  recording_branch: z.string().min(1).optional(),
  created_at: z.string().datetime().optional(),
  updated_at: z.string().datetime().optional(),
}).superRefine((workspace, ctx) => {
  const serviceIds = new Set<string>();
  workspace.services.forEach((service, index) => {
    if (serviceIds.has(service.service_id)) {
      ctx.addIssue({
        code: 'custom',
        message: `duplicate service_id: ${service.service_id}`,
        path: ['services', index, 'service_id'],
      });
    }
    serviceIds.add(service.service_id);
  });
});

function isContainedRelativeCodeRoot(value: string): boolean {
  if (value.includes('\0')) return false;
  const normalized = value.replace(/\\/g, '/');
  if (normalized.startsWith('/') || /^[A-Za-z]:\//u.test(normalized)) return false;
  return !normalized.split('/').includes('..');
}

export type ServiceType = z.infer<typeof ServiceTypeSchema>;
export type Framework = z.infer<typeof FrameworkSchema>;
export type Service = z.infer<typeof ServiceSchema>;
export type Workspace = z.infer<typeof WorkspaceSchema>;
