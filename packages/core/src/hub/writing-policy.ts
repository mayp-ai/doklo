import type { Dok, KoreanCustomerTone, WritingToneConcern } from '../schemas/index.js';

/** Exact policy fragment shared by the prompt builder and transmission accounting. */
export function koreanWritingPolicyPrompt(tone: KoreanCustomerTone = 'formal'): string {
  return `Korean customer tone: ${tone}\n${tone === 'formal'
    ? 'Use formal polite sentences (합쇼체: ~합니다, ~됩니다, ~할 수 있습니다). Do not use plain endings such as ~한다 or ~보낸다.'
    : 'Use plain declarative sentences (해라체: ~한다, ~된다, ~보낸다). Do not mix in polite endings such as ~합니다 or ~보냅니다.'}\nKeep quoted UI labels and canonical product names exact; this policy applies to prose, not names or quotations.`;
}

/** Deliberately conservative: known endings only, never a rewrite or a grammar claim. */
export function findKoreanToneConflicts(text: string, tone: KoreanCustomerTone = 'formal'): Array<Omit<WritingToneConcern, 'field'>> {
  // Mask literal labels/quotations/code while retaining offsets for review excerpts.
  const prose = text.replace(/```[\s\S]*?```|`[^`]*`|"(?:\\.|[^"\\])*"|'[^'\n]*'|“[^”]*”|‘[^’]*’|「[^」]*」|『[^』]*』/gu,
    value => value.replace(/[^\n]/gu, ' '));
  const concerns: Array<Omit<WritingToneConcern, 'field'>> = [];
  for (const match of prose.matchAll(/[^\r\n.!?。！？]+(?:[.!?。！？]+|(?=[\r\n]|$))/gu)) {
    const sentence = match[0].replace(/[.!?。！？]+$/u, '').trim();
    const words = sentence.match(/[가-힣]+/gu) ?? [];
    // A bare button label or heading is not evidence of a sentence register.
    if (words.length < 2) continue;
    const ending = /([가-힣]+)$/u.exec(sentence)?.[1];
    if (!ending) continue;
    const formal = /(?:습니다|십시오|세요)$/u.test(ending)
      || (ending.endsWith('니다') && ending.length >= 3 && (ending.charCodeAt(ending.length - 3) - 0xac00) % 28 === 17);
    const plain = /(?:한다|된다|있다|없다|않다|아니다|보낸다|누른다|받는다|보인다|열린다|닫힌다|지운다|읽는다|만든다|바꾼다|나온다)$/u.test(ending);
    const actual = formal ? 'formal' : plain ? 'plain' : undefined;
    if (actual && actual !== tone) concerns.push({
      code: 'KOREAN_TONE_CONFLICT', expected_tone: tone, actual_tone: actual,
      excerpt: text.slice(match.index, match.index + match[0].length).trim().slice(0, 240),
    });
  }
  return concerns;
}

export function reviewKoreanWritingFields(
  fields: ReadonlyArray<{ field: string; text: unknown }>,
  tone: KoreanCustomerTone = 'formal',
): WritingToneConcern[] {
  return fields.flatMap(({ field, text }) => typeof text === 'string'
    ? findKoreanToneConflicts(text, tone).map(concern => ({ ...concern, field }))
    : []);
}

/** Deterministic metadata only. Customer prose and human approval never change. */
export function recordDokWritingPolicy(dok: Dok, locale: string, tone: KoreanCustomerTone = 'formal'): void {
  delete dok._meta.writing_policy;
  delete dok._meta.writing_review;
  if (locale !== 'ko') return;
  const fields: Array<{ field: string; text: unknown }> = [{ field: 'description', text: dok.description }];
  for (const [index, step] of (dok.user_actions?.steps ?? []).entries()) {
    const prefix = `user_actions.steps[${index}]`;
    fields.push({ field: `${prefix}.intent`, text: step.intent }, { field: `${prefix}.outcome`, text: step.outcome });
    for (const [i, text] of (step.preconditions ?? []).entries()) fields.push({ field: `${prefix}.preconditions[${i}]`, text });
    for (const [i, variant] of step.variants.entries()) fields.push({ field: `${prefix}.variants[${i}].outcome_override`, text: variant.outcome_override });
  }
  for (const [index, rule] of (dok.business_rules?.rules ?? []).entries()) fields.push({ field: `business_rules.rules[${index}].description`, text: rule.description });
  for (const [index, criterion] of (dok.acceptance_criteria?.criteria ?? []).entries()) {
    for (const field of ['statement', 'given', 'when', 'then'] as const) fields.push({ field: `acceptance_criteria.criteria[${index}].${field}`, text: criterion[field] });
  }
  dok._meta.writing_policy = { locale: 'ko', tone };
  dok._meta.writing_review = { assessed_by: 'deterministic', concerns: reviewKoreanWritingFields(fields, tone) };
}
