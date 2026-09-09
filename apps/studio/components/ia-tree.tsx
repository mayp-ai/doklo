'use client';

import {
  useCallback,
  useMemo,
  useRef,
  type MouseEvent,
  type PointerEvent,
} from 'react';
import {
  IA_DEPTH_MAX,
  useSelectedIaTree,
  useStudio,
  type Platform,
  type StudioIaNode,
} from './studio-store';
import { iaNodeDokRefs, splitSegment } from '../lib/ia-route';
import { iaSubtreeMatches } from '../lib/ia-presentation';
import { useTreeKeyboardNav } from '../lib/hooks/use-tree-keyboard-nav';

const PLATFORM_BADGE: Record<Platform, { className: string; label: string }> = {
  both: {
    className: 'bg-status-active-bg text-status-active-fg',
    label: 'Desktop + mobile',
  },
  'desktop-only': {
    className: 'bg-status-review-bg text-status-review-fg',
    label: 'Desktop only',
  },
  'mobile-only': {
    className: 'bg-status-deprecated-bg text-status-deprecated-fg',
    label: 'Mobile only',
  },
};
const EMPTY_NODES: readonly StudioIaNode[] = [];

export function IaTree() {
  const tree = useSelectedIaTree();
  const {
    selectedIaNodeKey,
    setSelectedIaNodeKey,
    expandedIaNodeKeys,
    toggleIaNodeExpanded,
    iaDepth,
    routeFilter,
  } = useStudio();
  const roots = tree?.nodes ?? EMPTY_NODES;
  const keyboardRoots = useMemo(
    () => projectKeyboardRoots(roots, iaDepth, routeFilter),
    [roots, iaDepth, routeFilter],
  );
  const treeRef = useRef<HTMLDivElement>(null);
  const selectFromTree = useCallback(
    (key: string) => {
      setSelectedIaNodeKey(key);
      const treeElement = treeRef.current;
      if (
        treeElement &&
        treeElement.ownerDocument.activeElement instanceof Node &&
        treeElement.contains(treeElement.ownerDocument.activeElement)
      ) {
        treeElement.focus({ preventScroll: true });
      }
    },
    [setSelectedIaNodeKey],
  );
  const toggleFromTree = useCallback(
    (key: string) => {
      const treeElement = treeRef.current;
      const selectedElement =
        selectedIaNodeKey !== null && treeElement
          ? treeElement.ownerDocument.getElementById(
              treeItemId(selectedIaNodeKey),
            )
          : null;
      const selectionWillHide =
        expandedIaNodeKeys.has(key) &&
        selectedIaNodeKey !== null &&
        selectedIaNodeKey !== key &&
        selectedElement !== null &&
        (treeElement?.contains(selectedElement) ?? false) &&
        isDescendantOf(roots, key, selectedIaNodeKey);
      const shouldKeepFocus =
        treeElement?.contains(treeElement.ownerDocument.activeElement) ?? false;
      toggleIaNodeExpanded(key);
      if (selectionWillHide) {
        setSelectedIaNodeKey(key);
      }
      if (shouldKeepFocus) treeElement?.focus({ preventScroll: true });
    },
    [
      expandedIaNodeKeys,
      roots,
      selectedIaNodeKey,
      setSelectedIaNodeKey,
      toggleIaNodeExpanded,
    ],
  );
  const treeNav = useTreeKeyboardNav({
    roots: keyboardRoots,
    ancestryRoots: roots,
    expandedKeys: expandedIaNodeKeys,
    selectedKey: selectedIaNodeKey,
    onSelect: selectFromTree,
    onToggle: toggleFromTree,
  });
  const activeKey = treeNav.activeKey;
  const focusTreeFromPointer = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (
        !(event.target instanceof Element) ||
        !event.target.closest('[role="treeitem"]')
      ) {
        return;
      }
      event.preventDefault();
      event.currentTarget.focus({ preventScroll: true });
    },
    [],
  );

  if (!tree) return null;

  return (
    <div
      role="tree"
      ref={treeRef}
      aria-label={`${tree.serviceId} ${tree.type} hierarchy`}
      aria-activedescendant={
        activeKey !== null ? treeItemId(activeKey) : undefined
      }
      tabIndex={0}
      onKeyDown={treeNav.onKeyDown}
      onPointerDownCapture={focusTreeFromPointer}
      className={[
        'group/tree px-6 py-4 text-[13px] leading-relaxed outline-none',
        activeKey === null
          ? 'focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent'
          : '',
      ].join(' ')}
    >
      {keyboardRoots.length === 0 ? (
        <p className="py-16 text-center text-sm text-ink-muted">
          No nodes match this filter.
        </p>
      ) : (
        keyboardRoots.map((node) => (
          <IaTreeNode
            key={node.key}
            node={node}
            depth={1}
            activeKey={activeKey}
            onSelect={selectFromTree}
            onToggle={toggleFromTree}
          />
        ))
      )}
    </div>
  );
}

function isDescendantOf(
  roots: readonly StudioIaNode[],
  ancestorKey: string,
  descendantKey: string,
): boolean {
  const findAncestor = (
    nodes: readonly StudioIaNode[],
  ): StudioIaNode | null => {
    for (const node of nodes) {
      if (node.key === ancestorKey) return node;
      const ancestor = findAncestor(node.children);
      if (ancestor) return ancestor;
    }
    return null;
  };
  const contains = (nodes: readonly StudioIaNode[]): boolean =>
    nodes.some(
      (node) =>
        node.key === descendantKey ||
        contains(node.children),
    );
  const ancestor = findAncestor(roots);
  return ancestor ? contains(ancestor.children) : false;
}

