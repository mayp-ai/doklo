'use client';

import { useCallback, useRef, useState } from 'react';
import { ArrowLeft } from 'lucide-react';
import type {
  AcceptanceCriterion,
  Actor,
  BusinessRule,
  Dok,
  DokHistoryCategory,
  DokPendingChange,
  DokPriority,
  Translatable,
  UserActionStep,
} from '@doklo-beta/core';
import { DokPriorityEditor } from './dok-priority-editor';
import { useStudio } from './studio-store';
import { saveDokAction, type DokEditPatch } from '../lib/actions';
import { useFocusContext } from '../lib/hooks/use-focus-context';
import { useDurableSave } from '../lib/hooks/use-durable-save';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import { isStaleServerActionError } from '../lib/save-error';

const BR_TONE: Record<BusinessRule['type'], string> = {
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

const STATUS_BADGE: Record<Dok['status'], string> = {
  draft:      'bg-status-draft-bg text-status-draft-fg',
  review:     'bg-status-review-bg text-status-review-fg',
  active:     'bg-status-active-bg text-status-active-fg',
  planned:    'bg-status-planned-bg text-status-planned-fg',
  deprecated: 'bg-status-deprecated-bg text-status-deprecated-fg',
  archived:   'bg-surface-2 text-ink-muted',
};

/**
 * Keep a Changelog sections a person can pick for a change note. The empty
 * value reads as `changed` — the section a note lands in when nobody says
 * otherwise — so the ordinary case costs no interaction and no stored field.
 */
const CHANGE_CATEGORIES: ReadonlyArray<{ value: '' | DokHistoryCategory; label: string }> = [
  { value: '',           label: 'Changed' },
  { value: 'added',      label: 'Added' },
  { value: 'fixed',      label: 'Fixed' },
  { value: 'security',   label: 'Security' },
  { value: 'deprecated', label: 'Deprecated' },
  { value: 'removed',    label: 'Removed' },
];

function tText(t: Translatable): string {
  return typeof t === 'string' ? t : `{${t.term_ref}}`;
}

/**
 * One history line. `kind` is optional in the schema so hand-written and
 * pre-v2 entries keep parsing — a missing one reads as an edit rather than
 * leaving the row silent about what happened.
 */
function historyRowText(entry: NonNullable<Dok['_meta']['history']>[number]): string {
  const transition = entry.from && entry.to ? ` · ${entry.from} → ${entry.to}` : '';
  const category = entry.category ? ` · ${entry.category}` : '';
  const author = entry.author ? ` · @${entry.author}` : '';
  return `v${entry.version} · ${entry.date} · ${entry.kind ?? 'edited'}${transition}`
    + `${category} · ${entry.change}${author}`;
}

function actorLabel(actor: Actor): string {
  if (actor.kind === 'role') return `role · ${actor.role_ref.replace(/^ROLE-/, '').toLowerCase()}`;
  if (actor.kind === 'system') return 'system';
  return `external · ${actor.label}`;
}

function actorIcon(actor: Actor): string {
  if (actor.kind === 'role') return '⟐';
  if (actor.kind === 'system') return '▦';
  return '⊕';
}

/**
 * DokEditor — main pane of the doks-editor route. Phase 9 rewrite:
 * Tailwind utilities (no globals.css component classes), mockup-parity
 * blocks, focus-context tracking that the dynamic SmartSidebar
 * subscribes to, and explicit revision-checked saving via saveDokAction
 * to `.doklo/hub/doks/<dok_id>.json`.
 *
 * Reads the editing Dok from the studio store rather than props so
 * SmartSidebar can re-render against the same source without prop
 * drilling. The /doks/[id] page seeds the store on mount.
 */
export function DokEditor() {
  const {
    editingDok,
    updateEditingDok,
    doksState,
    metaExpanded,
    setMetaExpanded,
    pendingSave,
    saveStatus,
  } = useStudio();
  const { handlers, clearFocus } = useFocusContext();
  const dokId = editingDok?.dok_id ?? '';
  const exactRevision =
    (doksState.kind === 'ready' || doksState.kind === 'empty') && dokId
      ? doksState.data.revisions[dokId] ?? ''
      : '';
  const exactPath =
    (doksState.kind === 'ready' || doksState.kind === 'empty') && dokId
      ? doksState.data.paths[dokId] ?? `${doksState.path}/${dokId}.json`
      : doksState.path;
  const saveIdentity = `${dokId}:${exactRevision}`;
  const saveIdentityRef = useRef('');
  const persistedStatusRef = useRef<Dok['status'] | null>(null);
  const queuedStatusRef = useRef<Dok['status'] | null>(null);
  if (saveIdentityRef.current !== saveIdentity) {
    saveIdentityRef.current = saveIdentity;
    persistedStatusRef.current = editingDok?.status ?? null;
    queuedStatusRef.current = null;
  }
  // The change note a person is typing right now. Mirrored into refs so
  // `persist` keeps a stable identity — the durable queue reads its persist
  // through a ref, and re-creating the callback on every keystroke would
  // churn the hook for no gain.
  const [note, setNote] = useState('');
  const [category, setCategory] = useState<'' | DokHistoryCategory>('');
  const noteRef = useRef('');
  const categoryRef = useRef<'' | DokHistoryCategory>('');
  noteRef.current = note;
  categoryRef.current = category;
  const persist = useCallback(
    (patch: DokEditPatch, expectedRevision: string) => {
      const trimmed = noteRef.current.trim();
      // A whitespace-only note is not a note: send neither it nor the
      // category, so the save records what it would have without the field.
      return saveDokAction({
        dokId,
        patch,
        expectedRevision,
        ...(trimmed
          ? {
              note: trimmed,
              ...(categoryRef.current ? { category: categoryRef.current } : {}),
            }
          : {}),
      });
    },
    [dokId],
  );
  const durable = useDurableSave<DokEditPatch>({
    key: `dok:${dokId}`,
    path: exactPath,
    initialRevision: exactRevision,
    merge: mergeDokPatch,
    persist,
    mode: 'manual',
  });
  const updateDok = useCallback((patch: DokEditPatch) => {
    let persistedPatch = patch;
    if (patch.status !== undefined) {
      queuedStatusRef.current = patch.status;
    } else if (persistedStatusRef.current === 'active') {
      persistedPatch = { ...patch, status: 'draft' };
      queuedStatusRef.current = 'draft';
    }
    updateEditingDok(patch);
    durable.queue(persistedPatch);
  }, [durable, updateEditingDok]);
  // A priority pin is a judgment *about* the Dok, not a rewrite of its content,
  // so it rides the same revision-checked queue but skips the active→draft
  // demotion updateDok applies — re-reviewing prose because someone marked the
  // Dok as revenue-critical would be backwards.
  const updatePriority = useCallback((priority: DokPriority) => {
    updateEditingDok({ priority });
    durable.queue({ priority });
  }, [durable, updateEditingDok]);
  const saveChanges = useCallback(async () => {
    // A note with nothing else edited is still a save: queue an empty patch so
    // the durable loop has something to flush and the note reaches the server.
    // Merging `{}` leaves any real pending patch untouched.
    if (noteRef.current.trim()) durable.queue({});
    if (!(await durable.flush())) return;
    setNote('');
    setCategory('');
    const savedStatus = queuedStatusRef.current;
    queuedStatusRef.current = null;
    if (savedStatus !== null) {
      persistedStatusRef.current = savedStatus;
      updateEditingDok({ status: savedStatus });
    }
  }, [durable, updateEditingDok]);

  if (!editingDok) return null;
  const dok = editingDok;

  const stepCount = dok.user_actions?.steps.length ?? 0;
  const ruleCount = dok.business_rules?.rules.length ?? 0;
  const acCount = dok.acceptance_criteria?.criteria.length ?? 0;
  const hasPendingChanges = pendingSave?.path === exactPath;
  const hasNote = note.trim().length > 0;
  const isSaving = saveStatus.kind === 'saving' && saveStatus.path === exactPath;
  const saveFailed =
    (saveStatus.kind === 'error' || saveStatus.kind === 'conflict') &&
    saveStatus.path === exactPath;
  const reloadRequired =
    saveStatus.kind === 'error' &&
    saveStatus.path === exactPath &&
    isStaleServerActionError(saveStatus.message);
  const saveLabel = isSaving
    ? 'Saving…'
    : reloadRequired
      ? 'Reload required'
      : saveFailed
        ? 'Retry save'
        : hasPendingChanges && queuedStatusRef.current === 'draft'
          ? 'Save as draft'
          : hasPendingChanges || hasNote
            ? 'Save'
            : 'Saved';

  return (
    <article
      // Click outside any field → clear focus so sidebar falls back to default.
      onClick={(e) => {
        if (e.target === e.currentTarget) clearFocus();
      }}
      className="mx-auto w-full max-w-[760px] px-12 pb-20 pt-8"
    >
      <DokEditorActionBar
        saveLabel={saveLabel}
        saveEnabled={(hasPendingChanges || hasNote) && !isSaving && !reloadRequired}
        onSave={() => void saveChanges()}
        note={note}
        onNoteChange={setNote}
        category={category}
        onCategoryChange={setCategory}
        pendingChange={dok._meta.pending_change}
      />

      {/* Header */}
      <header>
        <div className="mb-3 flex items-center gap-2.5">
          <span className="rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
            {dok.dok_id}
          </span>
          <button
            type="button"
            {...handlers({ kind: 'status' })}
            className={[
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em]',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
              STATUS_BADGE[dok.status],
            ].join(' ')}
          >
            {dok.status}
          </button>
          {dok._meta.generation_confidence != null && (
            <span className="ml-auto font-mono text-[11px] text-ink-muted">
              confidence{' '}
              <span className="font-semibold text-ink">
                {dok._meta.generation_confidence.toFixed(2)}
              </span>
            </span>
          )}
        </div>

        {/* Draft notice — only when status is draft */}
        {dok.status === 'draft' && (
          <div className="mb-5 flex items-center gap-3 rounded-r-md border-l-[3px] border-l-status-draft-fg bg-status-draft-bg px-3.5 py-3">
            <span aria-hidden className="grid h-[18px] w-[18px] shrink-0 place-items-center text-[14px] text-status-draft-fg">
              ✦
            </span>
            <div className="flex-1 text-[13px] text-ink">
              <strong className="font-semibold text-status-draft-fg">Draft · AI-generated</strong> — needs review
              <div className="mt-0.5 text-[12.5px] text-ink-secondary">
                Review each section before promoting this Dok to active. Source freshness is tracked separately.
              </div>
            </div>
            <button
              type="button"
              // Status change joins the same revision-checked durable queue.
              onClick={() => updateDok({ status: 'active' })}
              className="cursor-pointer rounded-md bg-ink-strong px-3 py-1.5 text-[12px] font-medium text-canvas hover:bg-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Mark reviewed → active
            </button>
          </div>
        )}

        {/* Title */}
        <input
          {...handlers({ kind: 'name' })}
          value={tText(dok.name)}
          readOnly={typeof dok.name !== 'string'}
          onChange={(e) => updateDok({ name: e.target.value })}
          className="-mx-2 mt-2 mb-1 block w-[calc(100%+1rem)] rounded-sm border border-transparent bg-transparent px-2 py-1 text-[28px] font-bold leading-tight tracking-[-0.02em] text-ink-strong hover:bg-surface focus:border-accent focus:bg-surface focus:shadow-focus focus:outline-none"
          aria-label="Dok name"
          spellCheck={false}
        />

        {/* Title meta — surfaces + tags + age */}
        <div className="mb-8 flex flex-wrap items-center gap-2.5 text-[12.5px] text-ink-muted">
          <span className="font-mono text-[11px] uppercase tracking-[0.1em]">surfaces</span>
          <div className="flex gap-1">
            {dok.surfaces.map((s) => (
              <span
                key={s}
                className="rounded-full border border-border bg-surface-2 px-2 py-0.5 font-mono text-[10.5px] text-ink-secondary"
              >
                {s}
              </span>
            ))}
          </div>
          <span className="opacity-50">·</span>
          <div className="flex gap-1">
            {dok.tags.map((t) => (
              <span
                key={t}
                className="font-mono text-[10.5px] text-ink-muted before:opacity-60 before:content-['#']"
              >
                {t}
              </span>
            ))}
          </div>
          <span className="opacity-50">·</span>
          <span>just created</span>
        </div>
      </header>

      <Section label="Priority">
        <DokPriorityEditor priority={dok.priority} onChange={updatePriority} />
      </Section>

      {/* Description */}
      <Section label="Description">
        <DescriptionBlock
          value={tText(dok.description)}
          onChange={(v) => updateDok({ description: v })}
          onFocus={handlers({ kind: 'description' }).onFocus}
        />
      </Section>

      {/* User actions */}
      <Section label="User actions" count={`${stepCount} steps`} addLabel="+ step">
        <div className="space-y-2">
          {(dok.user_actions?.steps ?? []).map((step) => (
            <StepCard
              key={step.order}
              step={step}
              onFocus={handlers({ kind: 'step', order: step.order }).onFocus}
            />
          ))}
        </div>
      </Section>

      {/* Business rules */}
      <Section label="Business rules" count={String(ruleCount)} addLabel="+ rule">
        <div className="space-y-1.5">
          {(dok.business_rules?.rules ?? []).map((rule) => (
            <BRItem
              key={rule.id}
              rule={rule}
              onFocus={handlers({ kind: 'rule', id: rule.id }).onFocus}
            />
          ))}
        </div>
      </Section>

      {/* Acceptance criteria */}
      <Section label="Acceptance criteria" count={`${acCount} / ${acCount + 1} filled`} addLabel="+ criterion">
        <div>
          {(dok.acceptance_criteria?.criteria ?? []).map((ac) => (
            <ACItem
              key={ac.id}
              ac={ac}
              onFocus={handlers({ kind: 'criterion', id: ac.id }).onFocus}
            />
          ))}
          <div className="mt-3 rounded-md border border-dashed border-border-strong bg-surface px-4 py-3.5 text-[13.5px] italic leading-relaxed text-ink-muted">
            How would you know this feature 'works correctly'? Write it in one line.
            <div className="mt-1.5 text-[12.5px] not-italic text-ink-faint">
              <span className="mr-1.5 font-mono text-[10px] uppercase tracking-[0.1em]">
                example
              </span>
              After 5 attempts with an invalid card, the user is blocked for 60 seconds.
            </div>
          </div>
        </div>
      </Section>

      {/* _meta — collapsed */}
      <section className="mb-12">
        <button
          type="button"
          onClick={() => setMetaExpanded(!metaExpanded)}
          aria-expanded={metaExpanded}
          {...handlers({ kind: 'meta' })}
          className="flex w-full items-center gap-2.5 rounded-md border border-border bg-surface px-3.5 py-2.5 text-left text-[13px] text-ink-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          <span className="font-mono text-[11px] uppercase tracking-[0.14em]">_meta</span>
          <span className="ml-auto font-mono text-[11px] text-ink-faint">
            version {dok._meta.version}
            {dok._meta.logic_hash && ` · logic_hash ${dok._meta.logic_hash}…`}
            {dok._meta.history?.length ? ` · history ${dok._meta.history.length} events` : ''}
          </span>
          <span className="font-mono text-ink-faint">{metaExpanded ? '▾' : '▸'}</span>
        </button>
        {metaExpanded && (
          <div className="mt-2 space-y-1 rounded-md border border-border bg-surface px-3.5 py-3 font-mono text-[11.5px] leading-relaxed text-ink-secondary">
            <div>version: {dok._meta.version}</div>
            {dok._meta.logic_hash && <div>logic_hash: {dok._meta.logic_hash}…</div>}
            {dok._meta.generation_confidence != null && (
              <div>generation_confidence: {dok._meta.generation_confidence.toFixed(2)}</div>
            )}
            {dok._meta.updated_at && <div>updated_at: {dok._meta.updated_at}</div>}
            {/* Version is not a key: an approval and the edit it confirms can
                share one, and hand-written files repeat them freely. */}
            {(dok._meta.history ?? []).map((h, i) => (
              <div key={`${h.version}-${i}`}>{historyRowText(h)}</div>
            ))}
            {dok._meta.pending_change && (
              <div className="text-ink-faint">
                pending: {dok._meta.pending_change.summary}
                {' '}({dok._meta.pending_change.source})
              </div>
            )}
          </div>
        )}
      </section>
    </article>
  );
}

