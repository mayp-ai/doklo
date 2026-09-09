'use client';

import type { ReactNode } from 'react';
import {
  useStudio,
  useRoles,
  useRoleActorDoks,
  resolveRoleName,
  termDisplay,
} from '../studio-store';
import { useSafeNavigation } from '../../lib/hooks/use-safe-navigation';

/**
 * RoleEditSidebar — focus-driven content router for the role editor's
 * right pane. Mirrors DokEditSidebar / LexiconEditSidebar. Every card
 * reads real workspace data (roles.json + lexicon) — no synthetic cards.
 *
 * Branch table:
 *   focus.kind === 'name'        → LexiconTermPickerCard (store lexicon)
 *   focus.kind === 'extends'     → ExtendsCandidatesCard (useRoles)
 *   focus.kind === 'scope'       → ScopeExplainCard
 *   focus.kind === 'code_anchor' → CodeAnchorCard
 *   focus.kind === 'actor_in'    → ActorInDetailCard (useRoleActorDoks)
 *   null / default               → DefaultPanel (role overview)
 */
export function RoleEditSidebar() {
  const { focusedField, editingRole } = useStudio();
  if (!editingRole) return null;

  switch (focusedField?.kind) {
    case 'name':
      return <LexiconTermPickerCard />;
    case 'extends':
      return <ExtendsCandidatesCard />;
    case 'scope':
      return <ScopeExplainCard />;
    case 'code_anchor':
      return <CodeAnchorCard />;
    case 'actor_in':
      return <ActorInDetailCard />;
    default:
      return <DefaultPanel />;
  }
}

// ── Shared primitives ───────────────────────────────────────────────

function NowEditingBadge({ label }: { label: string }) {
  return (
    <div className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-accent-ink">
      <span className="h-1.5 w-1.5 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-accent" />
      Now editing — {label}
    </div>
  );
}

function Card({
  children,
  tone = 'plain',
  className,
}: {
  children: ReactNode;
  tone?: 'plain' | 'accent' | 'muted';
  className?: string;
}) {
  const cls =
    tone === 'accent'
      ? 'border-accent-soft-strong bg-accent-soft'
      : tone === 'muted'
        ? 'border-border bg-surface'
        : 'border-border bg-canvas';
  return (
    <div className={`mb-3.5 rounded-md border ${cls} p-4.5 ${className ?? ''}`}>
      {children}
    </div>
  );
}

function CardTitle({ children, dim = false }: { children: ReactNode; dim?: boolean }) {
  return (
    <h4
      className={[
        'mb-1.5 tracking-tight',
        dim
          ? 'text-[13px] font-medium text-ink-muted'
          : 'text-[15px] font-semibold text-ink-strong',
      ].join(' ')}
    >
      {children}
    </h4>
  );
}

// ── name focus ──────────────────────────────────────────────────────

function LexiconTermPickerCard() {
  const { editingRole, lexicon, projectLocales } = useStudio();
  const { push } = useSafeNavigation();
  if (!editingRole) return null;
  const isTermRef = typeof editingRole.name !== 'string';
  const termId = isTermRef
    ? (editingRole.name as { term_ref: string }).term_ref
    : null;
  const term = termId ? lexicon.find((t) => t.term_id === termId) ?? null : null;

  return (
    <>
      <NowEditingBadge label="name" />
      <Card>
        <CardTitle>Lexicon term</CardTitle>
        {isTermRef && termId ? (
          <>
            <p className="mb-3 text-[12.5px] leading-[1.65] text-ink-secondary">
              This role's display name references a Lexicon term. Changing the
              wording there updates every place it's used.
            </p>
            <button
              type="button"
              onClick={() => void push(`/lexicon/${termId}`)}
              className="block w-full cursor-pointer rounded-md border border-border bg-surface p-3 text-left transition-colors hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              <div className="font-mono text-[10.5px] text-accent-ink">{termId}</div>
              {term ? (
                <div className="mt-1 flex flex-wrap gap-x-2.5 gap-y-0.5 font-mono text-[10.5px] text-ink-faint">
                  {projectLocales.map((loc) => {
                    const text = termDisplay(term, loc);
                    return (
                      <span key={loc}>
                        {loc} ·{' '}
                        <span className={text ? 'text-ink-secondary' : 'text-status-draft-fg'}>
                          {text ?? 'missing'}
                        </span>
                      </span>
                    );
                  })}
                </div>
              ) : (
                <div className="mt-1 text-[12px] text-status-draft-fg">
                  Term not found in this workspace's lexicon.
                </div>
              )}
            </button>
            <button
              type="button"
              onClick={() => void push(`/lexicon/${termId}`)}
              className="mt-2 block w-full text-center text-[12px] text-ink-muted hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Open in lexicon-editor ↗
            </button>
          </>
        ) : (
          <p className="text-[12.5px] leading-[1.65] text-ink-secondary">
            This role's name is an inline string. If it needs to display in
            multiple languages, register it as a Lexicon term to manage the
            wording in one place.
          </p>
        )}
      </Card>
    </>
  );
}

