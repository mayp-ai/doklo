import { z } from 'zod';
import { DokIdSchema, TermIdSchema } from './ids.js';

// The Lexicon is a curated dictionary of DOMAIN terms — the concepts and
// features this product is made of (e.g. milestone, mentoring, business
// diagnosis). It exists so Dok texts reference one canonical wording via
// TermRef. Raw UI strings (nav labels, button titles, toasts) are NOT
// lexicon terms; they only feed the suggester as corpus material.
export const LexiconCategorySchema = z.enum([
  'concept',  // abstract domain concept OR a product feature/module referred to by name (milestone, settlement, AI chat)
  'role',     // role display name (referenced from roles.json via name_ref)
]);

// Locales map — language code → text
export const LocalesSchema = z.record(z.string(), z.string());

// Binding — describes where the canonical text lives.
// - i18n:     i18n files own the text. Lexicon stores only key + supported locales.
// - constant: A code constant owns the text. Lexicon caches a snapshot for display.
// - owned:    Doklo's Lexicon itself owns the text (fallback when no i18n exists).
export const LexiconBindingI18nSchema = z.object({
  type: z.literal('i18n'),
  key: z.string().min(1),                       // "nav.mypage"
  files: z.array(z.string()).default([]),       // ["locales/ko.json", "locales/en.json"]
  supported_locales: z.array(z.string()).default([]),
}).passthrough();

export const LexiconBindingConstantSchema = z.object({
  type: z.literal('constant'),
  reference: z.string().min(1),                 // "src/constants/labels.ts:LABELS.SAVE"
}).passthrough();

export const LexiconBindingOwnedSchema = z.object({
  type: z.literal('owned'),
}).passthrough();

export const LexiconBindingSchema = z.discriminatedUnion('type', [
  LexiconBindingI18nSchema,
  LexiconBindingConstantSchema,
  LexiconBindingOwnedSchema,
]);

export const LexiconTermSchema = z
  .object({
    term_id: TermIdSchema,
    category: LexiconCategorySchema,
    binding: LexiconBindingSchema,
    // Display cache for `constant` binding (NOT a source of truth)
    snapshot: LocalesSchema.optional(),
    // Authoritative texts — only valid when binding.type === 'owned'
    locales: LocalesSchema.optional(),
    // Reverse index: which Doks use this term
    related_doks: z.array(DokIdSchema).default([]),
  })
  .passthrough()
  .refine(
    (term) =>
      term.binding.type !== 'owned' ||
      (term.locales && Object.keys(term.locales).length > 0),
    { message: '`owned` binding requires non-empty locales' },
  )
  .refine(
    (term) => term.binding.type !== 'i18n' || term.snapshot === undefined,
    { message: '`i18n` binding must not carry snapshot — i18n files are SoT' },
  )
  .refine(
    (term) => term.binding.type === 'owned' || term.locales === undefined,
    { message: '`locales` is only valid for `owned` binding' },
  );

export const LexiconFileSchema = z.object({
  terms: z.array(LexiconTermSchema),
  version: z.number().int().positive().default(1),
  updated_at: z.string().datetime().optional(),
}).passthrough();

export type LexiconCategory = z.infer<typeof LexiconCategorySchema>;
export type LexiconBinding = z.infer<typeof LexiconBindingSchema>;
export type LexiconTerm = z.infer<typeof LexiconTermSchema>;
export type LexiconFile = z.infer<typeof LexiconFileSchema>;