function DokEditorActionBar({
  saveLabel,
  saveEnabled,
  onSave,
  note,
  onNoteChange,
  category,
  onCategoryChange,
  pendingChange,
}: {
  saveLabel: string;
  saveEnabled: boolean;
  onSave: () => void;
  note: string;
  onNoteChange: (value: string) => void;
  category: '' | DokHistoryCategory;
  onCategoryChange: (value: '' | DokHistoryCategory) => void;
  pendingChange?: DokPendingChange;
}) {
  const { push } = useSafeNavigation();
  const { editingDok } = useStudio();

  return (
    <nav
      aria-label="Dok editor actions"
      className="mb-6 flex flex-col gap-2 border-b border-border pb-4"
    >
      <div className="flex min-h-9 items-center justify-between gap-3">
        <div className="flex shrink-0 items-center gap-3">
          <button
            type="button"
            onClick={() => void push('/doks')}
            className="inline-flex items-center gap-1.5 rounded-sm text-[12.5px] font-medium text-ink-muted transition-colors hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <ArrowLeft aria-hidden size={14} strokeWidth={1.75} />
            Back to Doks
          </button>
          {editingDok && (
            <button
              type="button"
              onClick={() => void push(`/doks/${editingDok.dok_id}`)}
              className="rounded-sm text-[12.5px] font-medium text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              Read view
            </button>
          )}
        </div>
        <div className="flex min-w-0 items-center gap-2">
          <input
            name="change-note"
            value={note}
            onChange={(e) => onNoteChange(e.target.value)}
            maxLength={500}
            placeholder="What changed? (optional)"
            aria-label="Change note"
            spellCheck={false}
            className="min-w-0 flex-1 rounded-md border border-border bg-surface px-2.5 py-1.5 text-[12px] text-ink placeholder:text-ink-faint focus:border-accent focus:shadow-focus focus:outline-none sm:w-[260px]"
          />
          <select
            name="change-category"
            aria-label="Change category"
            value={category}
            onChange={(e) => onCategoryChange(e.target.value as '' | DokHistoryCategory)}
            className="shrink-0 rounded-md border border-border bg-surface px-2 py-1.5 text-[12px] text-ink-secondary focus:border-accent focus:shadow-focus focus:outline-none"
          >
            {CHANGE_CATEGORIES.map((option) => (
              <option key={option.value || 'changed'} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            onClick={onSave}
            disabled={!saveEnabled}
            className={[
              'shrink-0 rounded-md px-3 py-1.5 text-[12px] font-semibold transition-colors',
              'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
              saveEnabled
                ? 'bg-accent text-canvas hover:bg-accent-hover'
                : 'cursor-not-allowed border border-border bg-surface-2 text-ink-faint',
            ].join(' ')}
          >
            {saveLabel}
          </button>
        </div>
      </div>
      {pendingChange && (
        // A regeneration staged a summary; it becomes history only when a
        // person activates the Dok. Saying so here is what makes approval an
        // informed act rather than a button press.
        <div
          data-testid="pending-proposal"
          className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 text-[12px] text-ink-secondary"
        >
          <span>
            <span className="font-medium text-ink">Proposed:</span> {pendingChange.summary}
          </span>
          <span className="text-[11.5px] text-ink-faint">
            Recorded to history when you activate — your note overrides it.
          </span>
        </div>
      )}
    </nav>
  );
}

// ── Section primitives ──────────────────────────────────────────────

function Section({
  label,
  count,
  addLabel,
  children,
}: {
  label: string;
  count?: string;
  addLabel?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-12">
      <header className="mb-3.5 flex items-center gap-2.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          {label}
        </span>
        {count && <span className="font-mono text-[11px] text-ink-faint">{count}</span>}
        {addLabel && (
          <span className="ml-auto px-2 py-1 text-[12px] text-ink-muted">
            {addLabel}
          </span>
        )}
      </header>
      {children}
    </section>
  );
}

function DescriptionBlock({
  value,
  onChange,
  onFocus,
}: {
  value: string;
  onChange: (v: string) => void;
  onFocus: () => void;
}) {
  return (
    <div>
      <textarea
        value={value}
        onFocus={onFocus}
        onChange={(e) => onChange(e.target.value)}
        rows={3}
        className="block w-full resize-y rounded-md border border-border bg-surface px-4 py-3.5 text-[15.5px] leading-[1.75] text-ink-strong focus:border-accent focus:bg-surface focus:shadow-focus focus:outline-none"
        aria-label="Description"
        spellCheck={false}
      />
    </div>
  );
}

function mergeDokPatch(
  current: DokEditPatch | null,
  next: DokEditPatch,
): DokEditPatch {
  return { ...current, ...next };
}

function StepCard({ step, onFocus }: { step: UserActionStep; onFocus: () => void }) {
  return (
    <button
      type="button"
      onClick={onFocus}
      onFocus={onFocus}
      className="block w-full cursor-text rounded-md border border-border bg-surface px-4 py-3.5 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <div className="mb-2 flex items-center gap-2.5">
        <span className="grid h-5.5 w-5.5 shrink-0 place-items-center rounded-full border border-border bg-surface-2 font-mono text-[11px] font-semibold text-ink-muted">
          {step.order}
        </span>
        <span
          className={[
            'inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[10.5px] tracking-[0.04em]',
            ACTOR_TONE[step.actor.kind],
          ].join(' ')}
        >
          <span aria-hidden>{actorIcon(step.actor)}</span>
          <span>{actorLabel(step.actor)}</span>
        </span>
      </div>
      <div className="my-1.5 text-[14.5px] leading-[1.55] text-ink-strong">
        {tText(step.intent)}
      </div>
      <div className="text-[13px] leading-relaxed text-ink-muted before:mr-1.5 before:text-ink-faint before:content-['→']">
        {tText(step.outcome)}
      </div>
      {step.variants && step.variants.length > 0 && (
        <div className="mt-2.5 border-t border-dashed border-border pt-2.5 text-[12px] text-ink-muted">
          {step.variants.map((v) => `${v.platform} : ${v.interaction}`).join(' · ')}
          <span className="ml-2 italic text-ink-faint hover:text-accent hover:underline">
            + on other platforms?
          </span>
        </div>
      )}
    </button>
  );
}

function BRItem({ rule, onFocus }: { rule: BusinessRule; onFocus: () => void }) {
  return (
    <button
      type="button"
      onClick={onFocus}
      onFocus={onFocus}
      className="grid w-full grid-cols-[auto_1fr_auto] items-start gap-3 rounded-md border border-border bg-surface px-3.5 py-3 text-left transition-colors hover:border-border-strong focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <span className="pt-0.5 font-mono text-[10.5px] text-ink-muted">{rule.id}</span>
      <span className="text-[13.5px] leading-relaxed text-ink">
        {tText(rule.description)}
      </span>
      <span
        className={[
          'rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-[0.08em]',
          BR_TONE[rule.type],
        ].join(' ')}
      >
        {rule.type}
      </span>
    </button>
  );
}

function ACItem({ ac, onFocus }: { ac: AcceptanceCriterion; onFocus: () => void }) {
  return (
    <button
      type="button"
      onClick={onFocus}
      onFocus={onFocus}
      className="flex w-full items-start gap-3 border-b border-border py-2.5 text-left text-[13.5px] leading-relaxed text-ink last:border-b-0 hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <span aria-hidden className="mt-0.5 shrink-0 text-[14px] text-status-active-fg">✓</span>
      <span className="flex-1">{tText(ac.statement)}</span>
      <span className="shrink-0 font-mono text-[10.5px] text-ink-faint">
        {ac.id.slice(-2)}
        {ac.related_rules.length > 0 && ` · → BR-…${ac.related_rules[0].slice(-2)}`}
      </span>
    </button>
  );
}
