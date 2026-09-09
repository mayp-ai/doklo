'use client';

import { useEffect } from 'react';
import { LayoutGrid, ListTree, Map as MapIcon } from 'lucide-react';
import {
  useIaStats,
  useSelectedIaTree,
  useStudio,
  IA_DEPTH_MIN,
  IA_DEPTH_MAX,
  IA_DEPTH_DEFAULT,
  type IaFilter,
  type IaView,
  type StudioIaTree,
} from '../../../components/studio-store';
import { SmartSidebar } from '../../../components/smart-sidebar';
import { IaTree } from '../../../components/ia-tree';
import { IaOverview } from '../../../components/ia-overview';
import { IaTreePicker } from '../../../components/ia-tree-picker';
import { RoutePreview } from '../../../components/route-preview';
import { useRouteDeepLink } from '../../../lib/hooks/use-deep-link-sync';

const FILTERS: { id: IaFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'mapped', label: 'Mapped' },
  { id: 'unmapped', label: 'Unmapped' },
  { id: 'desktop', label: 'Desktop only' },
  { id: 'mobile', label: 'Mobile only' },
];

const VIEW_TABS: { id: IaView; label: string; icon: typeof LayoutGrid }[] = [
  { id: 'overview', label: 'Overview', icon: LayoutGrid },
  { id: 'tree', label: 'Tree', icon: ListTree },
];

// Copy per tree type. The v2 types come first; `sitemap` and `feature_group`
// stay for the v1 files Studio still reads unchanged.
const IA_COPY: Record<
  StudioIaTree['type'],
  { title: string; description: string }
> = {
  route_hierarchy: {
    title: 'Overview · Route hierarchy',
    description:
      'Code-derived URL structure. It states which routes exist, nothing about how people are meant to move through the product.',
  },
  organization: {
    title: 'Product organization · Curated',
    description:
      'Product areas someone grouped by hand, independent from the URL structure.',
  },
  navigation: {
    title: 'Navigation · Curated',
    description:
      'Menus, tabs, and entry points someone curated by hand.',
  },
  sitemap: {
    title: 'Sitemap · Route hierarchy',
    description:
      'Code-backed page hierarchy. It does not claim to be the product navigation.',
  },
  feature_group: {
    title: 'Feature groups · Business structure',
    description:
      'Business capabilities grouped independently from URL hierarchy.',
  },
};

