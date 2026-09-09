'use client';

import { useCallback } from 'react';
import { KeyRound, Lock, Search, UserRound } from 'lucide-react';
import type { Role, RoleKind, RoleScope } from '@doklo-beta/core';
import {
  useStudio,
  useRoleActorDoks,
  resolveRoleName,
} from './studio-store';
import { saveRoleAction, type RoleEditPatch } from '../lib/actions';
import { useFocusContext } from '../lib/hooks/use-focus-context';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import { useDurableSave } from '../lib/hooks/use-durable-save';
import { roleKindLabel } from '../lib/role-presentation';

const SCOPES: RoleScope[] = ['global', 'tenant', 'resource'];

const SCOPE_BADGE: Record<RoleScope, string> = {
  global:   'bg-accent-soft text-accent-ink',
  tenant:   'bg-status-draft-bg text-status-draft-fg',
  resource: 'bg-status-review-bg text-status-review-fg',
};

/**
 * RoleEditor — main pane of the role-editor route. Edits the schema
 * editable fields of a single workspace Role through a narrow, revision-
 * checked patch. Extraction provenance stays visible and read-only.
 */
export function RoleEditor() {
  const {
    editingRole,
    updateEditingRole,
    roles,
    lexicon,
    projectLocales,
    rolesState,
  } = useStudio();
  const { handlers, clearFocus } = useFocusContext();
  const actorDoks = useRoleActorDoks(editingRole?.role_id ?? null);
  const roleId = editingRole?.role_id ?? '';
  const exactRevision =
    rolesState.kind === 'ready' || rolesState.kind === 'empty'
      ? rolesState.revision
      : '';
  const persist = useCallback(
    (patch: RoleEditPatch, expectedRevision: string) =>
      saveRoleAction({ roleId, patch, expectedRevision }),
    [roleId],
  );
  const durable = useDurableSave<RoleEditPatch>({
    key: `role:${roleId}`,
    path: rolesState.path,
    initialRevision: exactRevision,
    merge: mergeRolePatch,
    persist,
  });
  const updateRole = useCallback((patch: RoleEditPatch) => {
    updateEditingRole(patch);
    durable.queue(patch);
  }, [durable, updateEditingRole]);

  if (!editingRole) return null;
  const role = editingRole;

  return (
    <article
      onClick={(e) => {
        if (e.target === e.currentTarget) clearFocus();
      }}
      className="mx-auto w-full max-w-[760px] px-10 pb-20 pt-8"
    >
      {/* ─── Header ─── */}
      <header className="mb-8">
        <div className="mb-3 flex flex-wrap items-center gap-2.5">
          <span className="rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
            {role.role_id}
          </span>
          <KindBadge kind={role.kind} />
          <span
            className={[
              'rounded-full px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em]',
              SCOPE_BADGE[role.scope],
            ].join(' ')}
          >
            {role.scope}
          </span>
          <button
            type="button"
            {...handlers({ kind: 'actor_in' })}
            className="ml-auto font-mono text-[11px] text-ink-muted hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            actor in <span className="font-semibold text-ink">{actorDoks.length}</span> doks
          </button>
        </div>

        {/* Name block */}
        <NameBlock
          role={role}
          resolvedName={resolveRoleName(role, lexicon, projectLocales)}
          onFocusName={handlers({ kind: 'name' }).onFocus}
          onUpdate={updateRole}
        />
      </header>

      {/* ─── Description ─── */}
      <Section label="Description" hint="What this role is and what it can do">
        <textarea
          value={role.description ?? ''}
          onChange={(e) =>
            updateRole({ description: e.target.value || undefined })
          }
          {...handlers({ kind: 'description' })}
          rows={3}
          spellCheck={false}
          placeholder="Describe this role…"
          className="w-full resize-y rounded-md border border-border bg-surface px-3.5 py-3 text-[13.5px] leading-relaxed text-ink-strong placeholder:text-ink-faint hover:border-border-strong focus:border-accent focus:bg-canvas focus:outline-none"
        />
      </Section>

      {/* ─── Kind ─── */}
      <Section label="Role kind" hint="Actor identity and access are separate axes">
        <div
          role="group"
          aria-label="Role kind"
          className="inline-flex max-w-full flex-wrap rounded-md border border-border bg-surface p-1"
        >
          {(['access', 'actor_type'] as const).map((kind) => (
            <button
              key={kind}
              type="button"
              aria-pressed={role.kind === kind}
              onClick={() => updateRole({ kind })}
              className={[
                'inline-flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-[12.5px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                role.kind === kind
                  ? 'bg-accent-soft font-medium text-accent-ink shadow-sm'
                  : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
              ].join(' ')}
            >
              {kind === 'access' ? (
                <KeyRound size={13} aria-hidden />
              ) : (
                <UserRound size={13} aria-hidden />
              )}
              {roleKindLabel(kind)}
            </button>
          ))}
        </div>
        <p className="mt-2 max-w-[65ch] text-[12px] leading-relaxed text-ink-muted">
          {role.kind === 'access'
            ? 'Access roles describe permission levels and may use inheritance.'
            : 'Actor types name who acts in a product flow; scope still describes where they apply.'}
        </p>
      </Section>

      {/* ─── Scope ─── */}
      <Section label="Scope" hint="How far this role applies">
        <div
          className="inline-flex rounded-full border border-border bg-surface p-0.5"
          {...handlers({ kind: 'scope' })}
        >
          {SCOPES.map((s) => (
            <button
              key={s}
              type="button"
              aria-pressed={role.scope === s}
              onClick={() => updateRole({ scope: s })}
              className={[
                'rounded-full px-3 py-1 font-mono text-[12px] transition-colors',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                role.scope === s
                  ? 'bg-accent-soft font-medium text-accent-ink'
                  : 'text-ink-secondary hover:text-ink',
              ].join(' ')}
            >
              {s}
            </button>
          ))}
        </div>
      </Section>

      {/* ─── Extends ─── */}
      <Section
        label="Extends · inheritance"
        count={role.extends.length === 0 ? 'base role' : `${role.extends.length} parent`}
        hint={
          role.kind === 'actor_type'
            ? 'Stored as-is; hierarchy is primarily for access roles'
            : 'RBAC parents this role inherits from'
        }
      >
        <button
          type="button"
          {...handlers({ kind: 'extends' })}
          className={[
            'block w-full rounded-md border px-4 py-3.5 text-left transition-colors',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
            role.kind === 'actor_type'
              ? 'border-dashed border-border bg-surface-2 text-ink-muted hover:border-border-strong'
              : 'border-border bg-surface hover:border-border-strong',
          ].join(' ')}
        >
          {role.extends.length === 0 ? (
            <span className="text-[13px] text-ink-muted">
              None — this is a base role.
            </span>
          ) : (
            <div className="flex flex-wrap gap-2">
              {role.extends.map((parentId) => {
                // Dangling-safe: a parent id may not exist in this
                // workspace's roles.json (e.g. an unmigrated soft ref).
                // Show the raw id; annotate with the resolved name when
                // the parent is present.
                const parent = roles.find((r) => r.role_id === parentId) ?? null;
                const parentName = parent
                  ? resolveRoleName(parent, lexicon, projectLocales)
                  : null;
                return (
                  <span
                    key={parentId}
                    className="inline-flex items-center gap-1.5 rounded-full border border-border bg-canvas px-2.5 py-1 text-[12px]"
                  >
                    <span className="font-mono text-[10.5px] text-accent-ink">
                      {parentId}
                    </span>
                    {parentName ? (
                      <span className="text-ink-secondary">{parentName}</span>
                    ) : (
                      <span className="text-status-draft-fg" title="Not in roles.json">
                        unresolved
                      </span>
                    )}
                  </span>
                );
              })}
            </div>
          )}
        </button>
      </Section>

      {/* ─── Code anchor ─── */}
      <Section label="Code anchor" hint="Where this role is defined in code (auto-discovered)">
        <button
          type="button"
          {...handlers({ kind: 'code_anchor' })}
          className="block w-full cursor-text rounded-md border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          <KV k="constant" v={role.code_anchor?.constant ?? '—'} />
          <KV k="db field" v={role.code_anchor?.db_field ?? '—'} isLast />
        </button>
      </Section>

      {/* ─── Extraction provenance ─── */}
      <Section
        label="Source evidence"
        count={role._meta?.extraction ? `${role._meta.extraction.evidence.length} lines` : undefined}
        hint="Read-only provenance from extraction"
      >
        <ExtractionProvenance role={role} />
      </Section>

      {/* ─── Actor in ─── */}
      <Section
        label="Actor in"
        count={`${actorDoks.length} doks`}
        hint="Doks where this role appears as an actor in user_actions"
      >
        {actorDoks.length === 0 ? (
          <div className="rounded-md border border-dashed border-border bg-surface px-4 py-6 text-center text-[13px] text-ink-muted">
            Not referenced by any Dok.
          </div>
        ) : (
          <div className="grid grid-cols-[repeat(auto-fit,minmax(min(100%,240px),1fr))] gap-x-3 gap-y-1.5">
            {actorDoks.map((d) => (
              <ActorRow
                key={d.dok_id}
                dok_id={d.dok_id}
                name={typeof d.name === 'string' ? d.name : `{${d.name.term_ref}}`}
              />
            ))}
          </div>
        )}
      </Section>
    </article>
  );
}

