'use client';

import type { ReactNode } from 'react';
import { useStudio, type FocusedField } from '../studio-store';
import { SmartSidebarSection } from '../smart-sidebar';

/**
 * DokEditSidebar — the focus-driven content router that lives inside
 * <SmartSidebar transitionKey={...}> on the doks-editor page.
 *
 * Each branch is a card explaining "what does this field mean / what
 * can you do here", with the actual editing affordance below
 * (Lexicon search box, role picker, etc.). Phase 9 builds the cards
 * statically; later phases wire the picker actions back into the
 * editing Dok.
 *
 * When focus is null we fall through to a default panel summarising
 * the dok's _meta (PRODUCT.md §2 — automatic info kept visible but
 * de-prioritized).
 */
export function DokEditSidebar() {
  const { focusedField, editingDok } = useStudio();
  if (!editingDok) return null;

  switch (focusedField?.kind) {
    case 'description':
      return <LexiconConvertCard />;
    case 'step':
      return <ActorPickerCard order={focusedField.order} />;
    case 'surfaces':
      return <WorkspaceServicesCard />;
    case 'tags':
      return <TagsHint />;
    case 'rule':
      return <RuleTypeCard id={focusedField.id} />;
    case 'criterion':
      return <ACDefinitionCard id={focusedField.id} />;
    case 'meta':
      return <MetaPanel />;
    case 'status':
      return <StatusGuideCard />;
    case 'name':
      return <NameGuideCard />;
    default:
      return <DefaultMetaPanel />;
  }
}

// ── Focus-specific cards ──────────────────────────────────────────────

function NowEditingBadge({ label }: { label: string }) {
  return (
    <div className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-accent-ink">
      <span className="h-1.5 w-1.5 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-accent" />
      Now editing — {label}
    </div>
  );
}

function Card({ children }: { children: ReactNode }) {
  return (
    <div className="mb-3.5 rounded-md border border-border bg-canvas p-4.5">
      {children}
    </div>
  );
}

function LexiconConvertCard() {
  return (
    <>
      <NowEditingBadge label="description" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Convert to a Lexicon term
        </h4>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
          Select a word in the body and press{' '}
          <kbd className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-secondary">
            ⌥+L
          </kbd>
          {' '}to make it a term. Translations are managed in one place, and it's
          suggested automatically in other Doks too.
        </p>
        <div className="mb-2 flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-2 text-[12.5px] text-ink-faint focus-within:border-accent focus-within:shadow-focus">
          <span aria-hidden className="opacity-70">⌕</span>
          <span className="flex-1">Search terms</span>
          <span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10px] text-ink-muted">⌥+L</span>
        </div>
        <button
          type="button"
          className="mt-1.5 block w-full cursor-pointer p-1.5 text-center text-[12px] text-ink-muted hover:text-accent"
        >
          + New term
        </button>
      </Card>
      <Card>
        <h4 className="mb-1.5 text-[13px] font-medium text-ink-muted">
          Why convert?
        </h4>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          Wording that appears in a description is often reused as navigation/concept
          wording. Registering it as a term propagates a wording change all at once.
        </p>
      </Card>
    </>
  );
}

function ActorPickerCard({ order }: { order: number }) {
  return (
    <>
      <NowEditingBadge label={`step ${order} · actor`} />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Who acts in this step?
        </h4>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
          A step's actor is one of three kinds.
        </p>
        <ActorOption tag="role" tone="accent" label="role · user / admin / customer">
          A person. References a Role in roles.json — permissions and wording both follow.
        </ActorOption>
        <ActorOption tag="system" tone="active" label="system">
          Automation. The system performs it without a user (payment-gateway call, sending notifications).
        </ActorOption>
        <ActorOption tag="external" tone="draft" label="external · payment-gateway">
          An external actor (payment gateway, OAuth provider, etc.).
        </ActorOption>
      </Card>
    </>
  );
}

function ActorOption({
  tag,
  tone,
  label,
  children,
}: {
  tag: string;
  tone: 'accent' | 'active' | 'draft';
  label: string;
  children: ReactNode;
}) {
  const toneCls =
    tone === 'accent' ? 'bg-accent-soft text-accent-ink' :
    tone === 'active' ? 'bg-status-active-bg text-status-active-fg' :
                        'bg-status-draft-bg text-status-draft-fg';
  return (
    <button
      type="button"
      className="mb-2 block w-full cursor-pointer rounded-md border border-border bg-surface p-2.5 text-left transition-colors hover:border-accent"
    >
      <div className="mb-1 flex items-center gap-2">
        <span className={`rounded-full px-2 py-0.5 font-mono text-[10.5px] tracking-[0.04em] ${toneCls}`}>
          {tag}
        </span>
        <span className="text-[12.5px] font-medium text-ink-strong">{label.split('·')[1]?.trim() ?? label}</span>
      </div>
      <div className="text-[12px] leading-relaxed text-ink-secondary">{children}</div>
    </button>
  );
}

function WorkspaceServicesCard() {
  const services = ['web', 'api', 'admin', 'mobile', 'cli'] as const;
  return (
    <>
      <NowEditingBadge label="surfaces" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Where does this Dok surface?
        </h4>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
          If the same business capability is spread across multiple services
          (web · api · admin), select all of them.
        </p>
        <div className="space-y-1.5">
          {services.map((s) => (
            <div
              key={s}
              className="flex items-center gap-2 rounded-md border border-border bg-surface px-2.5 py-1.5 font-mono text-[11.5px] text-ink-secondary"
            >
              <span aria-hidden className="text-ink-faint">▢</span>
              <span>{s}</span>
            </div>
          ))}
        </div>
      </Card>
    </>
  );
}

