import { z } from 'zod';
import { DokSchema } from './dok.js';
import { ServiceCodeMappingEntrySchema } from './code-mapping.js';
import { LexiconTermSchema } from './lexicon.js';
// The LLM still proposes v1-shaped IA fragments; the generator normalizes them.
import { IaTreeV1Schema } from './ia-v1.js';
import { RoleSchema } from './role.js';

// LLM output schema — produced by the generator after consuming a code batch.
// Deterministic extractors (AST, routing, i18n, RBAC) merge their results
// with this LLM output to form the final hub state.
//
// Naming: `proposed_*` makes it explicit that LLM output is a proposal that
// the deterministic layer may override or reject.
export const LLMResponseSchema = z.object({
  doks: z.array(DokSchema),
  proposed_roles: z.array(RoleSchema).default([]),
  proposed_lexicon_terms: z.array(LexiconTermSchema).default([]),
  proposed_code_mappings: z.array(ServiceCodeMappingEntrySchema).default([]),
  // IA v2 retires functional topology between Doks, so there is nothing for the
  // LLM to propose there; the field it used to fill had no consumer anyway.
  // Usually only when no router-based extraction exists
  proposed_ia_trees: z.array(IaTreeV1Schema).default([]),
});

export type LLMResponse = z.infer<typeof LLMResponseSchema>;
