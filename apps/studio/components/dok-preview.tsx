'use client';

import type { ReactNode } from 'react';
import type {
  AcceptanceCriterion,
  ActionVariant,
  Actor,
  BusinessRule,
  CodeAnchor,
  Dok,
  SourceAnchor,
  Translatable,
  UserActionStep,
} from '@doklo-beta/core';
import { useSelectedDok } from './studio-store';
import { priorityLabels, TIER_CHIP } from '../lib/dok-priority-order';
import { SmartSidebarSection } from './smart-sidebar';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';

const STATUS_INK: Record<Dok['status'], string> = {
  active:     'text-status-active-fg',
  draft:      'text-status-draft-fg',
  review:     'text-status-review-fg',
  planned:    'text-status-planned-fg',
  deprecated: 'text-status-deprecated-fg',
  archived:   'text-status-archived-fg',
};

const RULE_TONE: Record<BusinessRule['type'], string> = {
  validation:  'bg-status-review-bg text-status-review-fg',
  restriction: 'bg-status-deprecated-bg text-status-deprecated-fg',
  policy:      'bg-status-active-bg text-status-active-fg',
  calculation: 'bg-status-draft-bg text-status-draft-fg',
  permission:  'bg-accent-soft text-accent-ink',
};

const ACTOR_TONE: Record<Actor['kind'], string> = {
  role:     'bg-accent-soft text-accent-ink',
  system:   'bg-status-active-bg text-status-active-fg',
  external: 'bg-status-draft-bg text-status-draft-fg',
};

function tText(t: Translatable): string {
  return typeof t === 'string' ? t : `{${t.term_ref}}`;
}

function actorLabel(actor: Actor): string {
  if (actor.kind === 'role') return actor.role_ref.replace(/^ROLE-/, '').toLowerCase();
  if (actor.kind === 'system') return 'system';
  return actor.label;
}

/** "N days ago" / "today" / "yesterday" — short relative label.
 *  Falls back to the raw ISO date when the input doesn't parse. */
function relativeDay(isoDate: string): string {
  const then = new Date(isoDate);
  if (Number.isNaN(then.getTime())) return isoDate;
  const today = new Date();
  // Normalize to midnight UTC so day deltas don't drift by tz.
  const a = Date.UTC(then.getUTCFullYear(), then.getUTCMonth(), then.getUTCDate());
  const b = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
  const days = Math.round((b - a) / (1000 * 60 * 60 * 24));
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  return `${days} days ago`;
}

function shortDate(isoDate?: string): string {
  if (!isoDate) return '—';
  const date = new Date(isoDate);
  if (Number.isNaN(date.getTime())) return isoDate;
  return date.toISOString().slice(0, 10);
}

function listText(values: string[], empty = '—'): string {
  return values.length === 0 ? empty : values.join(', ');
}

function codeAnchorText(anchor?: CodeAnchor): string | null {
  if (!anchor) return null;
  const parts = [
    anchor.file,
    anchor.component,
    anchor.function,
    anchor.api,
    anchor.validation,
    anchor.constant,
    anchor.db_constraint,
    anchor.db_field,
  ].filter((v): v is string => Boolean(v));
  return parts.length === 0 ? null : parts.join(' · ');
}

function sourceAnchorText(anchor: SourceAnchor): string {
  const range = anchor.start_line
    ? `:${anchor.start_line}${anchor.end_line && anchor.end_line !== anchor.start_line ? `-${anchor.end_line}` : ''}`
    : '';
  return `${anchor.file}${range}${anchor.symbol ? ` · ${anchor.symbol}` : ''}`;
}

/**
 * DokPreview — catalog-specific Smart Sidebar content. Renders the
 * currently selected Dok as a read-only detail viewer, with the selected
 * Dok identity normalized into a table before schema sections are shown.
 *
 * Returns null when no selection exists, so the SmartSidebar shell
 * falls back to its empty hint. Phase 5+ will mirror this shape with
 * TermPreview / RoutePreview / RolePreview on the other layers.
 */
