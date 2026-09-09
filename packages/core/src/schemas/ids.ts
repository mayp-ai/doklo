import { z } from 'zod';

/** Dok ID grammar — semantic name, 1-3 UPPERCASE segments (e.g., HOME, AUTH-SIGNIN, AUTH-PASSWORD-RESET). */
export const DOK_ID_RE = /^[A-Z][A-Z0-9]{1,9}(?:-[A-Z][A-Z0-9]{1,9}){0,2}$/;
/** First segment BR/AC is reserved for child rule/criterion ids. */
const RESERVED_FIRST_SEGMENT_RE = /^(?:BR|AC)(?:-|$)/;

export const DokIdSchema = z
  .string()
  .regex(DOK_ID_RE, 'dok_id must be 1-3 UPPERCASE segments, e.g. AUTH-SIGNIN')
  .refine((id) => !RESERVED_FIRST_SEGMENT_RE.test(id), 'dok_id must not start with reserved segment BR or AC');

/** Role ID — ROLE-XXX (e.g., ROLE-USER, ROLE-MANAGER, ROLE-ADMIN) */
export const RoleIdSchema = z
  .string()
  .regex(/^ROLE-[A-Z][A-Z0-9_-]*$/, 'role_id must start with ROLE-');

/** Lexicon term ID — TERM-XXX (e.g., TERM-NAV-MYPAGE) */
export const TermIdSchema = z
  .string()
  .regex(/^TERM-[A-Z][A-Z0-9_-]*$/, 'term_id must start with TERM-');

/** Business rule ID — BR-{DOK_ID}-NN (e.g., BR-AUTH-SIGNIN-01) */
export const BusinessRuleIdSchema = z
  .string()
  .regex(/^BR-[A-Z][A-Z0-9]{1,9}(?:-[A-Z][A-Z0-9]{1,9}){0,2}-\d{2}$/, 'rule id must be BR-{DOK_ID}-NN');

/** Acceptance criterion ID — AC-{DOK_ID}-NN */
export const AcceptanceCriteriaIdSchema = z
  .string()
  .regex(/^AC-[A-Z][A-Z0-9]{1,9}(?:-[A-Z][A-Z0-9]{1,9}){0,2}-\d{2}$/, 'criterion id must be AC-{DOK_ID}-NN');

/** Service ID — kebab-case identifier (e.g., web, api, admin, customer-portal) */
export const ServiceIdSchema = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, 'service_id must be kebab-case');

/** TermRef — pointer to a Lexicon term, used wherever a translatable string can appear */
export const TermRefSchema = z.object({
  term_ref: TermIdSchema,
}).passthrough();

export type DokId = z.infer<typeof DokIdSchema>;
export type RoleId = z.infer<typeof RoleIdSchema>;
export type TermId = z.infer<typeof TermIdSchema>;
export type BusinessRuleId = z.infer<typeof BusinessRuleIdSchema>;
export type AcceptanceCriteriaId = z.infer<typeof AcceptanceCriteriaIdSchema>;
export type ServiceId = z.infer<typeof ServiceIdSchema>;
export type TermRef = z.infer<typeof TermRefSchema>;
