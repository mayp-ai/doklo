'use client';

import { useMemo } from 'react';
import { FileText, FolderTree } from 'lucide-react';

import {
  useSelectedIaTree,
  useStudio,
  type StudioIaNode,
} from './studio-store';
import {
  buildSitemapCards,
  iaMatchesBelowDepth,
  type SitemapListing,
} from '../lib/ia-presentation';
import { iaNodeDokRefs } from '../lib/ia-route';

type NodeTone = 'mapped' | 'container' | 'unmapped';

const TONE_COPY: Record<
  NodeTone,
  { className: string; label: string }
> = {
  mapped: {
    className: 'bg-accent-soft text-accent-ink',
    label: 'Dok linked',
  },
  container: {
    className: 'bg-surface-2 text-ink-muted',
    label: 'Section',
  },
  unmapped: {
    className: 'bg-status-draft-bg text-status-draft-fg',
    label: 'Unmapped',
  },
};

function nodeTone(node: StudioIaNode): NodeTone {
  if (iaNodeDokRefs(node).length > 0) return 'mapped';
  if (node.unmapped) return 'unmapped';
  return 'container';
}

/** Bound Dok ids, in file order. One for v1, zero-or-more for a v2 destination. */
function DokRefs({ node }: { node: StudioIaNode }) {
  return (
    <>
      {iaNodeDokRefs(node).map((dokRef) => (
        <span key={dokRef} className="font-mono text-[9.5px] text-accent-ink">
          {dokRef}
        </span>
      ))}
    </>
  );
}

function nodePath(node: StudioIaNode): string {
  if (node.path === '') return '""';
  return node.path ?? 'Grouping node';
}

function NodeStatus({ node }: { node: StudioIaNode }) {
  const tone = TONE_COPY[nodeTone(node)];

  return (
    <span
      className={[
        'shrink-0 rounded-full px-2 py-0.5 text-[10px] font-medium',
        tone.className,
      ].join(' ')}
    >
      {tone.label}
    </span>
  );
}

function PlatformException({ node }: { node: StudioIaNode }) {
  if (node.platform === 'both') return null;

  return (
    <span className="shrink-0 text-[10px] text-ink-faint">
      {node.platform === 'desktop-only' ? 'Desktop' : 'Mobile'}
    </span>
  );
}

/**
 * The filter keeps ancestors of a match as context, so a depth shallower than
 * the matches leaves a branch showing context rows only — or nothing at all.
 * Naming the count is what separates "the filter found nothing here" from
 * "the depth is hiding what it found". Zero whenever no filter is active.
 */
function DepthCutoffNote({
  hiddenMatchCount,
  hasListings,
}: {
  hiddenMatchCount: number;
  hasListings: boolean;
}) {
  const plural = hiddenMatchCount !== 1;

  if (hiddenMatchCount === 0) {
    return hasListings ? null : (
      <p className="border-t border-border bg-surface px-4 py-3 text-xs text-ink-faint">
        This section has no visible descendants at the current depth.
      </p>
    );
  }

  return (
    <p
      data-testid="overview-depth-hint"
      className="border-t border-border bg-surface px-4 py-3 text-xs text-ink-faint"
    >
      {hasListings
        ? `${hiddenMatchCount} ${plural ? 'matches' : 'match'} below current depth`
        : `${hiddenMatchCount} ${
            plural ? 'matches are' : 'match is'
          } below the current depth. Raise depth to see ${
            plural ? 'them' : 'it'
          }.`}
    </p>
  );
}

function RootSection({
  node,
  listings,
  hiddenMatchCount,
  selectedKey,
  onSelect,
}: {
  node: StudioIaNode;
  listings: SitemapListing[];
  hiddenMatchCount: number;
  selectedKey: string | null;
  onSelect: (key: string) => void;
}) {
  const selected = node.key === selectedKey;
  const descendantCount = listings.length;

  return (
    <section
      data-testid="overview-branch"
      aria-labelledby={`overview-branch-${node.key}`}
      className={[
        'overflow-hidden rounded-lg border bg-canvas shadow-sm',
        selected ? 'border-accent' : 'border-border',
      ].join(' ')}
    >
      <button
        type="button"
        onClick={() => onSelect(node.key)}
        aria-label={`Select ${node.title}, ${nodePath(node)}`}
        className={[
          'group flex w-full items-start gap-3 px-4 py-4 text-left',
          'transition-colors hover:bg-surface-2 active:bg-surface-3',
          'focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-inset focus-visible:ring-accent',
          selected ? 'bg-accent-soft' : 'bg-canvas',
        ].join(' ')}
      >
        <span
          aria-hidden
          className={[
            'mt-0.5 flex h-8 w-8 shrink-0 items-center justify-center',
            'rounded-md border border-border bg-surface text-ink-muted',
          ].join(' ')}
        >
          <FolderTree size={16} strokeWidth={1.7} />
        </span>

        <span className="min-w-0 flex-1">
          <span
            id={`overview-branch-${node.key}`}
            title={node.title}
            className="block truncate text-[15px] font-semibold text-ink-strong"
          >
            {node.title}
          </span>
          <span className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span className="truncate font-mono text-[10.5px] text-ink-faint">
              {node.path !== undefined
                ? <PathLabel path={node.path} />
                : 'Grouping node'}
            </span>
            <DokRefs node={node} />
          </span>
        </span>

        <span className="flex shrink-0 flex-col items-end gap-1.5">
          <NodeStatus node={node} />
          <span className="text-[10px] tabular-nums text-ink-faint">
            {descendantCount === 0
              ? 'No child pages'
              : `${descendantCount} ${
                  descendantCount === 1 ? 'descendant' : 'descendants'
                }`}
          </span>
        </span>
      </button>

      {listings.length > 0 ? (
        <ol
          aria-label={`${node.title} descendants`}
          className="border-t border-border bg-surface"
        >
          {listings.map((listing) => (
            <ListingRow
              key={listing.node.key}
              listing={listing}
              selected={listing.node.key === selectedKey}
              onSelect={onSelect}
            />
          ))}
        </ol>
      ) : null}

      <DepthCutoffNote
        hiddenMatchCount={hiddenMatchCount}
        hasListings={listings.length > 0}
      />
    </section>
  );
}