export function DokPreview() {
  const dok = useSelectedDok();
  const { push } = useSafeNavigation();
  if (!dok) return null;

  const { version, generation_confidence: confidence, history } = dok._meta;
  const lastEntry = history?.length ? history[history.length - 1] : undefined;
  const lastEdited = lastEntry
    ? `${relativeDay(lastEntry.date)}${lastEntry.author ? ` · @${lastEntry.author}` : ''}`
    : '—';
  const steps = dok.user_actions?.steps ?? [];
  const rules = dok.business_rules?.rules ?? [];
  const criteria = dok.acceptance_criteria?.criteria ?? [];
  const sourceAnchors = dok._meta.source_anchors ?? [];
  const priority = priorityLabels(dok);

  return (
    <div>
      <div className="mb-4">
        <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
          Dok detail viewer
        </div>
        <div className="inline-block rounded-md border border-accent-soft-strong bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
          {dok.dok_id}
        </div>
      </div>

      <SmartSidebarSection title="Selected Dok">
        <table className="w-full border-collapse text-[12.5px]">
          <tbody>
            <InfoRow label="Name">
              <span className="font-medium text-ink-strong">{tText(dok.name)}</span>
            </InfoRow>
            <InfoRow label="ID">
              <span className="font-mono text-[12px] text-accent">{dok.dok_id}</span>
            </InfoRow>
            <InfoRow label="Status">
              <span className={['font-mono text-[12px] font-medium', STATUS_INK[dok.status]].join(' ')}>
                ● <span className="text-ink">{dok.status}</span>
              </span>
            </InfoRow>
            <InfoRow label="Priority">
              {priority === null ? (
                <span className="text-ink-faint">not judged yet</span>
              ) : (
                <span className="flex flex-wrap items-center gap-1.5">
                  <span
                    className={`rounded px-1.5 py-0.5 font-mono text-[11px] font-medium ${TIER_CHIP[priority.tier]}`}
                  >
                    {priority.tier}
                  </span>
                  <span className="font-mono text-[11.5px] text-ink-secondary">
                    {priority.impact} · {priority.blast}
                  </span>
                </span>
              )}
            </InfoRow>
            <InfoRow label="Surfaces">{listText(dok.surfaces)}</InfoRow>
            <InfoRow label="Tags">
              <TagList tags={dok.tags} />
            </InfoRow>
            <InfoRow label="Version">
              v{version}
              {confidence != null && (
                <span className="ml-2 font-mono text-[12px] text-accent">
                  {Math.round(confidence * 100)}%
                </span>
              )}
            </InfoRow>
            <InfoRow label="Updated">{shortDate(dok._meta.updated_at)}</InfoRow>
            <InfoRow label="Edited">{lastEdited}</InfoRow>
          </tbody>
        </table>
      </SmartSidebarSection>

      <SmartSidebarSection title="Description">
        <p className="rounded-md border border-border bg-canvas px-3.5 py-3 text-[13px] leading-relaxed text-ink-secondary">
          {tText(dok.description)}
        </p>
      </SmartSidebarSection>

      <SmartSidebarSection title="User actions" count={`${steps.length} steps`}>
        {steps.length === 0 ? (
          <EmptyDetail>user_actions.steps is not defined yet.</EmptyDetail>
        ) : (
          <ol className="m-0 list-none space-y-2 p-0">
            {steps.map((step) => (
              <UserActionRow key={step.order} step={step} />
            ))}
          </ol>
        )}
      </SmartSidebarSection>

      <SmartSidebarSection title="Business rules" count={String(rules.length)}>
        {rules.length === 0 ? (
          <EmptyDetail>business_rules.rules is not defined yet.</EmptyDetail>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {rules.map((rule) => (
              <RuleRow key={rule.id} rule={rule} />
            ))}
          </ul>
        )}
      </SmartSidebarSection>

      <SmartSidebarSection title="Acceptance criteria" count={String(criteria.length)}>
        {criteria.length === 0 ? (
          <EmptyDetail>acceptance_criteria.criteria is not defined yet.</EmptyDetail>
        ) : (
          <ul className="m-0 list-none space-y-2 p-0">
            {criteria.map((criterion) => (
              <CriterionRow key={criterion.id} criterion={criterion} />
            ))}
          </ul>
        )}
      </SmartSidebarSection>

      <SmartSidebarSection title="Source anchors" count={String(sourceAnchors.length)}>
        {sourceAnchors.length === 0 ? (
          <EmptyDetail>No linked source anchor.</EmptyDetail>
        ) : (
          <ul className="m-0 list-none p-0">
            {sourceAnchors.map((anchor) => (
              <li
                key={sourceAnchorText(anchor)}
                className="py-1.5 font-mono text-[11.5px] leading-relaxed text-ink-secondary [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border"
              >
                {sourceAnchorText(anchor)}
              </li>
            ))}
          </ul>
        )}
      </SmartSidebarSection>

      <button
        type="button"
        onClick={() => void push(`/doks/${dok.dok_id}`)}
        className="sticky bottom-0 z-10 mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3.5 py-2.5 text-[13.5px] font-semibold text-canvas shadow-[0_-10px_18px_-10px_var(--color-surface)] transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        <span>Open in doks-editor</span>
        <span className="rounded-[3px] bg-white/15 px-1.5 py-0.5 font-mono text-[10.5px] font-medium">
          ⌘↵
        </span>
      </button>
    </div>
  );
}

