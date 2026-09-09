'use client';

import { useCallback, useRef } from 'react';
import { CircleDot } from 'lucide-react';
import type { Dok, Translatable } from '@doklo-beta/core';
import type { BlastRadius, BusinessImpact } from '@doklo-beta/core/schemas';
import {
  useDoksByDomain,
  useDokStats,
  useStudio,
  type DokFilter,
} from '../../../components/studio-store';
import { DOMAIN_META } from '../../../lib/dok-meta';
import { criticalReason, tierRowTokens } from '../../../lib/dok-priority-order';
import { SmartSidebar } from '../../../components/smart-sidebar';
import { DokPreview } from '../../../components/dok-preview';
import { useDokDeepLink } from '../../../lib/hooks/use-deep-link-sync';
import { useListKeyboardNav } from '../../../lib/hooks/use-list-keyboard-nav';
import { useDoks } from '../../../components/studio-store';
import { LoadRecovery } from '../../../components/load-recovery';
import {
  DokBulkReviewBar,
  useDokBulkReviewController,
} from '../../../components/dok-bulk-review';

// ──────────────────────────────────────────────────────────────────────
// Presentation tokens — kept inline because they're catalog-specific.
// Phase 4+ might lift STATUS_PIP into a shared map once SmartSidebar
// and the rail both render status dots, but no consumer needs it yet.
// ──────────────────────────────────────────────────────────────────────

type DokStatus = Dok['status'];

const STATUS_PIP: Record<DokStatus, string> = {
  active:     'bg-status-active-fg',
  draft:      'bg-status-draft-fg',
  review:     'bg-status-review-fg',
  planned:    'bg-status-planned-fg',
  deprecated: 'bg-status-deprecated-fg',
  archived:   'bg-status-archived-fg',
};

const FILTERS: { id: DokFilter; label: string }[] = [
  { id: 'all',    label: 'All' },
  { id: 'active', label: 'Active' },
  { id: 'draft',  label: 'Draft' },
  { id: 'review', label: 'Review' },
];

const IMPACT_FILTERS: { id: BusinessImpact | 'all'; label: string }[] = [
  { id: 'all',        label: 'Any impact' },
  { id: 'revenue',    label: 'Revenue' },
  { id: 'core_value', label: 'Core value' },
  { id: 'compliance', label: 'Compliance' },
  { id: 'enabling',   label: 'Enabling' },
  { id: 'supporting', label: 'Supporting' },
];

const BLAST_FILTERS: { id: BlastRadius | 'all'; label: string }[] = [
  { id: 'all',       label: 'Any blast radius' },
  { id: 'blocking',  label: 'Blocking' },
  { id: 'degrading', label: 'Degrading' },
  { id: 'cosmetic',  label: 'Cosmetic' },
];

const SORT_LABEL: Record<'priority' | 'id' | 'recent', string> = {
  priority: 'Priority',
  id: 'ID',
  recent: 'Recent',
};

const NEXT_SORT: Record<'priority' | 'id' | 'recent', 'priority' | 'id' | 'recent'> = {
  priority: 'id',
  id: 'recent',
  recent: 'priority',
};

/** Translatable → display text. Inline strings render verbatim; TermRefs
 *  fall back to a `{TERM-ID}` placeholder until Phase 5+ wires Lexicon. */
function tText(t: Translatable): string {
  return typeof t === 'string' ? t : `{${t.term_ref}}`;
}

// ──────────────────────────────────────────────────────────────────────

export default function DokCatalogPage() {
  const { doksState } = useStudio();
  if (doksState.kind === 'invalid' || doksState.kind === 'unreadable') {
    return <LoadRecovery layer="doks" state={doksState} />;
  }
  return <DokCatalogReady />;
}

