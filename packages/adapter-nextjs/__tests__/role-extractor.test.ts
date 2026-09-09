import { describe, it, expect } from 'vitest';
import type { ProjectIR, RoleId, RoleSignalIR } from '@doklo-beta/core';
import {
  extractRoleCandidates,
  mergeRoleCandidateSets,
  RoleKindConflictError,
  suggestRoleFromRoutePath,
  type RoleCandidate,
} from '../src/role-extractor.js';

function ir(overrides: Partial<ProjectIR> = {}): ProjectIR {
  return {
    framework: 'nextjs',
    root: '/proj',
    files: [],
    routes: [],
    components: [],
    stores: [],
    role_signals: [],
    ...overrides,
  };
}

function page(path: string) {
  return { path, kind: 'page' as const, file: `app${path}/page.tsx`, dynamic_params: [], layout_chain: [] };
}

function apiRoute(path: string) {
  return { path, kind: 'api' as const, file: `app${path}/route.ts`, dynamic_params: [], layout_chain: [] };
}

function roleSignal(value: string, overrides: Partial<RoleSignalIR> = {}): RoleSignalIR {
  return {
    value,
    kind: 'actor_type',
    source: 'explicit',
    file: 'models/identity.ts',
    line: 1,
    detector: 'identity-role-union',
    ...overrides,
  };
}

function candidate(project: ProjectIR, roleId: RoleId): RoleCandidate {
  const found = extractRoleCandidates(project).find((role) => role.role_id === roleId);
  expect(found).toBeDefined();
  return found!;
}