function InfoRow({ label, children }: { label: string; children: ReactNode }) {
  return (
    <tr className="border-b border-dashed border-border last:border-b-0">
      <th
        scope="row"
        className="w-[84px] py-2 pr-3 text-left align-top font-normal text-ink-muted"
      >
        {label}
      </th>
      <td className="py-2 align-top text-ink-secondary">{children}</td>
    </tr>
  );
}

function EmptyDetail({ children }: { children: ReactNode }) {
  return (
    <div className="rounded-md border border-dashed border-border bg-canvas px-3 py-2.5 text-[12.5px] leading-relaxed text-ink-muted">
      {children}
    </div>
  );
}

function TagList({ tags }: { tags: string[] }) {
  if (tags.length === 0) return <>—</>;
  return (
    <div className="flex flex-wrap gap-1.5">
      {tags.map((tag) => (
        <span
          key={tag}
          className="inline-flex items-center rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] leading-5 text-ink-secondary"
        >
          <span className="mr-0.5 text-ink-faint">#</span>
          {tag}
        </span>
      ))}
    </div>
  );
}

function UserActionRow({ step }: { step: UserActionStep }) {
  return (
    <li className="rounded-md border border-border bg-canvas px-3 py-2.5">
      <div className="mb-2 flex items-center gap-2">
        <span className="grid h-5 w-5 shrink-0 place-items-center rounded-full border border-border bg-surface-2 font-mono text-[11px] font-semibold text-ink-muted">
          {step.order}
        </span>
        <span
          className={[
            'rounded-full px-2 py-0.5 font-mono text-[10.5px] tracking-[0.04em]',
            ACTOR_TONE[step.actor.kind],
          ].join(' ')}
        >
          {actorLabel(step.actor)}
        </span>
      </div>
      <p className="mb-1.5 text-[13px] leading-relaxed text-ink-strong">
        {tText(step.intent)}
      </p>
      <div
        aria-hidden
        className="my-1 flex h-4 items-center justify-center font-mono text-[12px] leading-none text-ink-faint"
      >
        ↓
      </div>
      <p className="text-[12.5px] leading-relaxed text-ink-muted">
        <span className="sr-only">Outcome: </span>
        {tText(step.outcome)}
      </p>
      {step.variants.length > 0 && (
        <VariantList variants={step.variants} />
      )}
      {step.preconditions && step.preconditions.length > 0 && (
        <p className="mt-2 border-t border-dashed border-border pt-2 text-[12px] leading-relaxed text-ink-muted">
          <span className="font-mono text-[10.5px] uppercase tracking-[0.1em] text-ink-faint">
            pre
          </span>{' '}
          {step.preconditions.join(' · ')}
        </p>
      )}
    </li>
  );
}

