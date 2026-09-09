'use client';

import { useCallback, useRef } from 'react';
import { useStudio } from '../../components/studio-store';
import type { IaJumpTarget, StudioIaTree } from '../ia-route';
import { findIaNode, resolveIaDeepLink } from '../ia-presentation';
import { useSafeNavigation } from './use-safe-navigation';

function resolveCurrentIaTarget(
  trees: readonly StudioIaTree[],
  target: IaJumpTarget,
): {
  treeKey: string;
  nodeKey: string;
  target: IaJumpTarget;
} | null {
  const resolved = resolveIaDeepLink(trees, {
    serviceId: target.serviceId,
    treeId: target.treeId,
    nodeKey: target.nodeKey,
    ...(target.path !== undefined ? { path: target.path } : {}),
  });
  if (!resolved?.nodeKey) return null;
  const tree = trees.find((candidate) => candidate.key === resolved.treeKey);
  const node = tree
    ? findIaNode(tree.nodes, resolved.nodeKey)
    : null;
  if (!tree || !node) return null;
  return {
    treeKey: resolved.treeKey,
    nodeKey: resolved.nodeKey,
    target: {
      serviceId: tree.serviceId,
      treeId: tree.treeId,
      nodeKey: node.key,
      ...(node.path !== undefined ? { path: node.path } : {}),
    },
  };
}

/**
 * useCrossLayerJump — the one place that knows how an id maps to a
 * Hub layer. Used by id-pill clicks in every preview, by the command
 * palette result list, and by deep-link sync hooks.
 *
 * Each jumpTo* method:
 *   1. safely flushes pending edits, then pushes the layer route
 *   2. sets the matching store selection so the preview is already
 *      correct when the page hydrates
 *   3. records the jump in recentJumps for the palette empty state
 *
 * jumpByRawId is the prefix-aware fallback used when we only have a
 * pasted/typed string with no context (e.g. command palette free-text).
 */
export function useCrossLayerJump() {
  const { push, pushResolved } = useSafeNavigation();
  const {
    setSelectedDok,
    setSelectedTerm,
    iaTrees,
    setSelectedIaTreeKey,
    setSelectedIaNodeKey,
    setSelectedRoleId,
    pushRecentJump,
  } = useStudio();
  const iaTreesRef = useRef(iaTrees);
  iaTreesRef.current = iaTrees;

  const jumpToDok = useCallback(
    (id: string, label?: string) => {
      void push(`/doks?id=${encodeURIComponent(id)}`).then((navigated) => {
        if (!navigated) return;
        setSelectedDok(id);
        pushRecentJump({ kind: 'dok', id, label, at: Date.now() });
      });
    },
    [push, setSelectedDok, pushRecentJump],
  );

  const jumpToTerm = useCallback(
    (id: string, label?: string) => {
      void push(`/lexicon?id=${encodeURIComponent(id)}`).then((navigated) => {
        if (!navigated) return;
        setSelectedTerm(id);
        pushRecentJump({ kind: 'term', id, label, at: Date.now() });
      });
    },
    [push, setSelectedTerm, pushRecentJump],
  );

  const jumpToRoute = useCallback(
    (path: string, label?: string) => {
      void pushResolved(
        () => `/ia?path=${encodeURIComponent(path)}`,
      ).then((navigated) => {
        if (!navigated) return;
        const trees = iaTreesRef.current;
        const resolved = resolveIaDeepLink(trees, { path });
        const tree = resolved
          ? trees.find((candidate) => candidate.key === resolved.treeKey)
          : undefined;
        const node =
          tree && resolved?.nodeKey
            ? findIaNode(tree.nodes, resolved.nodeKey)
            : null;
        const iaTarget: IaJumpTarget | undefined =
          tree && node
            ? {
                serviceId: tree.serviceId,
                treeId: tree.treeId,
                nodeKey: node.key,
                ...(node.path !== undefined ? { path: node.path } : {}),
              }
            : undefined;
        if (resolved) {
          setSelectedIaTreeKey(resolved.treeKey);
          setSelectedIaNodeKey(resolved.nodeKey);
        }
        if (iaTarget) {
          pushRecentJump({
            kind: 'route',
            id: iaTarget.nodeKey,
            label,
            iaTarget,
            at: Date.now(),
          });
        }
      });
    },
    [
      pushResolved,
      pushRecentJump,
      setSelectedIaNodeKey,
      setSelectedIaTreeKey,
    ],
  );

  const jumpToIaNode = useCallback(
    (target: IaJumpTarget, label?: string) => {
      if (!resolveCurrentIaTarget(iaTreesRef.current, target)) return;
      const stableTarget: IaJumpTarget = {
        serviceId: target.serviceId,
        treeId: target.treeId,
        nodeKey: target.nodeKey,
      };
      void pushResolved(() => {
        const current = resolveCurrentIaTarget(
          iaTreesRef.current,
          stableTarget,
        );
        if (!current) return null;
        const query = new URLSearchParams({
          service: current.target.serviceId,
          tree: current.target.treeId,
          node: current.target.nodeKey,
        });
        if (current.target.path !== undefined) {
          query.set('path', current.target.path);
        }
        return `/ia?${query.toString()}`;
      }).then((navigated) => {
        if (!navigated) return;
        const current = resolveCurrentIaTarget(
          iaTreesRef.current,
          stableTarget,
        );
        if (!current) return;
        setSelectedIaTreeKey(current.treeKey);
        setSelectedIaNodeKey(current.nodeKey);
        pushRecentJump({
          kind: 'route',
          id: current.target.nodeKey,
          label,
          iaTarget: current.target,
          at: Date.now(),
        });
      });
    },
    [
      pushResolved,
      pushRecentJump,
      setSelectedIaNodeKey,
      setSelectedIaTreeKey,
    ],
  );

  const jumpToRole = useCallback(
    (id: string, label?: string) => {
      void push(`/roles?id=${encodeURIComponent(id)}`).then((navigated) => {
        if (!navigated) return;
        setSelectedRoleId(id);
        pushRecentJump({ kind: 'role', id, label, at: Date.now() });
      });
    },
    [push, setSelectedRoleId, pushRecentJump],
  );

  /** Best-effort prefix dispatch. ROLE- before TERM- because both are
   *  uppercase; path-style starts with "/". Everything else falls back
   *  to the Dok catalog (most ids are Dok prefixes). */
  const jumpByRawId = useCallback(
    (raw: string, label?: string): 'dok' | 'term' | 'route' | 'role' | null => {
      const r = raw.trim();
      if (!r) return null;
      if (r.startsWith('/'))      { jumpToRoute(r, label); return 'route'; }
      if (r.startsWith('ROLE-'))  { jumpToRole(r, label); return 'role'; }
      if (r.startsWith('TERM-'))  { jumpToTerm(r, label); return 'term'; }
      if (/^[A-Z]+-[0-9A-Z-]+$/.test(r)) {
        jumpToDok(r, label);
        return 'dok';
      }
      return null;
    },
    [jumpToDok, jumpToTerm, jumpToRoute, jumpToRole],
  );

  return {
    jumpToDok,
    jumpToTerm,
    jumpToRoute,
    jumpToIaNode,
    jumpToRole,
    jumpByRawId,
  };
}
