// @vitest-environment jsdom

import * as React from 'react';
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../components/studio-store', () => ({
  useRoles: () => [
    {
      role_id: 'ROLE-CUSTOMER',
      name: 'Customer',
      kind: 'actor_type',
      extends: [],
      scope: 'global',
    },
    {
      role_id: 'ROLE-ADMIN',
      name: 'Admin',
      kind: 'access',
      extends: [],
      scope: 'global',
    },
  ],
  useRoleStats: () => ({
    total: 2,
    access: 1,
    actorType: 1,
    global: 2,
    tenant: 0,
    resource: 0,
    withAnchor: 0,
  }),
  useStudio: () => ({
    rolesState: {
      kind: 'ready',
      path: '/workspace/.doklo/hub/roles.json',
      revision: 'roles-revision',
      data: { version: 1, roles: [] },
    },
    lexicon: [],
    projectLocales: ['en'],
    selectedRoleId: 'ROLE-ADMIN',
    setSelectedRoleId: vi.fn(),
  }),
  resolveRoleName: (role: { name: string }) => role.name,
}));

vi.mock('../components/role-preview', () => ({
  RolePreview: () => null,
}));

vi.mock('../lib/hooks/use-deep-link-sync', () => ({
  useRoleDeepLink: () => undefined,
}));

vi.mock('../lib/hooks/use-list-keyboard-nav', () => ({
  useListKeyboardNav: () => ({ onKeyDown: vi.fn() }),
}));

import RolesPage from '../app/(hub)/roles/page';

beforeEach(() => {
  document.body.replaceChildren();
  vi.stubGlobal('React', React);
  (
    globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
});

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('RolesPage', () => {
  it('renders kind-first accessible sections around each role group', async () => {
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(createElement(RolesPage));
    });

    const sections = [...host.querySelectorAll('section')];
    expect(sections).toHaveLength(2);
    expect(sections.map((section) => section.querySelector('h2')?.textContent)).toEqual([
      'Access',
      'Actor type',
    ]);
    expect(
      sections.map((section) => section.getAttribute('aria-labelledby')),
    ).toEqual(['roles-kind-access', 'roles-kind-actor_type']);
    expect(
      sections.map((section) => section.querySelector('h2')?.id),
    ).toEqual(['roles-kind-access', 'roles-kind-actor_type']);
    expect(
      sections.map(
        (section) => section.querySelector<HTMLElement>('[data-row-id]')?.dataset.rowId,
      ),
    ).toEqual(['ROLE-ADMIN', 'ROLE-CUSTOMER']);

    await act(async () => {
      root.unmount();
    });
  });
});
