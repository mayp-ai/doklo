import { z } from 'zod';

export const KoreanCustomerToneSchema = z.enum(['formal', 'plain']);
export type KoreanCustomerTone = z.infer<typeof KoreanCustomerToneSchema>;

export const DokWritingPolicySchema = z.object({
  locale: z.literal('ko'),
  tone: KoreanCustomerToneSchema,
});

export const WritingToneConcernSchema = z.object({
  code: z.literal('KOREAN_TONE_CONFLICT'),
  field: z.string(),
  expected_tone: KoreanCustomerToneSchema,
  actual_tone: KoreanCustomerToneSchema,
  excerpt: z.string(),
});
export type WritingToneConcern = z.infer<typeof WritingToneConcernSchema>;
