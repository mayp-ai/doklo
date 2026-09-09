'use client';

import { KeyRound, Search, UserRound } from 'lucide-react';
import type { Role } from '@doklo-beta/core';
import {
  useSelectedRole,
  useRoleActorDoks,
  useStudio,
  resolveRoleName,
} from './studio-store';
import { SmartSidebarSection } from './smart-sidebar';
import { useCrossLayerJump } from '../lib/hooks/use-cross-layer-jump';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import { roleKindLabel } from '../lib/role-presentation';

const SCOPE_TAG: Record<Role['scope'], string> = {
  global:   'bg-accent-soft text-accent-ink',
  tenant:   'bg-status-draft-bg text-status-draft-fg',
  resource: 'bg-status-review-bg text-status-review-fg',
};

/**
 * RolePreview — Roles-specific SmartSidebar content. Reads the selected
 * workspace role from the store; a null selection surfaces the empty hint
 * (SmartSidebar renders nothing). Everything shown is a real Role schema
 * field — no permission matrix or usage stats (the v5 Role schema has
 * neither).
 */
export function RolePreview() {
  const role = useSelectedRole();
  const { lexicon, projectLocales } = useStudio();
  const actorDoks = useRoleActorDoks(role?.role_id ?? null);
  const jump = useCrossLayerJump();
  const { push } = useSafeNavigation();
  if (!role) return null;

  const name = resolveRoleName(role, lexicon, projectLocales);
  const isTermRef = typeof role.name !== 'string';
  const termId = isTermRef ? (role.name as { term_ref: string }).term_ref : null;
  const extraction = role._meta?.extraction;

  return (
    <div>
      <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Selected Role
      </div>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <span className="inline-block rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
          {role.role_id}
        </span>
        <KindBadge kind={role.kind} />
        <span
          className={[
            'rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.1em]',
            SCOPE_TAG[role.scope],
          ].join(' ')}
        >
          {role.scope}
        </span>
      </div>
      <h3 className="mb-1.5 text-xl font-semibold leading-tight tracking-tight text-ink-strong">
        {name}
      </h3>
      {role.description && (
        <p className="mb-3.5 text-[13px] leading-relaxed text-ink-secondary">
          {role.description}
        </p>
      )}

      <SmartSidebarSection title="Identity">
        <ul className="m-0 list-none p-0">
          <KV
            k="extends"
            v={role.extends.length === 0 ? 'none (base)' : role.extends.join(', ')}
          />
          <KV k="scope" v={role.scope} />
          {termId && <KV k="name term" v={termId} />}
        </ul>
      </SmartSidebarSection>

      {role.code_anchor && (
        <SmartSidebarSection title="Code anchor">
          <ul className="m-0 list-none p-0">
            {role.code_anchor.constant && (
              <KV k="constant" v={role.code_anchor.constant} />
            )}
            {role.code_anchor.db_field && (
              <KV k="db field" v={role.code_anchor.db_field} />
            )}
          </ul>
        </SmartSidebarSection>
      )}

      <SmartSidebarSection
        title="Source evidence"
        count={extraction ? `${extraction.evidence.length}` : undefined}
      >
        {extraction ? (
          <div>
            <div className="mb-2.5 flex flex-wrap items-center gap-1.5 text-[11.5px] text-ink-muted">
              <Search size={12} aria-hidden className="shrink-0" />
              <span>Extraction confidence</span>
              <span className="font-mono font-medium capitalize text-ink-secondary">
                {extraction.confidence}
              </span>
              <span className="ml-auto text-[10.5px] text-ink-faint">Read only</span>
            </div>
            {extraction.evidence.length > 0 ? (
              <ul className="m-0 list-none space-y-1.5 p-0">
                {extraction.evidence.map((line, index) => (
                  <li
                    key={`${index}:${line}`}
                    className="whitespace-pre-wrap rounded-sm bg-surface-2 px-2.5 py-2 font-mono text-[10.5px] leading-relaxed text-ink-muted [overflow-wrap:anywhere]"
                  >
                    {line}
                  </li>
                ))}
              </ul>
            ) : (
              <p className="text-[12px] text-ink-muted">
                No evidence lines were recorded for this extraction.
              </p>
            )}
          </div>
        ) : (
          <p className="text-[12px] leading-relaxed text-ink-muted">
            No extraction provenance is recorded for this role.
          </p>
        )}
      </SmartSidebarSection>

      <SmartSidebarSection title="Actor in" count={String(actorDoks.length)}>
        {actorDoks.length === 0 ? (
          <div className="text-[12px] text-ink-muted">
            Not referenced by any Dok.
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {actorDoks.map((d) => (
              <li
                key={d.dok_id}
                className="m-0 p-0 [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border"
              >
                <button
                  type="button"
                  onClick={() =>
                    jump.jumpToDok(
                      d.dok_id,
                      typeof d.name === 'string' ? d.name : undefined,
                    )
                  }
                  className="flex w-full items-center gap-2 py-1.5 text-left text-[13px] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                >
                  <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
                    {d.dok_id}
                  </span>
                  <span className="flex-1 truncate text-ink-secondary">
                    {typeof d.name === 'string' ? d.name : `{${d.name.term_ref}}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SmartSidebarSection>

      <button
        type="button"
        onClick={() => void push(`/roles/${role.role_id}`)}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3.5 py-2.5 text-[13.5px] font-semibold text-canvas transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        <span>Open in role-editor</span>
        <span className="rounded-[3px] bg-white/15 px-1.5 py-0.5 font-mono text-[10.5px] font-medium">
          ⌘↵
        </span>
      </button>
    </div>
  );
}

function KindBadge({ kind }: { kind: Role['kind'] }) {
  return (
    <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] font-medium text-ink-secondary">
      {kind === 'access' ? (
        <KeyRound size={11} aria-hidden />
      ) : (
        <UserRound size={11} aria-hidden />
      )}
      {roleKindLabel(kind)}
    </span>
  );
}

function KV({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex justify-between gap-2 py-1.5 text-[12.5px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border">
      <span className="text-ink-muted">{k}</span>
      <span className="min-w-0 break-words text-right font-mono text-[12px] font-medium text-ink [overflow-wrap:anywhere]">
        {v}
      </span>
    </li>
  );
}