function KindBadge({ kind }: { kind: RoleKind }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2.5 py-1 text-[10.5px] font-medium text-ink-secondary">
      {kind === 'access' ? (
        <KeyRound size={11} aria-hidden />
      ) : (
        <UserRound size={11} aria-hidden />
      )}
      {roleKindLabel(kind)}
    </span>
  );
}

function ExtractionProvenance({ role }: { role: Role }) {
  const extraction = role._meta?.extraction;
  if (!extraction) {
    return (
      <div className="rounded-md border border-dashed border-border bg-surface px-4 py-4 text-[12.5px] text-ink-muted">
        No extraction provenance is recorded for this role.
      </div>
    );
  }

  return (
    <div className="rounded-md border border-border bg-surface px-4 py-3.5">
      <div className="flex flex-wrap items-center gap-1.5 text-[12px] text-ink-muted">
        <Search size={13} aria-hidden className="shrink-0" />
        <span>Extraction confidence</span>
        <span className="font-mono font-medium capitalize text-ink-secondary">
          {extraction.confidence}
        </span>
        <span className="ml-auto inline-flex items-center gap-1 text-[10.5px] text-ink-faint">
          <Lock size={11} aria-hidden />
          Read only
        </span>
      </div>
      {extraction.evidence.length > 0 ? (
        <ul className="m-0 mt-3 list-none border-t border-border p-0">
          {extraction.evidence.map((line, index) => (
            <li
              key={`${index}:${line}`}
              className="whitespace-pre-wrap border-b border-dashed border-border py-2.5 font-mono text-[11px] leading-relaxed text-ink-muted last:border-b-0 [overflow-wrap:anywhere]"
            >
              {line}
            </li>
          ))}
        </ul>
      ) : (
        <p className="mt-2.5 text-[12px] text-ink-muted">
          No evidence lines were recorded for this extraction.
        </p>
      )}
    </div>
  );
}

