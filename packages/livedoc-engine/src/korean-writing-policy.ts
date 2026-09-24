import { reviewKoreanWritingFields, type Dok, type KoreanCustomerTone } from '@doklo-beta/core';
import { EngineError, type EngineErrorDetail } from './errors.js';
import type { LivedocManifestWarning } from './manifest.js';
import type { StableHelpCopy } from './stable-help-copy.js';

/** Inspect the same resolved, audience-adjusted prose the stable article renders. */
export function checkKoreanHelpWriting(input: {
  dok: Dok;
  copy: StableHelpCopy;
  tone?: KoreanCustomerTone;
  preview: boolean;
}): LivedocManifestWarning[] {
  const tone = input.tone ?? 'formal';
  const issues: EngineErrorDetail[] = [];
  const recorded = input.dok._meta.writing_policy;
  const acknowledgment = input.dok._meta.writing_review?.policy_acknowledgment;
  const reviewedCurrentPolicy = acknowledgment?.locale === 'ko' && acknowledgment.tone === tone;
  if (recorded && recorded.tone !== tone && !reviewedCurrentPolicy) issues.push({
    code: 'KOREAN_WRITING_POLICY_CHANGED', dokId: input.dok.dok_id, field: '_meta.writing_policy.tone',
    message: `Korean customer tone changed from ${recorded.tone} at generation to ${tone}. After reviewing and editing the wording, record _meta.writing_review.policy_acknowledgment with locale ko, tone ${tone}, and acknowledged_at as a UTC ISO timestamp. Preserve _meta.writing_policy as generation provenance. Alternatively, selectively regenerate and approve the draft. Use --preview to inspect without approval.`,
  });
  const fields: Array<{ field: string; text: unknown }> = [{ field: 'description', text: input.copy.description }];
  for (const step of input.copy.steps) {
    const prefix = `user_actions.steps[${step.source_index}]`;
    if (input.dok.user_actions?.steps[step.source_index]?.actor.kind !== 'system') fields.push({ field: `${prefix}.intent`, text: step.intent });
    fields.push({ field: `${prefix}.outcome`, text: step.outcome });
    for (const [index, text] of step.preconditions.entries()) fields.push({ field: `${prefix}.preconditions[${index}]`, text });
  }
  for (const rule of input.copy.rules) {
    const index = input.dok.business_rules!.rules.findIndex(source => source.id === rule.id);
    fields.push({ field: `business_rules.rules[${index}].description`, text: rule.description });
  }
  for (const criterion of input.copy.criteria) {
    const index = input.dok.acceptance_criteria!.criteria.findIndex(source => source.id === criterion.id);
    fields.push({ field: `acceptance_criteria.criteria[${index}].statement`, text: criterion.statement });
  }
  for (const conflict of reviewKoreanWritingFields(fields, tone)) issues.push({
    code: conflict.code, dokId: input.dok.dok_id, field: conflict.field,
    message: `Expected ${tone} Korean customer tone; found ${conflict.actual_tone} ending in ${conflict.field}: ${conflict.excerpt}. Review and edit or selectively regenerate; use --preview to inspect. No wording was rewritten.`,
  });
  if (!input.preview && issues.length > 0) throw new EngineError(issues[0]!);
  return issues.map(issue => ({ code: issue.code, message: issue.message, dok_id: issue.dokId, field: issue.field }));
}