function ListingRow({
  listing,
  selected,
  onSelect,
}: {
  listing: SitemapListing;
  selected: boolean;
  onSelect: (key: string) => void;
}) {
  const { node, relativeDepth } = listing;
  const absoluteDepth = relativeDepth + 1;
  const connectorStep = 22;
  const connectorStart = 18;
  const connectorLeft =
    connectorStart + (relativeDepth - 1) * connectorStep;
  const contentPadding = connectorLeft + 22;

  return (
    <li
      data-overview-depth={absoluteDepth}
      className="relative border-b border-border/70 last:border-b-0"
    >
      {Array.from({ length: relativeDepth }, (_, index) => (
        <span
          key={index}
          aria-hidden
          className="pointer-events-none absolute bottom-0 top-0 w-px bg-border"
          style={{ left: `${connectorStart + index * connectorStep}px` }}
        />
      ))}
      <span
        aria-hidden
        className="pointer-events-none absolute top-[25px] h-px w-[14px] bg-border-strong"
        style={{ left: `${connectorLeft}px` }}
      />

      <button
        type="button"
        onClick={() => onSelect(node.key)}
        aria-label={`Select ${node.title}, ${nodePath(node)}`}
        className={[
          'group flex min-h-[50px] w-full items-center gap-2.5',
          'py-2.5 pr-3 text-left transition-colors',
          'hover:bg-surface-2 active:bg-surface-3',
          'focus-visible:outline-none focus-visible:ring-2',
          'focus-visible:ring-inset focus-visible:ring-accent',
          selected ? 'bg-accent-soft' : 'bg-transparent',
        ].join(' ')}
        style={{ paddingLeft: `${contentPadding}px` }}
      >
        <span
          aria-hidden
          className={[
            'relative z-[1] flex h-5 w-5 shrink-0 items-center justify-center',
            'rounded border border-border bg-canvas text-ink-faint',
          ].join(' ')}
        >
          {node.children.length > 0 ? (
            <FolderTree size={11} strokeWidth={1.8} />
          ) : (
            <FileText size={11} strokeWidth={1.8} />
          )}
        </span>

        <span className="min-w-0 flex-1">
          <span
            title={node.title}
            className="block truncate text-[12.5px] font-medium text-ink"
          >
            {node.title}
          </span>
          <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
            <span className="truncate font-mono text-[10px] text-ink-faint">
              {node.path !== undefined
                ? <PathLabel path={node.path} />
                : 'Grouping node'}
            </span>
            <DokRefs node={node} />
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-2">
          <PlatformException node={node} />
          <NodeStatus node={node} />
        </span>
      </button>
    </li>
  );
}

function PathLabel({ path }: { path: string }) {
  return path === ''
    ? <span aria-label="Empty path">{'""'}</span>
    : <>{path}</>;
}

export function IaOverview() {
  const tree = useSelectedIaTree();
  const {
    iaDepth,
    routeFilter,
    selectedIaNodeKey,
    setSelectedIaNodeKey,
  } = useStudio();
  const cards = useMemo(
    () => tree ? buildSitemapCards(tree, iaDepth, routeFilter) : [],
    [tree, iaDepth, routeFilter],
  );
  const hiddenMatches = useMemo(
    () => tree
      ? iaMatchesBelowDepth(tree, iaDepth, routeFilter)
      : new Map<string, number>(),
    [tree, iaDepth, routeFilter],
  );

  if (cards.length === 0) {
    return (
      <div className="flex min-h-[420px] flex-1 items-center justify-center px-8 text-center text-sm text-ink-muted">
        No nodes match this filter.
      </div>
    );
  }

  return (
    <div
      data-testid="ia-overview-directory"
      className="min-h-0 flex-1 overflow-y-auto bg-surface-2/50 px-8 py-6"
    >
      <div className="mx-auto max-w-[1120px]">
        <div className="mb-4 flex items-baseline justify-between gap-4">
          <h2 className="text-[13px] font-semibold text-ink-strong">
            Top-level sections
          </h2>
          <p className="text-[11px] text-ink-faint">
            {cards.length} {cards.length === 1 ? 'branch' : 'branches'} in view
          </p>
        </div>

        <div className="grid grid-cols-1 items-start gap-5 2xl:grid-cols-2">
          {cards.map((card) => (
            <RootSection
              key={card.node.key}
              node={card.node}
              listings={card.listings}
              hiddenMatchCount={hiddenMatches.get(card.node.key) ?? 0}
              selectedKey={selectedIaNodeKey}
              onSelect={setSelectedIaNodeKey}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