describe('extractRoleCandidates', () => {
  it('emits ROLE-USER as the baseline even with zero routes', () => {
    const out = extractRoleCandidates(ir());
    const ids = out.map((r) => r.role_id);
    expect(ids).toContain('ROLE-USER');
    expect(out.find((r) => r.role_id === 'ROLE-USER')?.confidence).toBe('high');
    expect(out.find((r) => r.role_id === 'ROLE-USER')?.kind).toBe('access');
  });

  it('keeps path-only access candidates low regardless of route count', () => {
    const pathOnlyAdmin = ir({
      routes: [
        page('/admin/a'),
        page('/admin/b'),
        page('/admin/c'),
        page('/admin/d'),
        page('/admin/e'),
      ],
    });

    expect(candidate(pathOnlyAdmin, 'ROLE-ADMIN').confidence).toBe('low');
  });

  it('extracts explicit actor types with high confidence', () => {
    const explicitMentor = ir({ role_signals: [roleSignal('mentor')] });
    const mentor = candidate(explicitMentor, 'ROLE-MENTOR');

    expect(mentor.kind).toBe('actor_type');
    expect(mentor.confidence).toBe('high');
  });

  it('extracts middleware-only access roles with medium confidence', () => {
    const middlewareManager = ir({
      role_signals: [
        roleSignal('manager', {
          kind: 'access',
          source: 'middleware',
          file: 'middleware.ts',
          detector: 'auth-role-comparison',
        }),
      ],
    });

    expect(candidate(middlewareManager, 'ROLE-MANAGER').confidence).toBe('medium');
  });

  it('retains source and route evidence for the same role', () => {
    const explicitAndPathAdmin = ir({
      routes: [page('/admin/users')],
      role_signals: [
        roleSignal('admin', {
          kind: 'access',
          file: 'auth.ts',
          line: 12,
        }),
      ],
    });

    expect(candidate(explicitAndPathAdmin, 'ROLE-ADMIN').evidence).toEqual(
      expect.arrayContaining([
        expect.stringContaining('auth.ts:12'),
        expect.stringContaining('/admin'),
      ]),
    );
  });

  it('promotes middleware confidence when independent route evidence corroborates it', () => {
    const corroboratedManager = ir({
      routes: [page('/manager/users')],
      role_signals: [
        roleSignal('manager', {
          kind: 'access',
          source: 'middleware',
          file: 'middleware.ts',
          detector: 'auth-role-comparison',
        }),
      ],
    });

    expect(candidate(corroboratedManager, 'ROLE-MANAGER').confidence).toBe('high');
  });

  it('normalizes valid signal values and omits invalid RoleIds', () => {
    const out = extractRoleCandidates(
      ir({
        role_signals: [
          roleSignal('customer success'),
          roleSignal('123'),
        ],
      }),
    );

    expect(out.map((role) => role.role_id)).toContain('ROLE-CUSTOMER-SUCCESS');
    expect(out.map((role) => role.role_id)).not.toContain('ROLE-123');
  });

  it('counts /api/admin/* the same as /admin/* (strips api prefix)', () => {
    const out = extractRoleCandidates(
      ir({
        routes: [
          apiRoute('/api/admin/users'),
          apiRoute('/api/admin/banner'),
        ],
      }),
    );
    expect(out.find((r) => r.role_id === 'ROLE-ADMIN')?.confidence).toBe('low');
  });

  it('is case-insensitive on the segment ("/Admin/" still matches)', () => {
    const out = extractRoleCandidates(
      ir({ routes: [page('/Admin/banner'), page('/Admin/users')] }),
    );
    expect(out.find((r) => r.role_id === 'ROLE-ADMIN')).toBeDefined();
  });

  it('detects multiple roles independently (admin + editor)', () => {
    const out = extractRoleCandidates(
      ir({
        routes: [
          page('/admin/a'),
          page('/admin/b'),
          page('/editor/list'),
        ],
      }),
    );
    const ids = out.map((r) => r.role_id).sort();
    expect(ids).toEqual(['ROLE-ADMIN', 'ROLE-EDITOR', 'ROLE-USER']);
  });

  it('ignores route segments that are not in the known role-prefix table', () => {
    const out = extractRoleCandidates(
      ir({ routes: [page('/program/list'), page('/company/x'), page('/inbox/y')] }),
    );
    expect(out).toHaveLength(1);
    expect(out[0]?.role_id).toBe('ROLE-USER');
  });

  it('packs matching paths into the evidence field for human review', () => {
    const out = extractRoleCandidates(
      ir({ routes: [page('/admin/banner'), page('/admin/users')] }),
    );
    const admin = out.find((r) => r.role_id === 'ROLE-ADMIN');
    expect(admin?.evidence.join(' ')).toContain('/admin/banner');
    expect(admin?.evidence.join(' ')).toContain('/admin/users');
  });

  it('truncates evidence to a reasonable preview when many routes match', () => {
    const routes = Array.from({ length: 20 }, (_, i) => page(`/admin/r${i}`));
    const out = extractRoleCandidates(ir({ routes }));
    const admin = out.find((r) => r.role_id === 'ROLE-ADMIN');
    // Evidence string mentions the 20 count somewhere
    expect(admin?.evidence.join(' ')).toMatch(/20/);
    // Doesn't dump all 20 paths into the evidence
    const dumpedCount = (admin?.evidence.join(' ').match(/\/admin\/r\d+/g) ?? []).length;
    expect(dumpedCount).toBeLessThanOrEqual(10);
  });

  it('does not match the literal segment "api" itself as a role', () => {
    const out = extractRoleCandidates(ir({ routes: [page('/api/something')] }));
    // /api isn't a role; the second segment "something" isn't either.
    expect(out.map((r) => r.role_id)).toEqual(['ROLE-USER']);
  });

  it('omits ROLE-* candidates whose RoleId pattern would be invalid', () => {
    // sanity: every emitted role_id must satisfy the schema regex.
    const out = extractRoleCandidates(
      ir({ routes: [page('/admin/a'), page('/editor/b'), page('/manager/c')] }),
    );
    for (const r of out) {
      expect(r.role_id).toMatch(/^ROLE-[A-Z][A-Z0-9_-]*$/);
    }
  });
});