function VariantList({ variants }: { variants: ActionVariant[] }) {
  return (
    <div className="mt-2 flex flex-wrap gap-1.5 border-t border-dashed border-border pt-2">
      {variants.map((variant, idx) => {
        const anchor = codeAnchorText(variant.code_anchor);
        return (
          <span
            key={`${variant.platform}-${variant.interaction}-${idx}`}
            title={anchor ?? undefined}
            className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-secondary"
          >
            {variant.platform}/{variant.interaction}
            {variant.target ? ` · ${tText(variant.target)}` : ''}
          </span>
        );
      })}
    </div>
  );
}

function RuleRow({ rule }: { rule: BusinessRule }) {
  const anchor = codeAnchorText(rule.code_anchor);
  return (
    <li className="rounded-md border border-border bg-canvas px-3 py-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] text-ink-muted">{rule.id}</span>
        <span
          className={[
            'rounded-full px-2 py-0.5 font-mono text-[10px] uppercase tracking-[0.08em]',
            RULE_TONE[rule.type],
          ].join(' ')}
        >
          {rule.type}
        </span>
      </div>
      <p className="text-[13px] leading-relaxed text-ink-strong">
        {tText(rule.description)}
      </p>
      {rule.applies_to_roles && rule.applies_to_roles.length > 0 && (
        <p className="mt-2 text-[12px] text-ink-muted">
          roles · {rule.applies_to_roles.join(', ')}
        </p>
      )}
      {anchor && (
        <p className="mt-2 border-t border-dashed border-border pt-2 font-mono text-[11px] leading-relaxed text-ink-muted">
          {anchor}
        </p>
      )}
    </li>
  );
}

function CriterionRow({ criterion }: { criterion: AcceptanceCriterion }) {
  return (
    <li className="rounded-md border border-border bg-canvas px-3 py-2.5">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <span className="font-mono text-[10.5px] text-ink-muted">
          {criterion.id}
        </span>
        {criterion.related_rules.length > 0 && (
          <span className="rounded-full bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-muted">
            {criterion.related_rules.length} rules
          </span>
        )}
      </div>
      <p className="text-[13px] leading-relaxed text-ink-strong">
        {tText(criterion.statement)}
      </p>
      {(criterion.given || criterion.when || criterion.then) && (
        <table className="mt-2 w-full border-collapse border-t border-dashed border-border text-[12px]">
          <tbody>
            {criterion.given && <GwtRow label="Given" value={criterion.given} />}
            {criterion.when && <GwtRow label="When" value={criterion.when} />}
            {criterion.then && <GwtRow label="Then" value={criterion.then} />}
          </tbody>
        </table>
      )}
      {criterion.related_rules.length > 0 && (
        <p className="mt-2 text-[12px] leading-relaxed text-ink-muted">
          related · {criterion.related_rules.join(', ')}
        </p>
      )}
    </li>
  );
}

function GwtRow({ label, value }: { label: string; value: string }) {
  return (
    <tr className="border-b border-dashed border-border last:border-b-0">
      <th className="w-[52px] py-1.5 pr-2 text-left align-top font-mono text-[10.5px] font-normal uppercase tracking-[0.08em] text-ink-faint">
        {label}
      </th>
      <td className="py-1.5 align-top leading-relaxed text-ink-secondary">
        {value}
      </td>
    </tr>
  );
}
