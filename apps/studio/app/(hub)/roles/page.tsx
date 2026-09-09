'use client';

import { KeyRound, UserRound, Users } from 'lucide-react';
import type { Role } from '@doklo-beta/core';
import {
  useRoles,
  useRoleStats,
  useStudio,
  resolveRoleName,
} from '../../../components/studio-store';
import { SmartSidebar } from '../../../components/smart-sidebar';
import { RolePreview } from '../../../components/role-preview';
import { useRoleDeepLink } from '../../../lib/hooks/use-deep-link-sync';
import { useListKeyboardNav } from '../../../lib/hooks/use-list-keyboard-nav';
import {
  groupRolesByKind,
  roleKindLabel,
} from '../../../lib/role-presentation';
import { LoadRecovery } from '../../../components/load-recovery';

const SCOPE_TAG: Record<Role['scope'], string> = {
  global:   'bg-accent-soft text-accent-ink',
  tenant:   'bg-status-draft-bg text-status-draft-fg',
  resource: 'bg-status-review-bg text-status-review-fg',
};

export default function RolesPage() {
  const { rolesState } = useStudio();
  if (rolesState.kind === 'invalid' || rolesState.kind === 'unreadable') {
    return <LoadRecovery layer="roles" state={rolesState} />;
  }
  return <RolesReady />;
}

function RolesReady() {
  useRoleDeepLink();
  const roles = useRoles();
  const stats = useRoleStats();
  const { lexicon, projectLocales, selectedRoleId, setSelectedRoleId } =
    useStudio();
  const groups = groupRolesByKind(roles);
  const displayedRoles = groups.flatMap((group) => group.roles);

  // ↑/↓ follow the same kind-first order shown on screen.
  const listNav = useListKeyboardNav({
    items: displayedRoles,
    selectedId: selectedRoleId,
    getKey: (r) => r.role_id,
    onSelect: setSelectedRoleId,
  });

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="border-b border-border bg-canvas px-8 pb-4 pt-6">
          <div className="mb-1 flex items-center gap-2.5">
            <Users size={18} aria-hidden className="text-ink-muted" />
            <h1 className="text-[22px] font-semibold tracking-tight text-ink-strong">
              Roles
            </h1>
          </div>
          <p className="max-w-[680px] text-[13.5px] text-ink-muted">
            Kind shows whether a role represents an actor or grants access;
            scope shows where it applies. Both are stored in roles.json.
          </p>
          <div className="mt-3.5 flex flex-wrap items-baseline gap-x-[22px] gap-y-1 font-mono text-xs text-ink-muted">
            <Stat n={String(stats.total)} label="roles" />
            <Stat n={String(stats.access)} label="access" />
            <Stat n={String(stats.actorType)} label="actor types" />
            <Stat n={String(stats.global)} label="global" />
            <Stat n={String(stats.tenant)} label="tenant" />
            {stats.resource > 0 && (
              <Stat n={String(stats.resource)} label="resource" />
            )}
            <Stat n={String(stats.withAnchor)} label="code-anchored" tone="accent" />
          </div>
        </header>

        {roles.length === 0 ? (
          <EmptyCatalog />
        ) : (
          <div
            tabIndex={-1}
            onKeyDown={listNav.onKeyDown}
            className="flex flex-col gap-6 px-8 py-6 outline-none"
          >
            {groups.map(({ kind, roles: rows }) => {
              const headingId = `roles-kind-${kind}`;
              return (
                <section key={kind} aria-labelledby={headingId}>
                  <div className="mb-2.5 flex items-center gap-2 text-ink-muted">
                    {kind === 'access' ? (
                      <KeyRound size={14} aria-hidden />
                    ) : (
                      <UserRound size={14} aria-hidden />
                    )}
                    <h2
                      id={headingId}
                      className="text-[13px] font-semibold text-ink-secondary"
                    >
                      {roleKindLabel(kind)}
                    </h2>
                    <span className="font-mono text-[11px] text-ink-faint">
                      {rows.length}
                    </span>
                  </div>
                  <div className="flex flex-col gap-px">
                    {rows.map((role) => (
                      <RoleRow
                        key={role.role_id}
                        role={role}
                        name={resolveRoleName(role, lexicon, projectLocales)}
                        selected={role.role_id === selectedRoleId}
                        onSelect={() => setSelectedRoleId(role.role_id)}
                      />
                    ))}
                  </div>
                </section>
              );
            })}
          </div>
        )}
      </main>
      <SmartSidebar>
        <RolePreview />
      </SmartSidebar>
    </div>
  );
}

/** Shown when a workspace has zero roles and therefore no roles.json.
 *  Mirrors the Doks/consolidation "Run doklo generate" block. */
function EmptyCatalog() {
  return (
    <div className="flex items-center justify-center px-8 py-20 text-center text-ink-muted">
      <div>
        <p className="text-sm">No roles in this workspace.</p>
        <p className="mt-1 text-xs">
          Run <code>doklo generate</code> to extract them from code.
        </p>
      </div>
    </div>
  );
}

function RoleRow({
  role,
  name,
  selected,
  onSelect,
}: {
  role: Role;
  name: string;
  selected: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      data-row-id={role.role_id}
      aria-pressed={selected}
      onClick={onSelect}
      className={[
        'block w-full rounded-md border px-4 py-3 text-left transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        selected
          ? 'border-accent bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]'
          : 'border-border bg-surface hover:border-border-strong',
      ].join(' ')}
    >
      <div className="flex flex-wrap items-center gap-2.5">
        <span className="flex-shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
          {role.role_id}
        </span>
        <span className="min-w-0 basis-48 flex-1 truncate text-[15px] font-semibold tracking-tight text-ink-strong">
          {name}
        </span>
        <span className="inline-flex flex-shrink-0 items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
          {role.kind === 'access' ? (
            <KeyRound size={11} aria-hidden />
          ) : (
            <UserRound size={11} aria-hidden />
          )}
          {roleKindLabel(role.kind)}
        </span>
        <span
          className={[
            'flex-shrink-0 rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
            SCOPE_TAG[role.scope],
          ].join(' ')}
        >
          {role.scope}
        </span>
      </div>
      <div className="mt-1.5 flex items-center gap-2 font-mono text-[11px] text-ink-faint">
        <span className={role.extends.length === 0 ? 'opacity-55' : ''}>
          extends →{' '}
          <span className="text-ink-secondary">
            {role.extends.length === 0 ? 'none (base)' : role.extends.join(', ')}
          </span>
        </span>
        {role.code_anchor?.constant && (
          <span className="ml-auto truncate text-ink-muted">
            {role.code_anchor.constant}
          </span>
        )}
      </div>
    </button>
  );
}

function Stat({
  n,
  label,
  tone,
}: {
  n: string;
  label: string;
  tone?: 'accent';
}) {
  const cls = tone === 'accent' ? 'text-accent' : 'text-ink';
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`text-sm font-semibold ${cls}`}>{n}</span>
      <span>{label}</span>
    </span>
  );
}
