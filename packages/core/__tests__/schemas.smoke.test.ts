import { describe, it, expect } from 'vitest';
import {
  DokSchema,
  LexiconFileSchema,
  RoleSchema,
  RolesFileSchema,
  LexiconTermSchema,
  WorkspaceSchema,
  ServiceCodeMappingFileSchema,
  IaFileV1Schema,
  LLMResponseSchema,
} from '../src/schemas/index.js';

describe('Dok schema', () => {
  it('parses a minimal valid Dok with defaults', () => {
    const result = DokSchema.parse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
    });
    expect(result.status).toBe('draft');
    expect(result._meta.version).toBe(1);
    expect(result.tags).toEqual([]);
    expect(result.surfaces).toEqual([]);
  });

  it('parses a Dok with intent + variants pattern', () => {
    const result = DokSchema.parse({
      dok_id: 'CART',
      name: { term_ref: 'TERM-CART' },
      description: 'Shopping cart entry point',
      surfaces: ['web', 'mobile'],
      user_actions: {
        steps: [
          {
            order: 1,
            actor: { kind: 'role', role_ref: 'ROLE-USER' },
            intent: 'Enter cart',
            outcome: 'Cart screen visible',
            variants: [
              {
                platform: 'desktop',
                interaction: 'click',
                target: { term_ref: 'TERM-NAV-CART' },
              },
              {
                platform: 'mobile',
                interaction: 'tap',
                target: { term_ref: 'TERM-TAB-CART' },
              },
            ],
          },
        ],
      },
    });
    const step = result.user_actions?.steps[0];
    expect(step?.variants.length).toBe(2);
    expect(step?.variants[0]?.platform).toBe('desktop');
  });

  it('rejects malformed dok_id', () => {
    const result = DokSchema.safeParse({
      dok_id: 'invalid',
      name: 'x',
      description: 'short description here',
    });
    expect(result.success).toBe(false);
  });

  it('accepts a 2-segment semantic dok_id (e.g., PROG-MILE)', () => {
    const result = DokSchema.parse({
      dok_id: 'PROG-MILE',
      name: 'Milestone tracking',
      description: 'Tracks user progress milestones across the program.',
    });
    expect(result.dok_id).toBe('PROG-MILE');
  });

  it('preserves unknown fields at every persisted Dok object boundary', () => {
    const input = {
      dok_id: 'AUTH-SIGNUP',
      name: {
        term_ref: 'TERM-AUTH-SIGNUP',
        future_term_ref: 'keep',
      },
      description: 'Users can create an account with email and password.',
      future_root: { enabled: true },
      user_actions: {
        future_actions: 'keep',
        steps: [
          {
            order: 1,
            actor: {
              kind: 'role',
              role_ref: 'ROLE-USER',
              future_actor: 'role',
            },
            intent: 'Create an account',
            outcome: 'Account exists',
            future_step: 'keep',
            variants: [
              {
                platform: 'desktop',
                interaction: 'submit',
                code_anchor: {
                  file: 'src/auth/signup.ts',
                  future_code_anchor: { source: 'plugin' },
                },
                future_variant: 7,
              },
            ],
          },
          {
            order: 2,
            actor: { kind: 'system', future_actor: 'system' },
            intent: 'Validate the account',
            outcome: 'Account is validated',
          },
          {
            order: 3,
            actor: {
              kind: 'external',
              label: 'Email provider',
              future_actor: 'external',
            },
            intent: 'Deliver a confirmation',
            outcome: 'Confirmation is delivered',
          },
        ],
      },
      business_rules: {
        future_rules: true,
        rules: [
          {
            id: 'BR-AUTH-SIGNUP-01',
            description: 'Email addresses must be unique.',
            type: 'validation',
            code_anchor: {
              constant: 'AUTH.UNIQUE_EMAIL',
              future_code_anchor: 'rule',
            },
            future_rule: { source: 'policy' },
          },
        ],
      },
      acceptance_criteria: {
        future_criteria: ['keep'],
        criteria: [
          {
            id: 'AC-AUTH-SIGNUP-01',
            statement: 'A valid account can be created.',
            related_rules: ['BR-AUTH-SIGNUP-01'],
            future_criterion: 'keep',
          },
        ],
      },
      _meta: {
        version: 1,
        future_meta: 'keep',
        source_anchors: [
          {
            file: 'src/auth/signup.ts',
            future_source_anchor: 'source',
          },
        ],
        logic_files: [
          {
            file: 'src/auth/dependencies.ts',
            future_source_anchor: 'logic',
          },
        ],
        history: [
          {
            version: 1,
            date: '2026-07-17',
            change: 'Created',
            future_history: 'keep',
          },
        ],
      },
    };

    const reparsed = JSON.parse(JSON.stringify(DokSchema.parse(input)));

    expect(reparsed.future_root).toEqual({ enabled: true });
    expect(reparsed.name.future_term_ref).toBe('keep');
    expect(reparsed.user_actions.future_actions).toBe('keep');
    expect(reparsed.user_actions.steps[0].future_step).toBe('keep');
    expect(reparsed.user_actions.steps[0].actor.future_actor).toBe('role');
    expect(reparsed.user_actions.steps[1].actor.future_actor).toBe('system');
    expect(reparsed.user_actions.steps[2].actor.future_actor).toBe('external');
    expect(reparsed.user_actions.steps[0].variants[0].future_variant).toBe(7);
    expect(
      reparsed.user_actions.steps[0].variants[0].code_anchor.future_code_anchor,
    ).toEqual({ source: 'plugin' });
    expect(reparsed.business_rules.future_rules).toBe(true);
    expect(reparsed.business_rules.rules[0].future_rule).toEqual({ source: 'policy' });
    expect(reparsed.business_rules.rules[0].code_anchor.future_code_anchor).toBe('rule');
    expect(reparsed.acceptance_criteria.future_criteria).toEqual(['keep']);
    expect(reparsed.acceptance_criteria.criteria[0].future_criterion).toBe('keep');
    expect(reparsed._meta.future_meta).toBe('keep');
    expect(reparsed._meta.source_anchors[0].future_source_anchor).toBe('source');
    expect(reparsed._meta.logic_files[0].future_source_anchor).toBe('logic');
    expect(reparsed._meta.history[0].future_history).toBe('keep');
  });
});

