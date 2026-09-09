'use client';

import { useEffect, useMemo, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStudio, resolveRoleName } from './studio-store';
import { useCrossLayerJump } from '../lib/hooks/use-cross-layer-jump';
import type {
  IaJumpTarget,
  StudioIaNode,
  StudioIaTree,
} from '../lib/ia-route';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/** Categories the palette surfaces. Each maps to one (hub) layer. */
const KIND_LABEL = {
  dok: 'Doks',
  term: 'Lexicon',
  route: 'IA structures',
  role: 'Roles',
} as const;
type ResultKind = keyof typeof KIND_LABEL;

interface SearchResult {
  kind: ResultKind;
  id: string;
  label: string;
  /** Optional second line (e.g. dok status, term primary text). */
  meta?: string;
  iaTarget?: IaJumpTarget;
}

/**
 * CommandPalette — Phase 8 cross-layer search. Replaces the older
 * dialog-element palette with a portal + token-utility-styled modal.
 *
 * Reads state from useStudio() (paletteOpen / paletteQuery /
 * paletteCrossLayer). Cross-layer mode searches all four layers;
 * default mode prioritises whichever layer the user is currently on
 * but still falls back to other layers when matches are thin.
 */
export function CommandPalette() {
  const {
    paletteOpen,
    paletteCrossLayer,
    paletteQuery,
    setPaletteQuery,
    closePalette,
    doks,
    lexicon,
    iaTrees,
    roles,
    projectLocales,
    recentJumps,
  } = useStudio();
  const jump = useCrossLayerJump();

  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusRef = useRef<HTMLElement | null>(null);

  // Flatten every layer into result rows once per fixture/query change.
  const results: SearchResult[] = useMemo(() => {
    if (!paletteOpen) return [];
    const q = paletteQuery.trim().toLowerCase();

    const dokRows: SearchResult[] = doks.map((d) => ({
      kind: 'dok',
      id: d.dok_id,
      label: typeof d.name === 'string' ? d.name : `{${d.name.term_ref}}`,
      meta: d.status,
    }));

    const termRows: SearchResult[] = lexicon.map((t) => ({
      kind: 'term',
      // owned terms carry `locales`, constant terms a `snapshot`; i18n
      // terms carry neither (text lives in workspace i18n files Studio
      // can't read), so they fall back to the term_id — never a crash.
      id: t.term_id,
      label: t.locales?.ko ?? t.snapshot?.ko ?? t.term_id,
      meta: t.category,
    }));

    const routeRows: SearchResult[] = [];
    const walk = (tree: StudioIaTree, node: StudioIaNode): void => {
      routeRows.push({
        kind: 'route',
        id: node.key,
        label: node.title,
        meta:
          node.path !== undefined
            ? node.path
            : `${tree.serviceId} · ${tree.treeId}`,
        iaTarget: {
          serviceId: tree.serviceId,
          treeId: tree.treeId,
          nodeKey: node.key,
          ...(node.path !== undefined ? { path: node.path } : {}),
        },
      });
      node.children.forEach((child) => walk(tree, child));
    };
    iaTrees.forEach((tree) => {
      tree.nodes.forEach((node) => walk(tree, node));
    });

    // One row per workspace role (roles.json). Names resolve through the
    // Lexicon for TermRef-bound roles, falling back to the role_id.
    const roleRows: SearchResult[] = roles.map((role) => ({
      kind: 'role',
      id: role.role_id,
      label: resolveRoleName(role, lexicon, projectLocales),
      meta: role.scope,
    }));

    const all = [...dokRows, ...termRows, ...routeRows, ...roleRows];
    if (!q) return all;
    return all.filter(
      (r) =>
        r.id.toLowerCase().includes(q) ||
        r.label.toLowerCase().includes(q) ||
        (r.meta?.toLowerCase().includes(q) ?? false),
    );
  }, [
    paletteOpen,
    paletteQuery,
    doks,
    lexicon,
    iaTrees,
    roles,
    projectLocales,
  ]);

  // Group preserving cross-layer order; default mode hides all but the
  // empty-label kinds when query is blank (otherwise the list is huge).
  const grouped = useMemo(() => {
    const buckets: Record<ResultKind, SearchResult[]> = {
      dok: [], term: [], route: [], role: [],
    };
    for (const r of results) buckets[r.kind].push(r);
    const order: ResultKind[] = ['dok', 'term', 'route', 'role'];
    return order
      .map((k) => [k, buckets[k]] as [ResultKind, SearchResult[]])
      .filter(([, items]) => items.length > 0);
  }, [results]);

  // Flat index for keyboard nav.
  const flat = useMemo(() => grouped.flatMap(([, items]) => items), [grouped]);

  // Selected row index. Resets to 0 on every query/open change.
  const selectedRef = useRef(0);
  useEffect(() => {
    selectedRef.current = 0;
  }, [paletteQuery, paletteOpen]);

  // Own focus for the full dialog lifetime: remember the opener before
  // moving focus, trap Tab within the panel, and restore the opener (or the
  // stable header trigger) after every close path.
  useEffect(() => {
    if (!paletteOpen) return;
    const input = inputRef.current;
    const panel = panelRef.current;
    if (!input || !panel) return;
    const ownerDocument = panel.ownerDocument;
    returnFocusRef.current = ownerDocument.activeElement instanceof HTMLElement
      ? ownerDocument.activeElement
      : null;

    const focusables = () =>
      [...panel.querySelectorAll<HTMLElement>('*')].filter(
        (element) => element.matches(FOCUSABLE_SELECTOR) && element.tabIndex >= 0,
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        closePalette();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        panel.focus({ preventScroll: true });
        return;
      }
      const active = ownerDocument.activeElement;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const wrapBackward = event.shiftKey && index <= 0;
      const wrapForward = !event.shiftKey && (index === -1 || index === items.length - 1);
      if (!wrapBackward && !wrapForward) return;
      event.preventDefault();
      const target = event.shiftKey ? items.at(-1) : items[0];
      target?.focus({ preventScroll: true });
    };

    ownerDocument.addEventListener('keydown', onKeyDown, true);
    input.focus({ preventScroll: true });

    return () => {
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
      const fallback = ownerDocument.querySelector<HTMLElement>(
        '[data-command-palette-trigger]',
      );
      const target = [returnFocusRef.current, fallback].find(
        (candidate): candidate is HTMLElement =>
          candidate !== null && candidate.isConnected && !candidate.matches(':disabled'),
      );
      target?.focus({ preventScroll: true });
      returnFocusRef.current = null;
    };
  }, [closePalette, paletteOpen]);

  // Keyboard nav within the palette.
  useEffect(() => {
    if (!paletteOpen) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        selectedRef.current = Math.min(selectedRef.current + 1, flat.length - 1);
        applySelectedClass();
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        selectedRef.current = Math.max(selectedRef.current - 1, 0);
        applySelectedClass();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const r = flat[selectedRef.current];
        if (r) commit(r);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paletteOpen, flat]);

  // Apply the [data-active] attribute imperatively so re-rendering on
  // every arrow key doesn't churn the (large) result list.
  function applySelectedClass() {
    const panel = panelRef.current;
    if (!panel) return;
    panel.querySelectorAll('[data-palette-row]').forEach((el, i) => {
      if (i === selectedRef.current) {
        el.setAttribute('data-active', 'true');
        el.scrollIntoView({ block: 'nearest' });
      } else {
        el.removeAttribute('data-active');
      }
    });
  }
  // Re-apply when the result list changes (e.g. typing narrows).
  useEffect(() => {
    applySelectedClass();
  });

  function commit(r: SearchResult) {
    closePalette();
    switch (r.kind) {
      case 'dok':   jump.jumpToDok(r.id, r.label); break;
      case 'term':  jump.jumpToTerm(r.id, r.label); break;
      case 'route':
        if (!r.iaTarget) {
          throw new Error(`IA search result ${r.id} is missing its target`);
        }
        jump.jumpToIaNode(r.iaTarget, r.label);
        break;
      case 'role':  jump.jumpToRole(r.id, r.label); break;
    }
  }

  // Don't try to portal during SSR — react-dom's createPortal throws
  // without document. Returning null until paletteOpen is fine because
  // KeyboardShortcuts owns the global ⌘K trigger anyway.
  if (typeof document === 'undefined' || !paletteOpen) return null;

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Command palette"
      className="fixed inset-0 z-50"
      style={{ backgroundColor: 'oklch(0.992 0.003 275 / 0.78)' }}
      onClick={closePalette}
    >
      <div
        ref={panelRef}
        onClick={(e) => e.stopPropagation()}
        className="fixed left-1/2 top-[18vh] w-[640px] max-w-[90vw] -translate-x-1/2 overflow-hidden rounded-lg border border-border bg-surface shadow-md"
      >
        <div className="flex items-center gap-3 border-b border-border px-5 py-4">
          <span aria-hidden className="text-base text-ink-muted">⌕</span>
          <input
            ref={inputRef}
            type="search"
            value={paletteQuery}
            onChange={(e) => setPaletteQuery(e.target.value)}
            aria-label="Search"
            placeholder={
              paletteCrossLayer
                ? 'Search across all 4 layers: Dok · Term · IA · Role'
                : 'Search Dok · Term · IA · Role…'
            }
            spellCheck={false}
            className="flex-1 bg-transparent text-base text-ink-strong placeholder:text-ink-faint focus:outline-none"
          />
          {paletteCrossLayer && (
            <span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10.5px] tracking-wide text-accent-ink">
              cross-layer
            </span>
          )}
          <span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
            Esc
          </span>
        </div>

        <ul
          role="listbox"
          aria-label="Search results"
          className="m-0 max-h-[60vh] list-none overflow-y-auto p-0"
        >
          {grouped.length === 0 ? (
            <li className="px-5 py-10 text-center text-sm text-ink-muted">
              {paletteQuery
                ? 'No results.'
                : 'Type to search across all 4 layers.'}
              {!paletteQuery && recentJumps.length > 0 && (
                <RecentList recent={recentJumps} onCommit={(r) => commit(toResult(r))} />
              )}
            </li>
          ) : (
            grouped.map(([kind, items]) => (
              <li key={kind} className="m-0 p-0">
                <div className="border-b border-border bg-surface-2 px-5 py-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
                  {KIND_LABEL[kind]}{' '}
                  <span className="text-ink-faint">· {items.length}</span>
                </div>
                <ul className="m-0 list-none p-0">
                  {items.map((r) => (
                    <li key={`${r.kind}:${r.id}`} className="m-0 p-0">
                      <button
                        type="button"
                        role="option"
                        aria-selected={false}
                        data-palette-row
                        onClick={() => commit(r)}
                        onMouseEnter={(e) => {
                          // Move selection to the hovered row so Enter
                          // commits what the cursor is over.
                          const all = Array.from(
                            panelRef.current?.querySelectorAll('[data-palette-row]') ?? [],
                          );
                          selectedRef.current = all.indexOf(e.currentTarget);
                          applySelectedClass();
                        }}
                        className={[
                          'flex w-full items-center gap-3 border-b border-border px-5 py-2.5 text-left text-[13px] transition-colors',
                          'last:border-b-0',
                          'data-[active=true]:bg-accent-soft data-[active=true]:text-accent-ink',
                          'hover:bg-surface-2',
                          'focus-visible:outline-none focus-visible:bg-accent-soft',
                        ].join(' ')}
                      >
                        <span
                          title={r.id}
                          className="max-w-[220px] shrink-0 truncate rounded-full border border-accent-soft-strong bg-accent-soft px-2 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink"
                        >
                          {r.id}
                        </span>
                        <span className="flex-1 truncate font-medium text-ink-strong">
                          {r.label}
                        </span>
                        {r.meta !== undefined && (
                          <span className="font-mono text-[10.5px] text-ink-muted">
                            {r.meta === ''
                              ? <span aria-label="Empty path">{'""'}</span>
                              : r.meta}
                          </span>
                        )}
                      </button>
                    </li>
                  ))}
                </ul>
              </li>
            ))
          )}
        </ul>

        <div className="flex items-center justify-end gap-3.5 border-t border-border bg-surface-2 px-5 py-2 font-mono text-[10.5px] text-ink-muted">
          <span>
            <Kbd>↑</Kbd> <Kbd>↓</Kbd> Navigate
          </span>
          <span>
            <Kbd>↵</Kbd> Select
          </span>
          <span>
            <Kbd>Esc</Kbd> Close
          </span>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <span className="rounded-sm border border-border bg-canvas px-1.5 py-0.5 text-[10.5px] text-ink-secondary">
      {children}
    </span>
  );
}

// ── Recent jumps surface (empty state) ──────────────────────────────

function RecentList({
  recent,
  onCommit,
}: {
  recent: import('./studio-store').RecentJump[];
  onCommit: (r: import('./studio-store').RecentJump) => void;
}) {
  return (
    <div className="mt-6 text-left">
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Recent
      </div>
      <ul className="m-0 list-none p-0">
        {recent.slice(0, 5).map((j) => (
          <li key={`${j.kind}:${j.id}`} className="m-0 p-0">
            <button
              type="button"
              onClick={() => onCommit(j)}
              className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left text-[13px] hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
            >
              <span
                title={j.id}
                className="max-w-[220px] shrink-0 truncate rounded-full border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink"
              >
                {j.id}
              </span>
              <span className="flex-1 truncate text-ink-secondary">
                {j.label ?? j.id}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}

function toResult(j: import('./studio-store').RecentJump): SearchResult {
  return {
    kind: j.kind,
    id: j.id,
    label: j.label ?? j.id,
    ...(j.iaTarget ? { iaTarget: j.iaTarget } : {}),
  };
}
