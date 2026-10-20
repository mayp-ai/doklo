import { describe, expect, it } from 'vitest';
import type { Dok, Workspace } from '@doklo-beta/core';
import { projectDokDetail } from '../lib/dok-detail-view';

const workspace = {
  workspace_id: 'workspace',
  name: 'Workspace',
  services: [
    { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
  ],
  default_locale: 'en',
  supported_locales: ['en'],
} as Workspace;

const dok = {
  dok_id: 'AUTH-SIGNIN',
  name: { term_ref: 'TERM-SIGN-IN' },
  status: 'draft',
  tags: [],
  surfaces: ['web'],
  description: 'A complete description.',
  user_actions: {
    steps: [
      {
        order: 1,
        actor: { kind: 'external', label: 'Identity provider' },
        intent: 'returns an authorization code',
        outcome: 'the code is accepted',
        variants: [{
          platform: 'all',
          interaction: 'auto',
          code_anchor: { file: 'app/auth/callback.ts#L20-28', function: 'callback', api: 'GET /callback' },
          outcome_override: { term_ref: 'TERM-CALLBACK-OUTCOME' },
        }],
      },
      {
        order: 2,
        actor: { kind: 'system' },
        intent: { term_ref: 'TERM-VERIFY' },
        outcome: 'a session is created',
        variants: [],
      },
    ],
  },
  business_rules: {
    rules: [
      { id: 'BR-AUTH-SIGNIN-01', description: 'One', type: 'permission' },
      { id: 'BR-AUTH-SIGNIN-02', description: 'Two', type: 'validation' },
      { id: 'BR-AUTH-SIGNIN-03', description: 'Unlinked', type: 'policy', applies_to_roles: ['ROLE-ADMIN'], code_anchor: { function: 'recordAudit', api: 'POST /audit' } },
    ],
  },
  acceptance_criteria: {
    criteria: [
      {
        id: 'AC-AUTH-SIGNIN-01',
        statement: 'Both rules apply.',
        related_rules: ['BR-AUTH-SIGNIN-01', 'BR-AUTH-SIGNIN-02'],
        given: 'signed out',
      },
      {
        id: 'AC-AUTH-SIGNIN-02',
        statement: 'The first rule applies again.',
        related_rules: ['BR-AUTH-SIGNIN-01'],
      },
      { id: 'AC-AUTH-SIGNIN-03', statement: 'Unlinked.', related_rules: [] },
    ],
  },
  _meta: {
    version: 1,
    history: [],
    anchor_service_id: 'web',
    source_anchors: [{ file: 'app/auth/callback.ts', start_line: 10, end_line: 30 }],
  },
} as Dok;

describe('projectDokDetail', () => {
  it('preserves actors, term references, N:N links and optional GWT fields', () => {
    const detail = projectDokDetail(dok, workspace);

    expect(detail.name).toBe('{TERM-SIGN-IN}');
    expect(detail.steps.map((step) => [step.actorKind, step.actor, step.intent])).toEqual([
      ['external', 'Identity provider', 'returns an authorization code'],
      ['system', 'system', '{TERM-VERIFY}'],
    ]);
    expect(detail.rules.map((rule) => rule.relatedCriteria)).toEqual([
      ['AC-AUTH-SIGNIN-01', 'AC-AUTH-SIGNIN-02'],
      ['AC-AUTH-SIGNIN-01'],
      [],
    ]);
    expect(detail.criteria[0]).toMatchObject({
      relatedRules: ['BR-AUTH-SIGNIN-01', 'BR-AUTH-SIGNIN-02'],
      given: 'signed out',
      when: null,
      then: null,
    });
  });

  it('keeps step evidence separate and resolves Dok anchors through the service code root', () => {
    const detail = projectDokDetail(dok, workspace);

    expect(detail.steps[0]?.evidence).toEqual([
      { file: 'apps/web/app/auth/callback.ts', startLine: 20, endLine: 28, label: 'callback · GET /callback' },
    ]);
    expect(detail.steps[0]?.variants).toContain('all · auto · outcome: {TERM-CALLBACK-OUTCOME}');
    expect(detail.steps[1]?.evidence).toEqual([]);
    expect(detail.rules[2]).toMatchObject({
      appliesToRoles: ['ROLE-ADMIN'],
      evidence: { file: null, label: 'recordAudit · POST /audit' },
    });
    expect(detail.anchors).toEqual([
      { file: 'apps/web/app/auth/callback.ts', startLine: 10, endLine: 30, symbol: null },
    ]);
  });

  it('uses the sole service code root for legacy Doks without a service binding', () => {
    const legacyDok = {
      ...dok,
      surfaces: [],
      _meta: {
        version: 1,
        history: [],
        source_anchors: [{ file: 'app/page.tsx' }],
      },
    } as Dok;

    expect(projectDokDetail(legacyDok, workspace).anchors).toEqual([
      { file: 'apps/web/app/page.tsx', startLine: null, endLine: null, symbol: null },
    ]);
  });
});
