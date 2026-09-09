'use client';

import type { ReactElement, ReactNode } from 'react';
import type { DokCatalogData, LoadState } from '../lib/load-state';
import type { LexiconFile, RolesFile } from '@doklo-beta/core';
import { useStudio } from './studio-store';

type RecoveryLayer =
  | 'workspace'
  | 'doks'
  | 'lexicon'
  | 'roles'
  | 'ia'
  | 'consolidation';

export function LoadRecovery<T>({
  layer,
  state,
}: {
  layer: RecoveryLayer;
  state: Extract<LoadState<T>, { kind: 'invalid' | 'unreadable' }>;
}): ReactElement {
  return (
    <section
      role="alert"
      aria-live="assertive"
      className="m-auto max-w-2xl rounded-md border border-status-deprecated-fg bg-status-deprecated-bg px-6 py-5 text-ink"
    >
      <h1 className="text-lg font-semibold text-ink-strong">
        {layer} could not be loaded
      </h1>
      <p className="mt-3 text-sm text-status-deprecated-fg">{state.message}</p>
      <code className="mt-3 block overflow-x-auto rounded bg-canvas px-3 py-2 text-xs text-ink-secondary">
        {state.path}
      </code>
      <p className="mt-4 text-sm">No files were changed.</p>
      <p className="mt-1 text-sm">Fix the file, then reload Studio.</p>
    </section>
  );
}

export function CanonicalLayerBoundary({
  layer,
  children,
}: {
  layer: 'doks' | 'lexicon' | 'roles';
  children: ReactNode;
}): ReactElement {
  const studio = useStudio();
  const state: LoadState<DokCatalogData | LexiconFile | RolesFile> =
    layer === 'doks'
      ? studio.doksState
      : layer === 'lexicon'
        ? studio.lexiconState
        : studio.rolesState;

  if (state.kind === 'invalid' || state.kind === 'unreadable') {
    return <LoadRecovery layer={layer} state={state} />;
  }
  return <>{children}</>;
}
