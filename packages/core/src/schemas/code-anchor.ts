import { z } from 'zod';

// Fine-grained code reference attached to a single user_action variant or business rule.
// Coarse mapping (Dok ↔ files/apis) lives in ServiceCodeMapping.
export const CodeAnchorSchema = z.object({
  file: z.string().optional(),           // "src/auth/signup.tsx#L23-45"
  function: z.string().optional(),       // "handleEmailInput"
  component: z.string().optional(),      // "SignupForm"
  api: z.string().optional(),            // "POST /api/auth/check-email"
  db_constraint: z.string().optional(),  // "users.email UNIQUE"
  validation: z.string().optional(),     // "validators.email.required"
  constant: z.string().optional(),       // "ROLES.MANAGER"
  db_field: z.string().optional(),       // "users.role_type"
}).passthrough();

export type CodeAnchor = z.infer<typeof CodeAnchorSchema>;

// Dok-level source provenance — "this Dok was derived from these files."
// Injected deterministically by the generator from the project IR, never
// authored by the LLM, so it stays a *fact* (no hallucinated sources).
// It is the floor of the trust layer: it feeds drift detection (logic_hash
// hashes the anchored files), coverage maps (code tree × Dok), and Studio's
// "where is this from?" jump.
//
// Coarser than CodeAnchor (which pins a single variant/rule to a symbol) and
// finer than ServiceCodeMapping (service-wide). File-level is the MVP; the
// optional symbol/line slots refine an anchor down to a symbol and line range
// (the "파일→심볼·라인" precision layer).
export const SourceAnchorSchema = z
  .object({
    file: z.string().min(1),                               // repo-relative path
    // Service identity is stamped by the generator when a workspace has more
    // than one code root. It remains optional for legacy Doks, which carry
    // `_meta.anchor_service_id` (or are unambiguous single-service files).
    service_id: z.string().min(1).optional(),
    symbol: z.string().min(1).optional(),                  // "validateEmail"
    start_line: z.number().int().positive().optional(),    // 1-based
    end_line: z.number().int().positive().optional(),      // 1-based, inclusive
  })
  .passthrough()
  .superRefine((a, ctx) => {
    // A line range needs a start: an end_line without a start_line is malformed.
    if (a.end_line !== undefined && a.start_line === undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['start_line'],
        message: 'end_line requires start_line',
      });
    }
    // Ranges must be non-empty and ordered.
    if (
      a.start_line !== undefined &&
      a.end_line !== undefined &&
      a.end_line < a.start_line
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['end_line'],
        message: 'end_line must be >= start_line',
      });
    }
  });

export type SourceAnchor = z.infer<typeof SourceAnchorSchema>;
