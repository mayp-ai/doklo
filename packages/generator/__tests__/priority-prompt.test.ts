import { describe, expect, it } from 'vitest';
import {
  buildDokPromptParts,
  type DokGenContext,
  type FeatureForGeneration,
} from '../src/dok-generator.js';

const feature: FeatureForGeneration = {
  canonical_id: 'f1',
  label: 'Checkout',
  dok_id_prefix: 'PAYMENT',
  primary_route: '/payment',
  members: [],
  files: ['app/payment/page.tsx'],
};

function ctx(over: Partial<DokGenContext> = {}): DokGenContext {
  return {
    defaultLocale: 'en',
    knownRoles: ['ROLE-USER'],
    fileContext: {},
    dokId: 'PAYMENT',
    ...over,
  };
}

describe('priority section of the Dok prompt', () => {
  it('teaches both axes in the cacheable system prompt', () => {
    const { systemPrompt } = buildDokPromptParts(feature, ctx());
    expect(systemPrompt).toContain('priority');
    expect(systemPrompt).toContain('blast_radius');
    for (const v of ['revenue', 'core_value', 'compliance', 'enabling', 'supporting']) {
      expect(systemPrompt).toContain(v);
    }
    for (const v of ['blocking', 'degrading', 'cosmetic']) {
      expect(systemPrompt).toContain(v);
    }
  });

  // The tier is derived downstream. Asking the model to rank overall is exactly
  // the collapse into one number this design exists to avoid.
  it('never asks for a tier', () => {
    const { systemPrompt, userPrompt } = buildDokPromptParts(feature, ctx());
    expect(systemPrompt).not.toContain('critical');
    expect(systemPrompt).not.toContain('peripheral');
    expect(userPrompt).not.toContain('critical');
  });

  it('requires compliance to name the obligation', () => {
    const { systemPrompt } = buildDokPromptParts(feature, ctx());
    expect(systemPrompt).toMatch(/obligation/i);
  });

  it('forbids inferring impact from the route path', () => {
    const { systemPrompt } = buildDokPromptParts(feature, ctx());
    expect(systemPrompt).toMatch(/\/admin/);
  });

  // The system prompt is provider-cached across every Dok in one run. Anything
  // per-feature in it kills the cache for the whole run.
  it('keeps the system prompt identical regardless of per-feature locks', () => {
    const unlocked = buildDokPromptParts(feature, ctx()).systemPrompt;
    const locked = buildDokPromptParts(feature, ctx({
      lockedPriority: [{ field: 'impact', value: 'revenue', reason: 'settlement API' }],
    })).systemPrompt;
    expect(locked).toBe(unlocked);
  });

  it('tells the model not to judge a locked axis, and why it is locked', () => {
    const { userPrompt } = buildDokPromptParts(feature, ctx({
      lockedPriority: [
        { field: 'impact', value: 'revenue', reason: 'settlement API is called here' },
      ],
    }));
    expect(userPrompt).toContain('impact');
    expect(userPrompt).toContain('revenue');
    expect(userPrompt).toContain('settlement API is called here');
    expect(userPrompt).toMatch(/omit them/i);
  });

  it('lists every locked axis', () => {
    const { userPrompt } = buildDokPromptParts(feature, ctx({
      lockedPriority: [
        { field: 'impact', value: 'revenue', reason: 'settlement' },
        { field: 'blast_radius', value: 'blocking', reason: 'sole entry path' },
      ],
    }));
    expect(userPrompt).toContain('sole entry path');
    expect(userPrompt).toContain('blast_radius');
  });

  it('adds no lock block when nothing is pinned', () => {
    const { userPrompt } = buildDokPromptParts(feature, ctx());
    expect(userPrompt).not.toMatch(/already decided/i);
  });

  it('adds no lock block for an empty lock list', () => {
    const { userPrompt } = buildDokPromptParts(feature, ctx({ lockedPriority: [] }));
    expect(userPrompt).not.toMatch(/already decided/i);
  });
});

describe('Korean style rules in the Dok prompt', () => {
  it('gives formal intent and outcome complete-sentence examples without plain intention formulas', () => {
    const ko = buildDokPromptParts(feature, ctx({ defaultLocale: 'ko' })).systemPrompt;
    expect(ko).toContain('# Korean style');
    expect(ko).toContain('합쇼체');
    expect(ko).toContain('intent: "설정 화면을 열어 계정 정보를 확인합니다."');
    expect(ko).toContain('outcome: "계정 정보가 표시됩니다."');
    expect(ko).toContain('~하고자 합니다');
    expect(ko).not.toContain('~하고자 한다');
    expect(ko).not.toContain('~하려고 한다');
    const en = buildDokPromptParts(feature, ctx()).systemPrompt;
    expect(en).not.toContain('# Korean style');
  });

  it('gives plain intent and outcome examples in the selected register', () => {
    const ko = buildDokPromptParts(feature, ctx({
      defaultLocale: 'ko',
      koreanCustomerTone: 'plain',
    })).systemPrompt;

    expect(ko).toContain('intent: "설정 화면을 열어 계정 정보를 확인한다."');
    expect(ko).toContain('outcome: "계정 정보가 표시된다."');
    expect(ko).toContain('~하고자 한다');
    expect(ko).not.toContain('~하고자 합니다');
  });
});
