import { z } from 'zod';

export const ParamIRSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  is_optional: z.boolean().default(false),
});

export const ComponentKindSchema = z.enum([
  'component',  // React/Vue UI component
  'function',   // plain function
  'hook',       // React custom hook
  'class',      // class declaration
  'method',     // class method
]);

// One named code unit (component, function, hook, class).
// Adapters MAY emit multiple units per file.
export const ComponentIRSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  start_line: z.number().int().nonnegative().optional(),
  end_line: z.number().int().nonnegative().optional(),
  kind: ComponentKindSchema,
  is_exported: z.boolean().default(false),
  is_async: z.boolean().optional(),
  // Function/component inputs (params or props).
  inputs: z.array(ParamIRSchema).default([]),
  returns: z.string().optional(),
  jsdoc: z.string().optional(),
  // React/Vue hooks called inside (UI components only).
  hooks_used: z.array(z.string()).optional(),
  framework_specific: z.record(z.string(), z.unknown()).optional(),
});

export type ParamIR = z.infer<typeof ParamIRSchema>;
export type ComponentKind = z.infer<typeof ComponentKindSchema>;
export type ComponentIR = z.infer<typeof ComponentIRSchema>;
