'use client';

import { useEffect } from 'react';
import { useSearchParams } from 'next/navigation';
import { useStudio } from '../../components/studio-store';
import { IA_DEPTH_ALL, resolveIaDeepLink } from '../ia-presentation';

/**
 * useDeepLinkSync — read selection from URL query params on mount and
 * sync the studio store. Each (hub) page calls this with the layer it
 * cares about so a `/doks?id=AUTH-SIGNIN` link lands with AUTH-SIGNIN
 * already selected and the SmartSidebar populated.
 *
 * Phase 8: read-only sync. Writing the query back is already handled
 * by useCrossLayerJump (router.push with ?id=…), so we don't need a
 * reverse effect here.
 */
export function useDokDeepLink() {
  const params = useSearchParams();
  const { setSelectedDok } = useStudio();
  const id = params.get('id');
  useEffect(() => {
    if (id) setSelectedDok(id);
  }, [id, setSelectedDok]);
}

export function useTermDeepLink() {
  const params = useSearchParams();
  const { setSelectedTerm } = useStudio();
  const id = params.get('id');
  useEffect(() => {
    if (id) setSelectedTerm(id);
  }, [id, setSelectedTerm]);
}

export function useRouteDeepLink() {
  const params = useSearchParams();
  const {
    iaTrees,
    setSelectedIaTreeKey,
    setSelectedIaNodeKey,
    setIaView,
    setIaDepth,
  } = useStudio();
  const serviceId = params.get('service') ?? undefined;
  const treeId = params.get('tree') ?? undefined;
  const nodeKey = params.get('node') ?? undefined;
  const path = params.get('path') ?? undefined;
  const view = params.get('view');
  const rawDepth = params.get('depth');

  useEffect(() => {
    const resolved = resolveIaDeepLink(iaTrees, {
      serviceId,
      treeId,
      nodeKey,
      path,
    });
    if (resolved) {
      setSelectedIaTreeKey(resolved.treeKey);
      setSelectedIaNodeKey(resolved.nodeKey);
    }
  }, [
    iaTrees,
    nodeKey,
    path,
    serviceId,
    setSelectedIaNodeKey,
    setSelectedIaTreeKey,
    treeId,
  ]);

  useEffect(() => {
    // view = overview | tree. Default is whatever the store starts with.
    // `sitemap` is the pre-rename spelling of `overview`, so a URL already
    // shared or bookmarked keeps working.
    if (view === 'overview' || view === 'sitemap') setIaView('overview');
    else if (view === 'tree') setIaView(view);
    // depth = 1..6 (or `all`). The store clamps invalid values so we
    // can pass anything that parseInt accepts.
    if (rawDepth === 'all') setIaDepth(IA_DEPTH_ALL);
    else if (rawDepth) {
      const n = parseInt(rawDepth, 10);
      if (!Number.isNaN(n)) setIaDepth(n);
    }
  }, [
    rawDepth,
    setIaDepth,
    setIaView,
    view,
  ]);
}

export function useRoleDeepLink() {
  const params = useSearchParams();
  const { setSelectedRoleId } = useStudio();
  const id = params.get('id');
  useEffect(() => {
    if (id) setSelectedRoleId(id);
  }, [id, setSelectedRoleId]);
}
