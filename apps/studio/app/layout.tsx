import type { Metadata } from 'next';
import type { Workspace } from '@doklo-beta/core';
import {
  loadAllIa,
  loadDoksState,
  loadLexiconState,
  loadRolesState,
  loadWorkspaceState,
} from '../lib/data';
import { StudioProvider } from '../components/studio-store';
import {
  countIaPageNodes,
  iaFilesToTrees,
  type StudioIaDocument,
} from '../lib/ia-adapter';
import { KeyboardShortcuts } from '../components/keyboard-shortcuts';
import { CommandPalette } from '../components/command-palette';
import { SaveGuard } from '../components/save-guard';
import { LoadRecovery } from '../components/load-recovery';
import { DemoWorkspaceBanner } from '../components/demo-workspace-banner';
import { loadDemoWorkspaceState } from '../lib/demo-workspace';
import type { LoadState } from '../lib/load-state';
import './globals.css';

export const metadata: Metadata = {
  title: 'Doklo Studio',
  description: 'v5 5-Layer Hub unified editing workbench',
};

export const dynamic = 'force-dynamic';

export function RootLoadBoundary({
  workspaceState,
  iaState,
  children,
}: {
  workspaceState: LoadState<Workspace>;
  iaState?: LoadState<StudioIaDocument>;
  children: React.ReactNode;
}) {
  if (
    workspaceState.kind === 'invalid' ||
    workspaceState.kind === 'unreadable'
  ) {
    return <LoadRecovery layer="workspace" state={workspaceState} />;
  }
  if (iaState?.kind === 'invalid' || iaState?.kind === 'unreadable') {
    return <LoadRecovery layer="ia" state={iaState} />;
  }
  return children;
}

export default async function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  // RootLayout only owns the bits every nested layout shares:
  // - the HTML scaffolding
  // - StudioProvider (so any client component can call useStudio())
  // - layerCounts (the LayerRail in (hub) reads these via useStudio;
  //   keeping the source of truth here means the nested layouts don't
  //   have to duplicate the count math, even though they each fetch
  //   their own data for shell-specific UI).
  const [workspaceState, doksState, lexiconState, rolesState, demoWorkspace] =
    await Promise.all([
      loadWorkspaceState(),
      loadDoksState(),
      loadLexiconState(),
      loadRolesState(),
      // The bundled sample workspace must never read as the viewer's own
      // analysis, on any surface — and a workspace whose marker cannot be
      // read must not be asserted to be either. Decided once, here.
      loadDemoWorkspaceState(),
    ]);
  const workspace =
    workspaceState.kind === 'ready' || workspaceState.kind === 'empty'
      ? workspaceState.data
      : null;
  const dokCatalog =
    doksState.kind === 'ready' || doksState.kind === 'empty'
      ? doksState.data
      : { doks: [], revisions: {}, paths: {} };
  const lexiconFile =
    lexiconState.kind === 'ready' || lexiconState.kind === 'empty'
      ? lexiconState.data
      : { terms: [], version: 1 };
  const rolesFile =
    rolesState.kind === 'ready' || rolesState.kind === 'empty'
      ? rolesState.data
      : { roles: [], version: 1 };
  const serviceIds = workspace?.services.map((s) => s.service_id) ?? [];
  const iaStates = await loadAllIa(serviceIds);
  const iaFailure = Object.values(iaStates).find(
    (state) =>
      state.kind === 'invalid' || state.kind === 'unreadable',
  );
  const iaDocuments: Record<string, StudioIaDocument | null> =
    Object.fromEntries(
      Object.entries(iaStates).map(([serviceId, state]) => [
        serviceId,
        state.kind === 'ready' || state.kind === 'empty'
          ? state.data
          : null,
      ]),
    );
  const iaTrees = iaFilesToTrees(iaDocuments, lexiconFile.terms);
  const layerCounts = {
    doks: dokCatalog.doks.length,
    lexicon: lexiconFile.terms.length,
    ia: countIaPageNodes(iaTrees),
    roles: rolesFile.roles.length,
  };

  return (
    <html lang="en">
      <body
        {...(demoWorkspace.status === 'own'
          ? {}
          : {
            'data-doklo-workspace': demoWorkspace.status,
            className: `demo-workspace demo-workspace-${demoWorkspace.status}`,
          })}
      >
        {demoWorkspace.status === 'own' ? null : (
          <DemoWorkspaceBanner state={demoWorkspace} />
        )}
        <StudioProvider
          layerCounts={layerCounts}
          initialIaTrees={iaTrees}
          workspaceState={workspaceState}
          doksState={doksState}
          lexiconState={lexiconState}
          rolesState={rolesState}
        >
          <RootLoadBoundary
            workspaceState={workspaceState}
            iaState={iaFailure}
          >
            {children}
          </RootLoadBoundary>
          {/* Phase 8 — palette + global shortcuts mount once at the
           *  root so they're available in every layout. */}
          <KeyboardShortcuts />
          <CommandPalette />
          <SaveGuard />
        </StudioProvider>
      </body>
    </html>
  );
}