function DokCatalogReady() {
  useDokDeepLink();
  const grouped = useDoksByDomain();
  const stats = useDokStats();
  const flatDoks = useDoks();
  const {
    doks,
    doksState,
    workspaceState,
    filter,
    setFilter,
    impactFilter,
    setImpactFilter,
    blastFilter,
    setBlastFilter,
    sort,
    setSort,
    selectedDokId,
    setSelectedDok,
  } = useStudio();
  const revisions =
    doksState.kind === 'ready' || doksState.kind === 'empty'
      ? doksState.data.revisions
      : {};
  const locale =
    workspaceState.kind === 'ready' || workspaceState.kind === 'empty'
      ? workspaceState.data.default_locale
      : 'en';
  const preReviewFilterRef = useRef<DokFilter | null>(null);
  const handleReviewModeChange = useCallback((reviewMode: boolean) => {
    if (reviewMode) {
      preReviewFilterRef.current = filter;
      setFilter('draft');
      return;
    }

    const preReviewFilter = preReviewFilterRef.current;
    preReviewFilterRef.current = null;
    if (preReviewFilter !== null) setFilter(preReviewFilter);
  }, [filter, setFilter]);
  const bulkReview = useDokBulkReviewController({
    doks,
    revisions,
    locale,
    onReviewModeChange: handleReviewModeChange,
  });
  // ↑/↓ across the flat filtered list (groups are visual, not logical).
  const listNav = useListKeyboardNav({
    items: flatDoks,
    selectedId: selectedDokId,
    getKey: (d) => d.dok_id,
    onSelect: setSelectedDok,
  });

  // Counts shown inside each filter chip reflect "rows after this filter
  // is applied", not the filtered-down view's size. So they're sourced
  // from the unfiltered stats, not from `grouped`.
  const filterCount: Record<DokFilter, number> = {
    all:    stats.total,
    active: stats.active,
    draft:  stats.draft,
    review: stats.review,
  };

  return (
    <div className="flex h-full">
      <main className="min-w-0 flex-1 overflow-y-auto">
      {/* Page header */}
      <header className="border-b border-border bg-canvas px-8 pb-4 pt-6">
        <div className="mb-1 flex items-center gap-3">
          <CircleDot size={18} aria-hidden className="text-ink-muted" />
          <h1 className="text-[22px] font-semibold tracking-tight text-ink-strong">
            Doks
          </h1>
        </div>
        <p className="max-w-[680px] text-sm text-ink-muted">
          Every business feature defined in this workspace. Grouped by domain, filtered by status.
        </p>
        <WorkspaceSummary />
        <div className="mt-3.5 flex flex-wrap items-baseline gap-x-6 gap-y-1 font-mono text-xs text-ink-muted">
          <Stat n={String(stats.total)}   label="doks" />
          <Stat n={String(stats.domains)} label="domains" />
          <Stat n={String(stats.active)}  label="active" tone="success" />
          <Stat n={String(stats.draft)}   label="draft" />
          <Stat
            n={stats.avg_confidence == null ? '—' : `${Math.round(stats.avg_confidence * 100)}%`}
            label="avg confidence"
            tone="accent"
          />
        </div>
      </header>

      {/* Filters and bulk-review controls */}
      <div className={bulkReview.reviewMode ? 'sticky top-0 z-20 bg-canvas' : undefined}>
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-canvas px-8 py-2.5">
          {FILTERS.map((f) => (
            <FilterChip
              key={f.id}
              label={f.label}
              count={filterCount[f.id]}
              active={filter === f.id}
              onClick={() => {
                if (bulkReview.reviewMode) {
                  bulkReview.cancelReviewMode();
                } else {
                  bulkReview.clearForFilterChange();
                }
                setFilter(f.id);
              }}
            />
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <select
              aria-label="Filter by business impact"
              value={impactFilter}
              onChange={(event) => {
                bulkReview.clearForFilterChange();
                setImpactFilter(event.target.value as BusinessImpact | 'all');
              }}
              className="rounded-full border border-border bg-transparent px-3 py-1 text-[12.5px] text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {IMPACT_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
            <select
              aria-label="Filter by blast radius"
              value={blastFilter}
              onChange={(event) => {
                bulkReview.clearForFilterChange();
                setBlastFilter(event.target.value as BlastRadius | 'all');
              }}
              className="rounded-full border border-border bg-transparent px-3 py-1 text-[12.5px] text-ink-secondary focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              {BLAST_FILTERS.map((f) => (
                <option key={f.id} value={f.id}>{f.label}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setSort(NEXT_SORT[sort])}
              aria-label={`Sort Doks by ${SORT_LABEL[NEXT_SORT[sort]]}`}
              className="inline-flex items-center rounded-full border border-border bg-transparent px-3 py-1 text-[12.5px] text-ink-secondary hover:bg-surface hover:text-ink focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
            >
              Sort · {SORT_LABEL[sort]}
            </button>
          </div>
        </div>
        <DokBulkReviewBar controller={bulkReview} draftCount={stats.draft} />
      </div>

      {/* Catalog */}
      <div tabIndex={-1} onKeyDown={listNav.onKeyDown} className="outline-none">
        {stats.total === 0 ? (
          <EmptyCatalog />
        ) : grouped.length === 0 ? (
          <div className="px-8 py-12 text-center text-sm text-ink-muted">
            No matching Doks. Try a different filter.
          </div>
        ) : (
          grouped.map(([domain, doks]) => {
            const meta = DOMAIN_META[domain] ?? { icon: '◆', subtitle: '' };
            return (
              <section key={domain}>
                <div
                  className={[
                    bulkReview.reviewMode ? '' : 'sticky top-0 z-10',
                    'flex items-center gap-3 border-b border-border bg-canvas px-8 pb-2.5 pt-[18px]',
                  ].join(' ')}
                >
                  <span aria-hidden className="text-sm">{meta.icon}</span>
                  <span className="font-mono text-[11px] font-semibold uppercase tracking-[0.14em] text-ink-strong">
                    {domain}{meta.subtitle ? ` · ${meta.subtitle}` : ''}
                  </span>
                  <span className="ml-auto font-mono text-[11px] text-ink-muted">
                    <span className="font-semibold text-ink">{doks.length}</span>{' '}
                    {doks.length === 1 ? 'dok' : 'doks'}
                  </span>
                </div>
                {doks.map((dok) => (
                  <CatalogRow
                    key={dok.dok_id}
                    dok={dok}
                    selected={selectedDokId === dok.dok_id}
                    onClick={() => setSelectedDok(dok.dok_id)}
                    reviewMode={bulkReview.reviewMode}
                    reviewSelected={bulkReview.selectedIds.has(dok.dok_id)}
                    warningId={bulkReview.warningId}
                    onToggleReview={() => bulkReview.toggleDok(dok.dok_id)}
                  />
                ))}
              </section>
            );
          })
        )}
      </div>
      </main>
      <SmartSidebar>
        <DokPreview />
      </SmartSidebar>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────
// Local presentational pieces.
// ──────────────────────────────────────────────────────────────────────

function WorkspaceSummary() {
  const { workspaceState, doks } = useStudio();
  const workspace =
    workspaceState.kind === 'ready' || workspaceState.kind === 'empty'
      ? workspaceState.data
      : null;
  const anchored = doks.filter(
    (dok) => (dok._meta.source_anchors?.length ?? 0) > 0,
  ).length;
  const generationState =
    doks.length === 0
      ? 'not generated'
      : anchored === doks.length
        ? 'generated'
        : 'partial';

  return (
    <section
      aria-label="Workspace summary"
      className="mt-4 rounded-lg border border-border bg-surface px-4 py-3"
    >
      <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
        <strong className="text-[13.5px] font-semibold text-ink-strong">
          {workspace?.name ?? 'Workspace setup is missing'}
        </strong>
        <span className="font-mono text-[11px] text-ink-muted">
          {workspace
            ? workspace.services.length > 0
              ? `Services · ${workspace.services.map((service) => service.service_id).join(', ')}`
              : 'No services configured'
            : `Expected at ${workspaceState.path}`}
        </span>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-5 gap-y-1 font-mono text-[11.5px] text-ink-secondary">
        <span><b className="text-ink">{doks.length}</b> Doks</span>
        <span><b className="text-ink">{anchored}</b> with source anchors</span>
        <span>Generation evidence · <b className="text-ink">{generationState}</b></span>
      </div>
    </section>
  );
}

/** Shown when the workspace has zero Doks — the catalog can't render
 *  anything real, so point the user at the extractor instead of an empty
 *  grid. Mirrors the consolidation screen's "Run doklo generate" block. */
function EmptyCatalog() {
  return (
    <div className="flex items-center justify-center px-8 py-20 text-center text-ink-muted">
      <div>
        <p className="text-sm">No doks in this workspace.</p>
        <p className="mt-1 text-xs">
          Run <code>doklo generate</code> to extract them from code.
        </p>
      </div>
    </div>
  );
}

function Stat({
  n,
  label,
  tone,
}: {
  n: string;
  label: string;
  tone?: 'success' | 'accent';
}) {
  const numCls =
    tone === 'success' ? 'text-status-active-fg' :
    tone === 'accent'  ? 'text-accent' :
                         'text-ink';
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`text-base font-semibold ${numCls}`}>{n}</span>
      <span>{label}</span>
    </span>
  );
}

function FilterChip({
  label,
  count,
  active,
  onClick,
}: {
  label: string;
  count: number;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        active
          ? 'border-accent-soft-strong bg-accent-soft text-accent-ink'
          : 'border-border bg-transparent text-ink-secondary hover:bg-surface hover:text-ink',
      ].join(' ')}
    >
      <span>{label}</span>
      <span className={['font-mono text-[11px]', active ? 'text-accent-ink' : 'text-ink-faint'].join(' ')}>
        {count}
      </span>
    </button>
  );
}