describe('Persisted extension fields', () => {
  it('preserves Lexicon file, term, and every binding extension', () => {
    const input = {
      version: 1,
      future_file: { owner: 'plugin' },
      terms: [
        {
          term_id: 'TERM-I18N-EXTENSION',
          category: 'concept',
          binding: {
            type: 'i18n',
            key: 'extension.i18n',
            future_binding: 'i18n',
          },
          future_term: 'i18n',
        },
        {
          term_id: 'TERM-CONSTANT-EXTENSION',
          category: 'concept',
          binding: {
            type: 'constant',
            reference: 'src/extensions.ts:LABEL',
            future_binding: 'constant',
          },
          snapshot: { en: 'Extension' },
          future_term: 'constant',
        },
        {
          term_id: 'TERM-OWNED-EXTENSION',
          category: 'concept',
          binding: { type: 'owned', future_binding: 'owned' },
          locales: { en: 'Extension' },
          future_term: 'owned',
        },
      ],
    };

    const reparsed = JSON.parse(JSON.stringify(LexiconFileSchema.parse(input)));

    expect(reparsed.future_file).toEqual({ owner: 'plugin' });
    expect(reparsed.terms.map((term: { future_term: string }) => term.future_term))
      .toEqual(['i18n', 'constant', 'owned']);
    expect(reparsed.terms.map((term: { binding: { future_binding: string } }) => (
      term.binding.future_binding
    ))).toEqual(['i18n', 'constant', 'owned']);
  });

  it('preserves Role file, role, metadata, and extraction extensions', () => {
    const input = {
      version: 1,
      future_file: true,
      roles: [
        {
          role_id: 'ROLE-MENTOR',
          name: {
            term_ref: 'TERM-ROLE-MENTOR',
            future_term_ref: 'role',
          },
          code_anchor: {
            constant: 'ROLES.MENTOR',
            future_code_anchor: 'role',
          },
          future_role: { visible: true },
          _meta: {
            future_meta: 'keep',
            extraction: {
              confidence: 'high',
              evidence: ['types/mentor.d.ts:7'],
              future_extraction: 7,
            },
          },
        },
      ],
    };

    const reparsed = JSON.parse(JSON.stringify(RolesFileSchema.parse(input)));

    expect(reparsed.future_file).toBe(true);
    expect(reparsed.roles[0].future_role).toEqual({ visible: true });
    expect(reparsed.roles[0].name.future_term_ref).toBe('role');
    expect(reparsed.roles[0].code_anchor.future_code_anchor).toBe('role');
    expect(reparsed.roles[0]._meta.future_meta).toBe('keep');
    expect(reparsed.roles[0]._meta.extraction.future_extraction).toBe(7);
  });
});