function projectKeyboardRoots(
  roots: readonly StudioIaNode[],
  maxDepth: number,
  filter: Parameters<typeof iaSubtreeMatches>[1],
): StudioIaNode[] {
  const project = (
    nodes: readonly StudioIaNode[],
    depth: number,
  ): StudioIaNode[] =>
    nodes
      .filter((node) => iaSubtreeMatches(node, filter))
      .map((node) => ({
        ...node,
        children:
          maxDepth >= IA_DEPTH_MAX || depth < maxDepth
            ? project(node.children, depth + 1)
            : [],
      }));

  return project(roots, 1);
}

function IaTreeNode({
  node,
  depth,
  activeKey,
  onSelect,
  onToggle: onToggleNode,
}: {
  node: StudioIaNode;
  depth: number;
  activeKey: string | null;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  const {
    selectedIaNodeKey,
    expandedIaNodeKeys,
  } = useStudio();

  const hasChildren = node.children.length > 0;
  const expanded = expandedIaNodeKeys.has(node.key);
  const selected = selectedIaNodeKey === node.key;
  const childCount = node.children.length;
  // v1 exposes one dok_ref, a v2 destination exposes its bindings.
  const dokRefs = iaNodeDokRefs(node);
  const platform = PLATFORM_BADGE[node.platform];
  const selectNode = () => onSelect(node.key);
  const onToggle = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    onToggleNode(node.key);
  };

  return (
    <div role="none">
      <div
        id={treeItemId(node.key)}
        role="treeitem"
        tabIndex={-1}
        aria-selected={selected}
        aria-expanded={hasChildren ? expanded : undefined}
        aria-level={depth}
        onClick={selectNode}
        className={[
          'mb-px grid cursor-pointer grid-cols-[18px_18px_minmax(0,1fr)_auto_auto] items-center gap-2 rounded-md border px-2.5 py-1.5 transition-colors active:bg-surface-2',
          activeKey === node.key
            ? 'group-focus-visible/tree:ring-2 group-focus-visible/tree:ring-accent group-focus-visible/tree:ring-offset-2 group-focus-visible/tree:ring-offset-canvas'
            : '',
          selected
            ? 'border-accent-soft-strong bg-accent-soft'
            : 'border-transparent text-ink-secondary hover:border-border hover:bg-surface',
        ].join(' ')}
      >
        {hasChildren ? (
          <button
            type="button"
            tabIndex={-1}
            onClick={onToggle}
            aria-label={`${expanded ? 'Collapse' : 'Expand'} ${node.title}`}
            className="rounded-sm text-center text-[10px] leading-none text-ink-muted hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {expanded ? '▼' : '▶'}
          </button>
        ) : (
          <span aria-hidden />
        )}

        <span
          aria-hidden
          className={hasChildren ? 'text-accent' : 'text-ink-faint'}
        >
          {hasChildren ? '▣' : '□'}
        </span>

        <span className="min-w-0">
          <span
            title={node.title}
            className={[
              'block truncate text-[12.5px]',
              hasChildren
                ? 'font-semibold text-ink-strong'
                : 'font-medium text-ink',
            ].join(' ')}
          >
            {node.title}
          </span>
          <span className="block truncate font-mono text-[10.5px] text-ink-muted">
            {node.path !== undefined
              ? <PathText path={node.path} />
              : 'Grouping node'}
          </span>
        </span>

        <span
          className={[
            'rounded-full px-2 py-0.5 text-[10px] font-medium',
            platform.className,
          ].join(' ')}
        >
          {platform.label}
        </span>

        {dokRefs.length > 0 ? (
          dokRefs.map((dokRef) => (
            <span
              key={dokRef}
              className={[
                'rounded-full border px-2 py-0.5 font-mono text-[10.5px] font-medium',
                selected
                  ? 'border-accent bg-accent text-canvas'
                  : 'border-accent-soft-strong bg-accent-soft text-accent-ink',
              ].join(' ')}
            >
              {dokRef}
            </span>
          ))
        ) : node.unmapped ? (
          <span className="rounded-full bg-status-draft-bg px-2 py-0.5 text-[10.5px] font-medium text-status-draft-fg">
            Unmapped
          </span>
        ) : (
          <span className="rounded-full border border-border bg-surface-2 px-2 py-0.5 text-[10.5px] text-ink-muted">
            {hasChildren
              ? `${childCount} ${childCount === 1 ? 'node' : 'nodes'}`
              : 'Grouping'}
          </span>
        )}
      </div>

      {hasChildren && expanded ? (
        <div
          role="group"
          className="ml-4 border-l border-border pl-3.5"
        >
          {node.children.map((child) => (
            <IaTreeNode
              key={child.key}
              node={child}
              depth={depth + 1}
              activeKey={activeKey}
              onSelect={onSelect}
              onToggle={onToggleNode}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

function treeItemId(key: string): string {
  return `ia-treeitem-${encodeURIComponent(key)}`;
}

function PathText({ path }: { path: string }) {
  if (path === '') return <span aria-label="Empty path">{'""'}</span>;
  if (path === '/') return <>/</>;
  const segments = path.split('/').filter(Boolean);

  return (
    <>
      {segments.map((segment, index) => (
        <span key={`${segment}:${index}`}>
          <span>/</span>
          <SegmentText segment={segment} />
        </span>
      ))}
    </>
  );
}

function SegmentText({ segment }: { segment: string }) {
  return (
    <>
      {splitSegment(segment).map((part, index) =>
        part.dynamic ? (
          <span key={index}>
            <span>[</span>
            <span className="font-semibold text-status-draft-fg">
              {part.text}
            </span>
            <span>]</span>
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