// ── extends focus ───────────────────────────────────────────────────

function ExtendsCandidatesCard() {
  const { editingRole, updateEditingRole, lexicon, projectLocales } = useStudio();
  const roles = useRoles();
  if (!editingRole) return null;
  const current = editingRole.extends[0] ?? null;
  const candidates = roles.filter((r) => r.role_id !== editingRole.role_id);

  return (
    <>
      <NowEditingBadge label="extends" />
      <Card>
        <CardTitle>Parent role</CardTitle>
        <p className="mb-3 text-[12.5px] leading-[1.65] text-ink-secondary">
          Current parent:{' '}
          <strong className="text-ink-strong">{current ?? 'None (base)'}</strong>.
          Pick a role to inherit from, or clear it to make this a base role.
        </p>
        {candidates.length === 0 ? (
          <p className="text-[12px] text-ink-muted">
            No other roles in this workspace to extend.
          </p>
        ) : (
          <div className="space-y-1.5">
            <button
              type="button"
              onClick={() => updateEditingRole({ extends: [] })}
              className={[
                'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[12.5px]',
                current === null
                  ? 'border-accent bg-accent-soft text-accent-ink'
                  : 'border-border bg-surface text-ink-secondary hover:border-border-strong hover:text-ink',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
              ].join(' ')}
            >
              <span className="font-medium">None (base role)</span>
            </button>
            {candidates.map((r) => {
              const active = current === r.role_id;
              return (
                <button
                  key={r.role_id}
                  type="button"
                  onClick={() => updateEditingRole({ extends: [r.role_id] })}
                  className={[
                    'flex w-full items-center gap-2 rounded-md border px-3 py-2 text-left text-[12.5px]',
                    active
                      ? 'border-accent bg-accent-soft text-accent-ink'
                      : 'border-border bg-surface text-ink-secondary hover:border-border-strong hover:text-ink',
                    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                  ].join(' ')}
                >
                  <span className="font-mono text-[10.5px]">{r.role_id}</span>
                  <span className="font-medium">
                    {resolveRoleName(r, lexicon, projectLocales)}
                  </span>
                  <span className="ml-auto font-mono text-[10px] text-ink-faint">
                    {r.scope}
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </Card>
    </>
  );
}

// ── scope focus ─────────────────────────────────────────────────────

function ScopeExplainCard() {
  const { editingRole } = useStudio();
  if (!editingRole) return null;
  return (
    <>
      <NowEditingBadge label="scope" />
      <Card>
        <CardTitle>Scope</CardTitle>
        <p className="mb-3 text-[12.5px] leading-[1.65] text-ink-secondary">
          Determines how far this role applies. Current scope:{' '}
          <strong className="font-mono text-[11px] text-ink">{editingRole.scope}</strong>.
        </p>
        <ul className="m-0 list-none space-y-2 p-0 text-[12px] text-ink-secondary">
          <li>
            <strong className="font-mono text-[11px] text-ink">global</strong> — applies
            across the whole system (e.g. super admin).
          </li>
          <li>
            <strong className="font-mono text-[11px] text-ink">tenant</strong> — meaningful
            only within an organization (e.g. seller, customer).
          </li>
          <li>
            <strong className="font-mono text-[11px] text-ink">resource</strong> — scoped
            to a specific resource (e.g. project member).
          </li>
        </ul>
      </Card>
    </>
  );
}

// ── code_anchor focus ───────────────────────────────────────────────

function CodeAnchorCard() {
  const { editingRole } = useStudio();
  if (!editingRole) return null;
  const anchor = editingRole.code_anchor;
  return (
    <>
      <NowEditingBadge label="code anchor" />
      <Card>
        <CardTitle>Code consistency</CardTitle>
        <p className="mb-3 text-[12.5px] leading-[1.65] text-ink-secondary">
          Tracks which code constant / DB field this role maps to. The adapter
          discovers it from the codebase during generation.
        </p>
        {anchor ? (
          <div className="rounded-md border border-border bg-surface px-3.5 py-3">
            <KV k="constant" v={anchor.constant ?? '—'} />
            <KV k="db field" v={anchor.db_field ?? '—'} />
          </div>
        ) : (
          <p className="text-[12px] text-ink-muted">
            No code anchor recorded for this role.
          </p>
        )}
      </Card>
    </>
  );
}

// ── actor_in focus ──────────────────────────────────────────────────

function ActorInDetailCard() {
  const { editingRole } = useStudio();
  const { push } = useSafeNavigation();
  const actorDoks = useRoleActorDoks(editingRole?.role_id ?? null);
  if (!editingRole) return null;
  return (
    <>
      <NowEditingBadge label="actor in" />
      <Card>
        <CardTitle>Doks where this role appears as an actor</CardTitle>
        <p className="mb-3 text-[12.5px] leading-[1.65] text-ink-secondary">
          Wording changes to this role propagate to the step-actor display of{' '}
          <strong className="text-ink-strong">{actorDoks.length} Doks</strong>.
        </p>
        {actorDoks.length === 0 ? (
          <p className="text-[12px] text-ink-muted">Not referenced by any Dok.</p>
        ) : (
          <ul className="m-0 list-none space-y-1 p-0">
            {actorDoks.map((d) => (
              <li key={d.dok_id}>
                <button
                  type="button"
                  onClick={() => void push(`/doks?id=${encodeURIComponent(d.dok_id)}`)}
                  className="flex w-full items-center gap-2 rounded-sm bg-surface px-2 py-1.5 text-left text-[12px] text-ink-secondary hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  <span className="shrink-0 rounded-full border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent-ink">
                    {d.dok_id}
                  </span>
                  <span className="truncate">
                    {typeof d.name === 'string' ? d.name : `{${d.name.term_ref}}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </>
  );
}

// ── default panel ───────────────────────────────────────────────────

function DefaultPanel() {
  const { editingRole, lexicon, projectLocales } = useStudio();
  const actorDoks = useRoleActorDoks(editingRole?.role_id ?? null);
  if (!editingRole) return null;
  return (
    <>
      <div className="mb-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Role overview
      </div>
      <Card tone="muted">
        <CardTitle>{resolveRoleName(editingRole, lexicon, projectLocales)}</CardTitle>
        <ul className="m-0 list-none p-0">
          <KV k="role_id" v={editingRole.role_id} />
          <KV k="scope" v={editingRole.scope} />
          <KV
            k="extends"
            v={editingRole.extends.length === 0 ? 'none' : editingRole.extends.join(', ')}
          />
          <KV k="actor in" v={`${actorDoks.length} doks`} />
        </ul>
      </Card>
    </>
  );
}

function KV({
  k,
  v,
}: {
  k: string;
  v: string;
}) {
  return (
    <div className="flex justify-between gap-2 py-1.5 text-[12.5px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border">
      <span className="font-mono text-[11px] text-ink-muted">{k}</span>
      <span className="font-mono text-[11.5px] font-medium text-ink">{v}</span>
    </div>
  );
}