describe('Dok _meta.source_anchors (deterministic provenance)', () => {
  it('preserves file-level source_anchors carried in _meta', () => {
    const result = DokSchema.parse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
      _meta: {
        version: 1,
        history: [],
        source_anchors: [
          { file: 'app/auth/signup/page.tsx' },
          { file: 'components/SignupForm.tsx' },
        ],
      },
    });
    expect(result._meta.source_anchors).toEqual([
      { file: 'app/auth/signup/page.tsx' },
      { file: 'components/SignupForm.tsx' },
    ]);
  });

  it('keeps source_anchors absent on a Dok that has none (optional)', () => {
    const result = DokSchema.parse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
    });
    expect(result._meta.source_anchors).toBeUndefined();
  });

  it('accepts the reserved symbol/line slots for the next anchor layer', () => {
    const result = DokSchema.parse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
      _meta: {
        version: 1,
        history: [],
        source_anchors: [
          { file: 'src/auth.ts', symbol: 'validateEmail', start_line: 23, end_line: 45 },
        ],
      },
    });
    expect(result._meta.source_anchors?.[0]?.symbol).toBe('validateEmail');
    expect(result._meta.source_anchors?.[0]?.start_line).toBe(23);
  });

  it('rejects a source_anchor with an empty file path', () => {
    const result = DokSchema.safeParse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
      _meta: { version: 1, history: [], source_anchors: [{ file: '' }] },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an inverted line range (end_line < start_line)', () => {
    const result = DokSchema.safeParse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
      _meta: {
        version: 1,
        history: [],
        source_anchors: [{ file: 'src/auth.ts', start_line: 45, end_line: 23 }],
      },
    });
    expect(result.success).toBe(false);
  });

  it('rejects an end_line without a start_line', () => {
    const result = DokSchema.safeParse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
      _meta: {
        version: 1,
        history: [],
        source_anchors: [{ file: 'src/auth.ts', end_line: 45 }],
      },
    });
    expect(result.success).toBe(false);
  });
});

describe('Dok _meta.edited_by_human (human-edit marker for sync skip)', () => {
  it('parses and preserves the marker when a human edit set it true', () => {
    const result = DokSchema.parse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
      _meta: { version: 1, history: [], edited_by_human: true },
    });
    expect(result._meta.edited_by_human).toBe(true);
  });

  it('leaves the marker undefined on a Dok that has none (optional)', () => {
    const result = DokSchema.parse({
      dok_id: 'AUTH-SIGNUP',
      name: 'Email signup',
      description: 'Users can create an account with email and password.',
    });
    expect(result._meta.edited_by_human).toBeUndefined();
  });
});

