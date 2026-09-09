import { describe, expect, it } from 'vitest';
import type { Role } from '@doklo-beta/core';
import {
  groupRolesByKind,
  roleKindLabel,
} from '../lib/role-presentation';

const access: Role = {
  role_id: 'ROLE-ADMIN',
  name: 'Admin',
  kind: 'access',
  extends: [],
  scope: 'global',
};

const actor: Role = {
  role_id: 'ROLE-CUSTOMER',
  name: 'Customer',
  kind: 'actor_type',
  extends: [],
  scope: 'global',
};

describe('role presentation', () => {
  it('groups roles in stable kind-first order', () => {
    expect(groupRolesByKind([actor, access])).toEqual([
      { kind: 'access', roles: [access] },
      { kind: 'actor_type', roles: [actor] },
    ]);
  });

  it('preserves catalog order within each kind', () => {
    const manager: Role = {
      ...access,
      role_id: 'ROLE-MANAGER',
      name: 'Manager',
    };

    expect(groupRolesByKind([actor, manager, access])).toEqual([
      { kind: 'access', roles: [manager, access] },
      { kind: 'actor_type', roles: [actor] },
    ]);
  });

  it('uses human-readable kind labels', () => {
    expect(roleKindLabel('access')).toBe('Access');
    expect(roleKindLabel('actor_type')).toBe('Actor type');
  });
});
