import { describe, it, expect } from 'vitest';
import {
  buildDokPrompt,
  parseDokFromLLMResponse,
  type DokGenContext,
} from '../src/dok-generator.js';

const sampleFeature = {
  canonical_id: 'auth-signin',
  label: 'Sign in',
  dok_id_prefix: 'AUTH',
  primary_route: '/auth/signin',
  files: ['app/auth/signin/page.tsx'],
  members: [
    { id: 'auth-signin', label: 'Sign in', route: '/auth/signin' },
  ],
};

const ctx: DokGenContext = {
  defaultLocale: 'en',
  knownRoles: ['ROLE-USER', 'ROLE-ADMIN'],
  fileContext: { 'app/auth/signin/page.tsx': 'export default function SignIn(){return null;}' },
  dokId: 'AUTH',
};

describe('buildDokPrompt', () => {
  it('embeds the chosen dok_id verbatim', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).toContain('AUTH');
  });

  it('includes the feature route + files', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).toContain('/auth/signin');
    expect(p).toContain('app/auth/signin/page.tsx');
  });

  it('includes the file contents passed in fileContext', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).toContain('export default function SignIn');
  });

  it('mentions the known roles so the LLM can role_ref them', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).toContain('ROLE-USER');
    expect(p).toContain('ROLE-ADMIN');
  });

  it('asks for english output when defaultLocale=en', () => {
    expect(buildDokPrompt(sampleFeature, { ...ctx, defaultLocale: 'en' })).toMatch(/English/);
  });

  it('asks for korean output when defaultLocale=ko', () => {
    expect(buildDokPrompt(sampleFeature, { ...ctx, defaultLocale: 'ko' })).toMatch(/한국어/);
  });

  it('embeds the suggestedActorRole hint when provided', () => {
    const p = buildDokPrompt(sampleFeature, { ...ctx, suggestedActorRole: 'ROLE-ADMIN' });
    expect(p).toContain('ROLE-ADMIN');
    expect(p).toContain('Suggested primary actor');
    expect(p).toContain('/auth/signin'); // route is mentioned in the hint
  });

  it('omits the suggested actor hint when suggestedActorRole is unset', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).not.toContain('Suggested primary actor');
  });

  // Hallucination guard (spec §4.3 / acceptance §8.2): the only thing stopping
  // the LLM from inventing a code_anchor is that the prompt never shows the
  // field. Lock that — a future prompt edit must not silently reintroduce it.
  it('never exposes code_anchor to the LLM (deterministic-only provenance)', () => {
    const p = buildDokPrompt(sampleFeature, { ...ctx, defaultLocale: 'ko' });
    expect(p).not.toContain('code_anchor');
    expect(p).not.toContain('source_anchor');
  });

  it('does not give the LLM authority over human review status', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).not.toMatch(/status:\s*'active'/);
    expect(p).not.toContain("'planned' | 'deprecated'");
  });
});

describe('buildDokPrompt terminology section', () => {
  it('lists canonical terms when provided', () => {
    const p = buildDokPrompt(sampleFeature, { ...ctx, lexiconTerms: ['마일스톤', '사업진단'] });
    expect(p).toContain('# Terminology');
    expect(p).toContain('- 마일스톤');
    expect(p).toContain('- 사업진단');
  });

  it('omits the section when no terms', () => {
    const p = buildDokPrompt(sampleFeature, ctx);
    expect(p).not.toContain('# Terminology');
  });
});

describe('parseDokFromLLMResponse', () => {
  function validDokJson(): string {
    return JSON.stringify({
      dok_id: 'AUTH',
      name: 'Sign in',
      status: 'active',
      tags: ['auth', 'signin'],
      surfaces: ['web'],
      description: 'Users authenticate using their email and password to access the application.',
      user_actions: {
        steps: [
          {
            order: 1,
            actor: { kind: 'role', role_ref: 'ROLE-USER' },
            intent: 'Open the sign-in page',
            outcome: 'Sign-in form is displayed',
            variants: [{ platform: 'all', interaction: 'navigate' }],
          },
          {
            order: 2,
            actor: { kind: 'role', role_ref: 'ROLE-USER' },
            intent: 'Enter credentials and submit',
            outcome: 'Authenticated session is created',
            variants: [{ platform: 'all', interaction: 'submit' }],
          },
        ],
      },
      business_rules: { rules: [] },
      acceptance_criteria: { criteria: [] },
    });
  }

  it('parses a clean JSON response', () => {
    const result = parseDokFromLLMResponse(validDokJson());
    expect(result.success).toBe(true);
    expect(result.dok?.dok_id).toBe('AUTH');
    expect(result.dok?.status).toBe('draft');
  });

  it('overrides model-authored review status with draft', () => {
    const result = parseDokFromLLMResponse(validDokJson());
    expect(result.dok?.status).toBe('draft');
  });

  it('extracts JSON when wrapped in ```json fences', () => {
    const fenced = '```json\n' + validDokJson() + '\n```';
    const result = parseDokFromLLMResponse(fenced);
    expect(result.success).toBe(true);
  });

  it('returns success=false for malformed JSON', () => {
    const result = parseDokFromLLMResponse('{ not json }');
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });

  it('returns success=false for JSON that fails Dok schema validation', () => {
    const result = parseDokFromLLMResponse(JSON.stringify({ dok_id: 'x' }));
    expect(result.success).toBe(false);
    expect(result.error).toBeTruthy();
  });
});

it('reports the JSON syntax error inside a fence, not the fence itself', () => {
  const result = parseDokFromLLMResponse('```json\n{"description":"example"; , "dok_id":"MYAD-STATUS"}\n```');
  expect(result.success).toBe(false);
  expect(result.error).toContain('JSON parse failed');
  expect(result.error).not.toContain("Unexpected token '`'");
  expect(result.error).not.toContain('```json');
});