describe('mergeRoleCandidateSets', () => {
  it('promotes corroborating source classes across service candidate sets', () => {
    const pathAdmin: RoleCandidate = {
      role_id: 'ROLE-ADMIN',
      name: 'Administrator',
      kind: 'access',
      confidence: 'low',
      evidence: ['routes (1): /admin/users'],
    };
    const middlewareAdmin: RoleCandidate = {
      ...pathAdmin,
      confidence: 'medium',
      evidence: ['middleware.ts:8 — auth-role-comparison (middleware)'],
    };

    expect(mergeRoleCandidateSets([[pathAdmin], [middlewareAdmin]])[0]?.confidence).toBe('high');
  });

  it('uses strongest confidence and stable deduplicated evidence across services', () => {
    const lowAdmin: RoleCandidate = {
      role_id: 'ROLE-ADMIN',
      name: 'Administrator',
      kind: 'access',
      confidence: 'low',
      evidence: ['b', 'a'],
    };
    const highAdmin: RoleCandidate = {
      ...lowAdmin,
      confidence: 'high',
      evidence: ['a'],
    };

    const merged = mergeRoleCandidateSets([[lowAdmin], [highAdmin]]);

    expect(merged[0]?.confidence).toBe('high');
    expect(merged[0]?.evidence).toEqual(['a', 'b']);
  });

  it('sorts merged candidates by role ID', () => {
    const mentor: RoleCandidate = {
      role_id: 'ROLE-MENTOR',
      name: 'Mentor',
      kind: 'actor_type',
      confidence: 'high',
      evidence: ['mentor'],
    };
    const admin: RoleCandidate = {
      role_id: 'ROLE-ADMIN',
      name: 'Administrator',
      kind: 'access',
      confidence: 'low',
      evidence: ['admin'],
    };

    expect(mergeRoleCandidateSets([[mentor, admin]]).map((role) => role.role_id)).toEqual([
      'ROLE-ADMIN',
      'ROLE-MENTOR',
    ]);
  });

  it('throws on contradictory kinds for a non-access role ID', () => {
    const mentorAsAccess: RoleCandidate = {
      role_id: 'ROLE-MENTOR',
      name: 'Mentor',
      kind: 'access',
      confidence: 'medium',
      evidence: ['a'],
    };
    const mentorAsActor: RoleCandidate = {
      ...mentorAsAccess,
      kind: 'actor_type',
      confidence: 'high',
      evidence: ['b'],
    };

    expect(() => mergeRoleCandidateSets([[mentorAsAccess], [mentorAsActor]])).toThrow(
      RoleKindConflictError,
    );
  });

  it('keeps access for known access IDs when candidate kinds conflict', () => {
    const adminAsActor: RoleCandidate = {
      role_id: 'ROLE-ADMIN',
      name: 'Administrator',
      kind: 'actor_type',
      confidence: 'high',
      evidence: ['actor'],
    };
    const adminAsAccess: RoleCandidate = {
      ...adminAsActor,
      kind: 'access',
      confidence: 'medium',
      evidence: ['access'],
    };

    const [admin] = mergeRoleCandidateSets([[adminAsActor], [adminAsAccess]]);
    expect(admin?.kind).toBe('access');
    expect(admin?.evidence).toEqual(['access', 'actor']);
  });
});

describe('suggestRoleFromRoutePath', () => {
  it('maps /admin/* to ROLE-ADMIN', () => {
    expect(suggestRoleFromRoutePath('/admin/users')).toBe('ROLE-ADMIN');
    expect(suggestRoleFromRoutePath('/admin/banner/edit')).toBe('ROLE-ADMIN');
  });

  it('maps /editor/* to ROLE-EDITOR', () => {
    expect(suggestRoleFromRoutePath('/editor/list')).toBe('ROLE-EDITOR');
  });

  it('strips /api/ prefix when matching', () => {
    expect(suggestRoleFromRoutePath('/api/admin/users')).toBe('ROLE-ADMIN');
  });

  it('returns null for unknown segments', () => {
    expect(suggestRoleFromRoutePath('/program/list')).toBeNull();
    expect(suggestRoleFromRoutePath('/auth/signin')).toBeNull();
    expect(suggestRoleFromRoutePath('/')).toBeNull();
  });

  it('is case-insensitive', () => {
    expect(suggestRoleFromRoutePath('/Admin/x')).toBe('ROLE-ADMIN');
  });

  it('uses extracted actor roles as dynamic route hints', () => {
    expect(suggestRoleFromRoutePath('/mentor/profile', ['ROLE-MENTOR'])).toBe('ROLE-MENTOR');
    expect(suggestRoleFromRoutePath('/program/list', ['ROLE-MENTOR'])).toBeNull();
  });
});
