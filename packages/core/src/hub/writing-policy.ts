import type { Dok, KoreanCustomerTone, WritingToneConcern } from '../schemas/index.js';

/** Exact policy fragment shared by the prompt builder and transmission accounting. */
export function koreanWritingPolicyPrompt(tone: KoreanCustomerTone = 'formal'): string {
  const register = tone === 'formal'
    ? 'Use formal polite sentences (합쇼체: ~합니다, ~됩니다, ~할 수 있습니다). Do not use plain endings such as ~한다 or ~보낸다, nor casual polite endings such as ~해요 or ~하세요.'
    : tone === 'polite'
      ? 'Use friendly polite sentences (해요체: ~해요, ~돼요, ~할 수 있어요; imperatives ~하세요). Do not use formal endings such as ~합니다 or ~하십시오, nor plain endings such as ~한다.'
      : 'Use plain declarative sentences (해라체: ~한다, ~된다, ~보낸다). Do not mix in polite endings such as ~합니다, ~보냅니다 or ~해요.';
  return `Korean customer tone: ${tone}\n${register}\nKeep quoted UI labels and canonical product names exact; this policy applies to prose, not names or quotations.`;
}

/**
 * Never a rewrite or a grammar claim: quotations and one-word labels are not
 * sentences, and a sentence's register is read from its last word alone.
 */
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
    // 해요체 first: `~세요` is the polite imperative, not 합쇼체 (which says ~십시오).
    const polite = /(?:해요|세요|돼요|예요|에요|어요|아요|네요|죠)$/u.test(ending);
    const formal = !polite && (/(?:습니다|십시오)$/u.test(ending)
      || (ending.endsWith('니다') && ending.length >= 3 && (ending.charCodeAt(ending.length - 3) - 0xac00) % 28 === 17));
    // 해라체 is any sentence-final ~다 that 합쇼체's ~니다 is not: a list of known
    // endings missed 않는다, 나타난다, 연다 and 싶다, so the correction pass left
    // a quarter of the fields in plain register (review 2026-10-27).
    const plain = !polite && !formal && ending.endsWith('다');
    const actual = polite ? 'polite' : formal ? 'formal' : plain ? 'plain' : undefined;
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