function TagsHint() {
  return (
    <>
      <NowEditingBadge label="tags" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Tags
        </h4>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          Free-form labels for search and filtering. Great for domain abbreviations
          (payment, auth) or lifecycle signals (experimental, legacy).
        </p>
      </Card>
    </>
  );
}

function RuleTypeCard({ id }: { id: string }) {
  return (
    <>
      <NowEditingBadge label={`business rule · ${id.slice(-2)}`} />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Business rule type
        </h4>
        <p className="mb-2 text-[12.5px] leading-relaxed text-ink-secondary">
          Rules that <em>restrict, validate, or compute</em> user behavior. One of five.
        </p>
        <ul className="m-0 list-none space-y-1.5 p-0 text-[12px] text-ink-secondary">
          <li><strong className="font-mono text-[11px] text-ink">restriction</strong> — allow/deny</li>
          <li><strong className="font-mono text-[11px] text-ink">policy</strong> — organization policy</li>
          <li><strong className="font-mono text-[11px] text-ink">validation</strong> — input validation</li>
          <li><strong className="font-mono text-[11px] text-ink">calculation</strong> — computation</li>
          <li><strong className="font-mono text-[11px] text-ink">permission</strong> — permissions</li>
        </ul>
      </Card>
    </>
  );
}

function ACDefinitionCard({ id }: { id: string }) {
  return (
    <>
      <NowEditingBadge label={`acceptance · ${id.slice(-2)}`} />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Acceptance criterion
        </h4>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
          How do you confirm this feature "<strong className="text-ink-strong">works
          correctly</strong>"? In one measurable sentence.
        </p>
        <div className="rounded-md border border-border bg-surface p-2.5 text-[12px] italic text-ink-muted">
          e.g. If a user enters the wrong password 3 times, the account is locked for 5 minutes.
        </div>
      </Card>
    </>
  );
}

function StatusGuideCard() {
  return (
    <>
      <NowEditingBadge label="status" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Status — 6-stage lifecycle
        </h4>
        <ul className="m-0 list-none space-y-1.5 p-0 text-[12px] text-ink-secondary">
          <li><strong className="font-mono text-[11px] text-status-draft-fg">draft</strong> — AI-generated, pending review</li>
          <li><strong className="font-mono text-[11px] text-status-review-fg">review</strong> — In review</li>
          <li><strong className="font-mono text-[11px] text-status-active-fg">active</strong> — Verified, in production</li>
          <li><strong className="font-mono text-[11px] text-ink">planned</strong> — Designed, not built</li>
          <li><strong className="font-mono text-[11px] text-status-deprecated-fg">deprecated</strong> — Being removed</li>
          <li><strong className="font-mono text-[11px] text-ink-faint">archived</strong> — Archived, inactive</li>
        </ul>
      </Card>
    </>
  );
}

function NameGuideCard() {
  return (
    <>
      <NowEditingBadge label="name" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Dok name
        </h4>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          The <strong className="text-ink-strong">feature name</strong> users and teams
          call it. Short and clear.
        </p>
        <div className="mt-2 rounded-md border border-border bg-surface p-2.5 text-[12px] italic text-ink-muted">
          e.g. "Payment processing", "Social login", "Order history"
        </div>
      </Card>
    </>
  );
}

function MetaPanel() {
  const { editingDok } = useStudio();
  if (!editingDok) return null;
  return (
    <>
      <NowEditingBadge label="_meta" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          _meta — auto-managed
        </h4>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          version · logic_hash · history · generation_confidence are filled in
          automatically by the tool. You rarely need to edit them directly.
        </p>
      </Card>
      <DokMetaSummary />
    </>
  );
}

/** Default sidebar — visible whenever no field is focused. Surfaces
 *  the editing Dok's auto-managed meta (PRODUCT.md §2). */
function DefaultMetaPanel() {
  return (
    <>
      <div className="mb-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Auto · Hidden if collapsed
      </div>
      <DokMetaSummary />
    </>
  );
}

function DokMetaSummary() {
  const { editingDok } = useStudio();
  if (!editingDok) return null;
  const { _meta, status } = editingDok;
  const logicHash = _meta.logic_hash;
  const conf =
    _meta.generation_confidence != null
      ? _meta.generation_confidence.toFixed(2)
      : '—';
  return (
    <SmartSidebarSection title="Meta">
      <ul className="m-0 list-none p-0">
        <KV k="generated by" v="LLM · sonnet-4" />
        <KV k="confidence" v={conf} />
        <KV
          k="logic_hash"
          v={logicHash ? formatHash(logicHash) : '—'}
          title={logicHash}
        />
        <KV k="version" v={`${status} · v${_meta.version}`} />
      </ul>
      {status === 'draft' && logicHash && (
        <div className="mt-3 rounded-r-sm border-l-2 border-l-status-draft-fg bg-status-draft-bg p-2.5 text-[12px] leading-relaxed text-ink">
          <strong className="text-status-draft-fg">Source fingerprint</strong>
          {' — '}tracks source-input paths and bytes. Editing Dok wording or status does not change it.
        </div>
      )}
    </SmartSidebarSection>
  );
}

function formatHash(hash: string): string {
  if (hash.length <= 13) return hash;
  return `${hash.slice(0, 8)}…${hash.slice(-4)}`;
}

function KV({ k, v, title }: { k: string; v: string; title?: string }) {
  return (
    <li className="flex min-w-0 justify-between gap-2 py-1.5 text-[12px] text-ink-muted [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border">
      <span className="shrink-0">{k}</span>
      <span
        title={title}
        className="min-w-0 max-w-[60%] truncate text-right font-mono text-[11.5px] text-ink-secondary"
      >
        {v}
      </span>
    </li>
  );
}
