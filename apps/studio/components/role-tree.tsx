'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { KeyRound, UserRound } from 'lucide-react';
import type { Role } from '@doklo-beta/core';
import { useRoles, useStudio, resolveRoleName } from './studio-store';
import { groupRolesByKind, roleKindLabel } from '../lib/role-presentation';

/**
 * RoleTree — 240px left rail for the (editor)/roles/[id] route.
 *
 * Mirrors DokTree / TermTree in shape (group header + linked rows) so
 * the editor shell feels uniform across the three editors. Roles are
 * grouped first by schema `kind`; each row keeps scope as metadata. Empty
 * kind groups are omitted. Reads the real workspace roles.json via the
 * store — no synthetic scenarios.
 */
export function RoleTree() {
  const roles = useRoles();
  const { lexicon, projectLocales } = useStudio();
  const pathname = usePathname() ?? '';
  const activeId =
    pathname.startsWith('/roles/')
      ? decodeURIComponent(pathname.split('/').filter(Boolean)[1] ?? '')
      : null;
  const groups = groupRolesByKind(roles);

  return (
    <nav
      aria-label="Role tree"
      className="flex min-h-full w-60 shrink-0 flex-col overflow-y-auto border-r border-border bg-surface py-3"
    >
      {groups.map(({ kind, roles: rows }) => (
        <div key={kind} className="mb-1">
          <div className="flex items-center gap-2 px-4 pb-1.5 pt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
            {kind === 'access' ? (
              <KeyRound size={12} aria-hidden />
            ) : (
              <UserRound size={12} aria-hidden />
            )}
            <span>{roleKindLabel(kind)}</span>
            <span className="ml-auto font-mono text-[11px] text-ink-faint">
              {rows.length}
            </span>
          </div>
          <ul className="m-0 list-none p-0">
            {rows.map((role) => (
              <RoleRow
                key={role.role_id}
                role={role}
                label={resolveRoleName(role, lexicon, projectLocales)}
                active={role.role_id === activeId}
              />
            ))}
          </ul>
        </div>
      ))}
    </nav>
  );
}

function RoleRow({
  role,
  label,
  active,
}: {
  role: Role;
  label: string;
  active: boolean;
}) {
  return (
    <li className="m-0 p-0">
      <Link
        href={`/roles/${role.role_id}`}
        aria-current={active ? 'page' : undefined}
        aria-label={`${role.role_id} · ${label} · ${roleKindLabel(role.kind)} · ${role.scope}`}
        className={[
          'grid grid-cols-[minmax(0,1fr)_auto] items-center gap-2.5 px-4 py-2 text-[13px] no-underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          active
            ? 'bg-accent-soft font-medium text-accent-ink shadow-[inset_3px_0_0_var(--color-accent)]'
            : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
        ].join(' ')}
      >
        <span className="min-w-0">
          <span className="block truncate">{label}</span>
          <span
            className={[
              'mt-0.5 block truncate font-mono text-[9.5px] tracking-[0.02em]',
              active ? 'text-accent-ink/75' : 'text-ink-faint',
            ].join(' ')}
          >
            {role.role_id.replace(/^ROLE-/, '')}
          </span>
        </span>
        <span
          className={[
            'rounded-full border border-border px-1.5 py-0.5 font-mono text-[9.5px] tracking-[0.02em]',
            active ? 'text-accent-ink' : 'text-ink-faint',
          ].join(' ')}
        >
          {role.scope}
        </span>
      </Link>
    </li>
  );
}
