'use client';

import { useCallback, useMemo, type KeyboardEvent } from 'react';
import type { StudioIaNode } from '../ia-route';

interface VisibleRow {
  node: StudioIaNode;
  parent: StudioIaNode | null;
  depth: number;
}

/** Walk every root in display order, honoring expanded keys. Children
 *  of collapsed folders are skipped so ↑↓ only visit rows the user
 *  can actually see. */
function flatten(
  roots: readonly StudioIaNode[],
  expanded: Set<string>,
): VisibleRow[] {
  const out: VisibleRow[] = [];
  function visit(
    node: StudioIaNode,
    parent: StudioIaNode | null,
    depth: number,
  ) {
    out.push({ node, parent, depth });
    if (expanded.has(node.key)) {
      for (const c of node.children) visit(c, node, depth + 1);
    }
  }
  for (const root of roots) visit(root, null, 1);
  return out;
}

function findPath(
  roots: readonly StudioIaNode[],
  key: string,
): StudioIaNode[] | null {
  for (const node of roots) {
    if (node.key === key) return [node];
    const childPath = findPath(node.children, key);
    if (childPath) return [node, ...childPath];
  }
  return null;
}

/**
 * useTreeKeyboardNav — ↑/↓/←/→/Enter for the IA tree.
 *
 *   ↓ : next visible row (descend into expanded children)
 *   ↑ : previous visible row
 *   → : if folder has children & collapsed → expand
 *       if expanded → move to first child
 *   ← : if folder has children & expanded → collapse
 *       else → move to parent
 *   Enter / Space : select current row (mostly redundant with click)
 */
export function useTreeKeyboardNav({
  roots,
  ancestryRoots,
  expandedKeys,
  selectedKey,
  onSelect,
  onToggle,
}: {
  roots: readonly StudioIaNode[];
  ancestryRoots: readonly StudioIaNode[];
  expandedKeys: Set<string>;
  selectedKey: string | null;
  onSelect: (key: string) => void;
  onToggle: (key: string) => void;
}) {
  const visible = useMemo(
    () => flatten(roots, expandedKeys),
    [roots, expandedKeys],
  );
  const activeKey = useMemo(() => {
    if (
      selectedKey !== null &&
      visible.some((row) => row.node.key === selectedKey)
    ) {
      return selectedKey;
    }
    if (selectedKey !== null) {
      const path = findPath(ancestryRoots, selectedKey);
      if (path) {
        for (let index = path.length - 1; index >= 0; index -= 1) {
          const candidate = path[index]!;
          if (visible.some((row) => row.node.key === candidate.key)) {
            return candidate.key;
          }
        }
      }
      return null;
    }
    return visible[0]?.node.key ?? null;
  }, [ancestryRoots, selectedKey, visible]);

  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (
        e.target instanceof Element &&
        e.target.closest('button, input, select, textarea, a[href]')
      ) {
        return;
      }
      if (visible.length === 0) return;
      const idx = visible.findIndex((r) => r.node.key === activeKey);
      const current = idx >= 0 ? visible[idx] : undefined;
      const hasChildren = (current?.node.children.length ?? 0) > 0;
      const isExpanded =
        current !== undefined && expandedKeys.has(current.node.key);

      switch (e.key) {
        case 'ArrowDown': {
          const next = Math.min((idx < 0 ? 0 : idx + 1), visible.length - 1);
          if (next !== idx) {
            e.preventDefault();
            onSelect(visible[next].node.key);
          }
          return;
        }
        case 'ArrowUp': {
          const next = Math.max((idx < 0 ? 0 : idx - 1), 0);
          if (next !== idx) {
            e.preventDefault();
            onSelect(visible[next].node.key);
          }
          return;
        }
        case 'ArrowRight': {
          if (!current || !hasChildren) return;
          e.preventDefault();
          if (!isExpanded) {
            onToggle(current.node.key);
          } else {
            onSelect(current.node.children[0]!.key);
          }
          return;
        }
        case 'ArrowLeft': {
          if (!current) return;
          e.preventDefault();
          if (hasChildren && isExpanded) {
            onToggle(current.node.key);
          } else if (current.parent) {
            onSelect(current.parent.key);
          }
          return;
        }
        case 'Enter':
        case ' ': {
          if (!current) return;
          e.preventDefault();
          onSelect(current.node.key);
          return;
        }
      }
    },
    [visible, expandedKeys, activeKey, onSelect, onToggle],
  );

  return { activeKey, onKeyDown };
}