describe('Lexicon binding refines', () => {
  it('accepts owned binding with locales', () => {
    const result = LexiconTermSchema.parse({
      term_id: 'TERM-ERR-DUPLICATE',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { ko: '오류', en: 'Error' },
    });
    expect(result.term_id).toBe('TERM-ERR-DUPLICATE');
  });

  it('rejects owned binding without locales', () => {
    const result = LexiconTermSchema.safeParse({
      term_id: 'TERM-ERR',
      category: 'concept',
      binding: { type: 'owned' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects i18n binding carrying snapshot (i18n is SoT)', () => {
    const result = LexiconTermSchema.safeParse({
      term_id: 'TERM-NAV-HOME',
      category: 'concept',
      binding: { type: 'i18n', key: 'nav.home' },
      snapshot: { ko: '홈' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects locales on non-owned binding', () => {
    const result = LexiconTermSchema.safeParse({
      term_id: 'TERM-NAV-HOME',
      category: 'concept',
      binding: { type: 'i18n', key: 'nav.home' },
      locales: { ko: '홈' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts constant binding with snapshot', () => {
    const result = LexiconTermSchema.parse({
      term_id: 'TERM-BTN-SAVE',
      category: 'concept',
      binding: {
        type: 'constant',
        reference: 'src/constants/labels.ts:LABELS.SAVE',
      },
      snapshot: { ko: '저장' },
    });
    expect(result.binding.type).toBe('constant');
  });
});

describe('LexiconCategory (v5 narrowed)', () => {
  it('accepts domain categories', () => {
    for (const category of ['concept', 'role'] as const) {
      const r = LexiconTermSchema.safeParse({
        term_id: `TERM-CAT-${category.toUpperCase()}`,
        category,
        binding: { type: 'owned' },
        locales: { ko: '용어' },
      });
      expect(r.success).toBe(true);
    }
  });

  it('rejects legacy categories (UI-strings + merged feature)', () => {
    for (const category of ['navigation', 'button', 'error', 'label', 'message', 'feature']) {
      const r = LexiconTermSchema.safeParse({
        term_id: 'TERM-LEGACY',
        category,
        binding: { type: 'owned' },
        locales: { ko: 'x' },
      });
      expect(r.success).toBe(false);
    }
  });
});

describe('Workspace schema', () => {
  it('defaults to en + [en, ko] locales', () => {
    const result = WorkspaceSchema.parse({
      workspace_id: 'ws-1',
      name: 'My Workspace',
      services: [],
    });
    expect(result.default_locale).toBe('en');
    expect(result.supported_locales).toEqual(['en', 'ko']);
  });

  it('accepts services with framework + type', () => {
    const result = WorkspaceSchema.parse({
      workspace_id: 'ws-1',
      name: 'My Workspace',
      services: [
        { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: 'apps/web' },
        { service_id: 'api', type: 'backend', framework: 'spring-boot', code_root: 'apps/api' },
      ],
    });
    expect(result.services.length).toBe(2);
  });
});

describe('Role schema', () => {
  it('parses role with hierarchy and scope', () => {
    const result = RoleSchema.parse({
      role_id: 'ROLE-MANAGER',
      name: { term_ref: 'TERM-ROLE-MANAGER' },
      extends: ['ROLE-USER'],
      scope: 'tenant',
    });
    expect(result.extends).toEqual(['ROLE-USER']);
    expect(result.scope).toBe('tenant');
  });

  it('defaults legacy roles to access and preserves extraction provenance', () => {
    const legacy = RoleSchema.parse({ role_id: 'ROLE-ADMIN', name: 'Admin' });
    expect(legacy.kind).toBe('access');

    const actor = RoleSchema.parse({
      role_id: 'ROLE-MENTOR',
      name: 'Mentor',
      kind: 'actor_type',
      _meta: {
        extraction: {
          confidence: 'high',
          evidence: ['types/mentor.d.ts:7 — string-union'],
        },
      },
    });
    expect(actor.kind).toBe('actor_type');
    expect(actor._meta?.extraction?.confidence).toBe('high');
  });
});

describe('Service code mapping', () => {
  it('captures consumes_apis (web) and exposes_apis (api)', () => {
    const web = ServiceCodeMappingFileSchema.parse({
      service_id: 'web',
      entries: [
        {
          dok_id: 'AUTH-SIGNUP',
          consumes_apis: [{ method: 'POST', endpoint: '/auth/signup' }],
        },
      ],
    });
    expect(web.entries[0]?.consumes_apis?.[0]?.endpoint).toBe('/auth/signup');

    const api = ServiceCodeMappingFileSchema.parse({
      service_id: 'api',
      entries: [
        {
          dok_id: 'AUTH-SIGNUP',
          exposes_apis: [{ method: 'POST', endpoint: '/auth/signup' }],
        },
      ],
    });
    expect(api.entries[0]?.exposes_apis?.[0]?.endpoint).toBe('/auth/signup');
  });

  it('rejects duplicate Dok entries', () => {
    const result = ServiceCodeMappingFileSchema.safeParse({
      service_id: 'web',
      entries: [
        { dok_id: 'AUTH-SIGNUP' },
        { dok_id: 'AUTH-SIGNUP' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate file paths within one Dok entry', () => {
    const result = ServiceCodeMappingFileSchema.safeParse({
      service_id: 'web',
      entries: [{
        dok_id: 'AUTH-SIGNUP',
        files: [
          { path: 'src/auth.ts' },
          { path: 'src/auth.ts' },
        ],
      }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown keys instead of stripping persisted mapping data', () => {
    const result = ServiceCodeMappingFileSchema.safeParse({
      service_id: 'web',
      entries: [{ dok_id: 'AUTH-SIGNUP', unexpected: true }],
    });

    expect(result.success).toBe(false);
  });
});

describe('IA file (frozen v1)', () => {
  it('supports platform-specific trees within one service', () => {
    const result = IaFileV1Schema.parse({
      service_id: 'web',
      trees: [
        { tree_id: 'nav-desktop', platform: 'desktop', nodes: [] },
        { tree_id: 'nav-mobile', platform: 'mobile', nodes: [] },
      ],
    });
    expect(result.trees.length).toBe(2);
    expect(result.trees.map((t) => t.platform)).toEqual(['desktop', 'mobile']);
  });

  it('allows recursive tree nodes', () => {
    const result = IaFileV1Schema.parse({
      service_id: 'web',
      trees: [
        {
          tree_id: 'nav-main',
          nodes: [
            {
              path: '/dashboard',
              label: 'Dashboard',
              dok_ref: 'DASH',
              children: [
                { path: '/dashboard/analytics', label: 'Analytics', dok_ref: 'ANALYTICS' },
              ],
            },
          ],
        },
      ],
    });
    expect(result.trees[0]?.nodes[0]?.children[0]?.dok_ref).toBe('ANALYTICS');
  });

  it('accepts node-level platform that narrows the tree-level platform', () => {
    const result = IaFileV1Schema.parse({
      service_id: 'web',
      trees: [
        {
          tree_id: 'nav-main',
          platform: 'all',
          nodes: [
            { path: '/admin', label: 'Admin', platform: 'desktop' },
            { path: '/quick', label: 'Quick actions', platform: 'mobile' },
          ],
        },
      ],
    });
    expect(result.trees[0]?.nodes[0]?.platform).toBe('desktop');
    expect(result.trees[0]?.nodes[1]?.platform).toBe('mobile');
  });

  it('rejects an unknown platform value on a node', () => {
    const result = IaFileV1Schema.safeParse({
      service_id: 'web',
      trees: [
        {
          tree_id: 'nav-main',
          nodes: [{ path: '/x', label: 'x', platform: 'smartwatch' }],
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('accepts tags annotation on a node and defaults to empty', () => {
    const result = IaFileV1Schema.parse({
      service_id: 'web',
      trees: [
        {
          tree_id: 'nav-main',
          nodes: [
            { path: '/new', label: 'New', tags: ['v2.0', 'experimental'] },
            { path: '/legacy', label: 'Legacy' },
          ],
        },
      ],
    });
    expect(result.trees[0]?.nodes[0]?.tags).toEqual(['v2.0', 'experimental']);
    expect(result.trees[0]?.nodes[1]?.tags).toEqual([]);
  });

  it('rejects duplicate tree IDs', () => {
    const result = IaFileV1Schema.safeParse({
      service_id: 'web',
      trees: [
        { tree_id: 'web-nav' },
        { tree_id: 'web-nav' },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects duplicate paths anywhere within one tree', () => {
    const result = IaFileV1Schema.safeParse({
      service_id: 'web',
      trees: [{
        tree_id: 'web-nav',
        nodes: [
          {
            path: '/auth',
            label: 'Auth parent',
            children: [{ path: '/auth', label: 'Auth child' }],
          },
        ],
      }],
    });

    expect(result.success).toBe(false);
  });

  it('rejects unknown keys instead of stripping persisted IA data', () => {
    const result = IaFileV1Schema.safeParse({
      service_id: 'web',
      trees: [{
        tree_id: 'web-nav',
        nodes: [{ path: '/auth', label: 'Auth', unexpected: true }],
      }],
    });

    expect(result.success).toBe(false);
  });
});

describe('LLM response schema', () => {
  it('accepts a minimal LLM response', () => {
    const result = LLMResponseSchema.parse({
      doks: [
        {
          dok_id: 'AUTH-SIGNUP',
          name: 'Email signup',
          description: 'Account creation flow.',
        },
      ],
    });
    expect(result.doks.length).toBe(1);
    expect(result.proposed_roles).toEqual([]);
    expect(result.proposed_lexicon_terms).toEqual([]);
  });

  it('materializes exactly the proposal fields the pipeline still consumes', () => {
    const result = LLMResponseSchema.parse({ doks: [] });

    // Pins the whole envelope: IA v2 retires edge proposals, so no field beyond
    // these five may reappear without this test being updated deliberately.
    expect(Object.keys(result).sort()).toEqual([
      'doks',
      'proposed_code_mappings',
      'proposed_ia_trees',
      'proposed_lexicon_terms',
      'proposed_roles',
    ]);
  });
});