export default function IaPage() {
  useRouteDeepLink();
  const selectedTree = useSelectedIaTree();
  const stats = useIaStats();
  const {
    iaTrees,
    routeFilter,
    setRouteFilter,
    iaView,
    setIaView,
    iaDepth,
    setIaDepth,
  } = useStudio();
  const copy = selectedTree
    ? IA_COPY[selectedTree.type]
    : {
        title: 'IA · Information architecture',
        description:
          'Select a typed structure to inspect its hierarchy without flattening its meaning.',
      };
  const hasTrees = iaTrees.length > 0;
  const hasNodes = selectedTree
    ? selectedTree.nodes.length > 0
    : false;

  const filterCount: Record<IaFilter, number> = {
    all: stats.total,
    mapped: stats.mapped,
    unmapped: stats.unmapped,
    desktop: stats.desktopOnly,
    mobile: stats.mobileOnly,
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === 'INPUT' ||
          target.tagName === 'TEXTAREA' ||
          target.tagName === 'SELECT' ||
          target.isContentEditable)
      ) {
        return;
      }
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === '[') {
        event.preventDefault();
        setIaDepth(iaDepth - 1);
      } else if (event.key === ']') {
        event.preventDefault();
        setIaDepth(iaDepth + 1);
      } else if (event.key === '\\') {
        event.preventDefault();
        setIaDepth(IA_DEPTH_DEFAULT);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [iaDepth, setIaDepth]);

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        <header className="border-b border-border bg-canvas px-8 pb-4 pt-6">
          <div className="mb-1 flex items-center gap-2.5">
            <MapIcon size={18} aria-hidden className="text-ink-muted" />
            <h1 className="text-balance text-[22px] font-semibold tracking-tight text-ink-strong">
              {copy.title}
            </h1>
          </div>
          <p className="max-w-[680px] text-[13.5px] text-ink-muted">
            {copy.description}
          </p>
          {selectedTree && hasNodes ? (
            <div className="mt-3.5 flex flex-wrap items-baseline gap-x-[22px] gap-y-1 font-mono text-xs text-ink-muted">
              <Stat n={String(stats.total)} label="routable nodes" />
              <Stat
                n={String(stats.mapped)}
                label="dok-mapped"
                tone="accent"
              />
              <Stat
                n={String(stats.unmapped)}
                label="unmapped"
                tone="warn"
              />
              <Stat
                n={String(stats.dynamic)}
                label="dynamic segments"
              />
              <Stat
                n={String(stats.bothPlatforms)}
                label="desktop+mobile"
                tone="success"
              />
            </div>
          ) : null}
        </header>

        {hasTrees ? (
          <>
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border bg-canvas px-8 py-2.5">
              <div className="flex flex-wrap items-center gap-3">
                <IaTreePicker />
                <div
                  role="tablist"
                  aria-label="IA view"
                  className="inline-flex items-center gap-1 rounded-md border border-border bg-surface p-0.5"
                >
                  {VIEW_TABS.map((tab) => {
                    const Icon = tab.icon;
                    const active = iaView === tab.id;
                    return (
                      <button
                        key={tab.id}
                        role="tab"
                        type="button"
                        id={`ia-view-${tab.id}`}
                        aria-controls="ia-view-panel"
                        aria-selected={active}
                        onClick={() => setIaView(tab.id)}
                        className={[
                          'inline-flex items-center gap-1.5 rounded px-3 py-1 text-[12.5px] transition-colors',
                          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-1 focus-visible:ring-offset-canvas',
                          active
                            ? 'bg-canvas text-ink-strong shadow-sm'
                            : 'text-ink-muted hover:text-ink',
                        ].join(' ')}
                      >
                        <Icon size={14} aria-hidden />
                        <span>{tab.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>

              <DepthSlider value={iaDepth} onChange={setIaDepth} />
            </div>

            {hasNodes ? (
              <>
                <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-canvas px-8 py-2.5">
                  {FILTERS.map((filter) => (
                    <FilterChip
                      key={filter.id}
                      label={filter.label}
                      count={filterCount[filter.id]}
                      active={routeFilter === filter.id}
                      onClick={() => setRouteFilter(filter.id)}
                    />
                  ))}
                </div>

                <div
                  id="ia-view-panel"
                  role="tabpanel"
                  aria-labelledby={`ia-view-${iaView}`}
                  className="flex min-h-0 flex-1 flex-col"
                >
                  {iaView === 'overview' ? <IaOverview /> : <IaTree />}
                </div>
              </>
            ) : (
              <EmptySelectedTree tree={selectedTree} />
            )}
          </>
        ) : (
          <EmptyIaCatalog />
        )}
      </main>
      <SmartSidebar>
        <RoutePreview />
      </SmartSidebar>
    </div>
  );
}

function EmptyIaCatalog() {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-20 text-center text-ink-muted">
      <div>
        <p className="text-sm">No IA structures in this workspace.</p>
        <p className="mt-1 text-xs">
          Run <code>doklo generate</code> to extract a code-derived route
          hierarchy.
        </p>
      </div>
    </div>
  );
}

function EmptySelectedTree({ tree }: { tree: StudioIaTree | null }) {
  return (
    <div className="flex flex-1 items-center justify-center px-8 py-20 text-center text-ink-muted">
      <div>
        <p className="text-sm">
          This{' '}
          {tree
            ? IA_COPY[tree.type].title.split(' · ')[0].toLowerCase()
            : 'structure'}{' '}
          has no nodes.
        </p>
        <p className="mt-1 text-xs">
          Choose another structure or add evidence to this tree.
        </p>
      </div>
    </div>
  );
}

function DepthSlider({
  value,
  onChange,
}: {
  value: number;
  onChange: (depth: number) => void;
}) {
  return (
    <div className="inline-flex items-center gap-3">
      <label
        htmlFor="ia-depth"
        className="font-mono text-[11px] uppercase tracking-[0.05em] text-ink-faint"
      >
        Depth
      </label>
      <input
        id="ia-depth"
        type="range"
        min={IA_DEPTH_MIN}
        max={IA_DEPTH_MAX}
        step={1}
        value={value}
        onChange={(event) =>
          onChange(parseInt(event.currentTarget.value, 10))
        }
        aria-valuemin={IA_DEPTH_MIN}
        aria-valuemax={IA_DEPTH_MAX}
        aria-valuenow={value}
        aria-valuetext={value >= IA_DEPTH_MAX ? 'all' : String(value)}
        className="h-1 w-[140px] cursor-pointer appearance-none rounded-full bg-border accent-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      />
      <span className="min-w-[2.5em] text-center font-mono text-[12px] tabular-nums text-ink-secondary">
        {value >= IA_DEPTH_MAX ? 'all' : value}
      </span>
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
  tone?: 'accent' | 'warn' | 'success';
}) {
  const className =
    tone === 'accent'
      ? 'text-accent'
      : tone === 'warn'
        ? 'text-status-draft-fg'
        : tone === 'success'
          ? 'text-status-active-fg'
          : 'text-ink';

  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`text-sm font-semibold tabular-nums ${className}`}>
        {n}
      </span>
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
      <span
        className={[
          'font-mono text-[11px]',
          active ? 'text-accent-ink' : 'text-ink-faint',
        ].join(' ')}
      >
        {count}
      </span>
    </button>
  );
}