function CatalogRow({
  dok,
  selected,
  onClick,
  reviewMode,
  reviewSelected,
  warningId,
  onToggleReview,
}: {
  dok: Dok;
  selected: boolean;
  onClick: () => void;
  reviewMode: boolean;
  reviewSelected: boolean;
  warningId: string;
  onToggleReview: () => void;
}) {
  const pipClass = STATUS_PIP[dok.status];
  // The selected row already spends the left-edge bar on the accent marker.
  // Drawing the tier bar there too would blur which signal means "selected",
  // so selection wins and the tier marker steps aside.
  const tier = tierRowTokens(dok);
  // Only critical rows are labelled. Tagging every row states the obvious for
  // `standard` and drowns the few that need attention.
  const critical = criticalReason(dok);
  return (
    <div
      className={[
        'group flex w-full border-b border-border text-sm transition-colors',
        selected
          ? 'bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]'
          : `hover:bg-surface ${tier.marker}`,
      ].join(' ')}
    >
      {reviewMode && dok.status === 'draft' ? (
        <div className="flex shrink-0 items-center pl-8 pr-1">
          <input
            type="checkbox"
            aria-label={`Select ${dok.dok_id} for review`}
            aria-describedby={warningId}
            checked={reviewSelected}
            onChange={onToggleReview}
            className="h-4 w-4 rounded border-border text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          />
        </div>
      ) : null}
      <button
        type="button"
        data-row-id={dok.dok_id}
        onClick={onClick}
        aria-current={selected ? 'true' : undefined}
        className={[
          'min-w-0 flex-1 py-3.5 text-left',
          reviewMode && dok.status === 'draft' ? 'pl-3 pr-8' : 'px-8',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        ].join(' ')}
      >
        <span className="mb-1.5 flex items-center gap-2.5">
          <span className="flex-shrink-0 rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
            {dok.dok_id}
          </span>
          <span
            className={[
              'flex-1 truncate text-[15px] font-semibold tracking-tight',
              tier.text === '' ? 'text-ink-strong' : tier.text,
            ].join(' ')}
          >
            {tText(dok.name)}
          </span>
          {critical !== null && (
            <span
              title={`Critical — ${critical}`}
              className="flex-shrink-0 rounded bg-status-deprecated-bg px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-status-deprecated-fg"
            >
              {critical}
            </span>
          )}
          <span
            aria-label={`status ${dok.status}`}
            className={`h-1.5 w-1.5 flex-shrink-0 rounded-full ${pipClass}`}
          />
        </span>
        <span className="line-clamp-1 text-[13.5px] text-ink-muted">
          {tText(dok.description)}
        </span>
      </button>
    </div>
  );
}
