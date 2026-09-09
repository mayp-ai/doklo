import { z } from 'zod';
import { ParamIRSchema } from './component.js';

export const StoreKindSchema = z.enum([
  'zustand',
  'redux',
  'jotai',
  'recoil',
  'context',  // React Context
  'pinia',    // Vue
  'unknown',
]);

export const StateFieldIRSchema = z.object({
  name: z.string().min(1),
  type: z.string().optional(),
  initial_value: z.string().optional(),
});

export const StoreActionIRSchema = z.object({
  name: z.string().min(1),
  is_async: z.boolean().optional(),
  params: z.array(ParamIRSchema).default([]),
});

export const StoreSelectorIRSchema = z.object({
  name: z.string().min(1),
  returns: z.string().optional(),
});

// One state container (Zustand store, Redux slice, Context provider, ...).
export const StoreIRSchema = z.object({
  name: z.string().min(1),
  file: z.string().min(1),
  kind: StoreKindSchema,
  state_fields: z.array(StateFieldIRSchema).default([]),
  actions: z.array(StoreActionIRSchema).default([]),
  selectors: z.array(StoreSelectorIRSchema).default([]),
  framework_specific: z.record(z.string(), z.unknown()).optional(),
});

export type StoreKind = z.infer<typeof StoreKindSchema>;
export type StateFieldIR = z.infer<typeof StateFieldIRSchema>;
export type StoreActionIR = z.infer<typeof StoreActionIRSchema>;
export type StoreSelectorIR = z.infer<typeof StoreSelectorIRSchema>;
export type StoreIR = z.infer<typeof StoreIRSchema>;