// ── Block primitives ───────────────────────────────────────────────

function Section({
  label,
  count,
  hint,
  children,
}: {
  label: string;
  count?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <header className="mb-3.5 flex flex-wrap items-center gap-x-2.5 gap-y-1.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          {label}
        </span>
        {count && <span className="font-mono text-[11px] text-ink-faint">{count}</span>}
        {hint && (
          <span className="ml-auto max-w-full text-right text-[12px] italic text-ink-faint">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function NameBlock({
  role,
  resolvedName,
  onFocusName,
  onUpdate,
}: {
  role: Role;
  resolvedName: string;
  onFocusName: () => void;
  onUpdate: (patch: RoleEditPatch) => void;
}) {
  const { push } = useSafeNavigation();
  const isTermRef = typeof role.name !== 'string';
  const termId = isTermRef ? (role.name as { term_ref: string }).term_ref : null;

  return (
    <div className="mt-2 flex flex-wrap items-baseline gap-x-3.5 gap-y-2">
      <span className="w-16 shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        name
      </span>
      {isTermRef ? (
        <button
          type="button"
          onClick={onFocusName}
          onFocus={onFocusName}
          className="-mx-1 min-w-0 basis-48 flex-1 cursor-text rounded-sm px-1 py-0.5 text-left text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-ink-strong [overflow-wrap:anywhere] hover:bg-surface focus:bg-surface focus:shadow-focus focus:outline-none"
        >
          {resolvedName}
        </button>
      ) : (
        <input
          value={role.name as string}
          onChange={(e) => onUpdate({ name: e.target.value })}
          onFocus={onFocusName}
          className="-mx-1 min-w-0 basis-48 flex-1 rounded-sm border border-transparent px-1 py-0.5 text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-ink-strong hover:bg-surface focus:border-accent focus:bg-surface focus:shadow-focus focus:outline-none"
          spellCheck={false}
          aria-label="Role display name"
        />
      )}
      {termId && (
        <button
          type="button"
          onClick={() => void push(`/lexicon/${termId}`)}
          className="inline-flex cursor-pointer items-center gap-1 self-center rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink hover:bg-accent-soft-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          {termId} <span className="text-[10px] opacity-70">↗</span>
        </button>
      )}
    </div>
  );
}

function mergeRolePatch(
  current: RoleEditPatch | null,
  next: RoleEditPatch,
): RoleEditPatch {
  return { ...current, ...next };
}

function ActorRow({ dok_id, name }: { dok_id: string; name: string }) {
  const { push } = useSafeNavigation();
  return (
    <button
      type="button"
      onClick={() => void push(`/doks?id=${encodeURIComponent(dok_id)}`)}
      className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-[12.5px] hover:border-border-strong hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
        {dok_id}
      </span>
      <span className="flex-1 truncate text-ink-secondary">{name}</span>
    </button>
  );
}

function KV({
  k,
  v,
  isLast,
}: {
  k: string;
  v: string;
  isLast?: boolean;
}) {
  return (
    <div
      className={[
        'flex justify-between gap-2 py-1.5 text-[12.5px]',
        isLast ? '' : 'border-b border-dashed border-border',
      ].join(' ')}
    >
      <span className="font-mono text-[11.5px] text-ink-muted">{k}</span>
      <span className="font-mono text-[11.5px] font-medium text-ink">{v}</span>
    </div>
  );
}
