import type { ReactNode } from 'react';
import { loadWorkspace } from '../../lib/data';
import { AppHeader } from '../../components/app-header';
import { LayerRailNav } from '../../components/layer-rail-nav';

export const dynamic = 'force-dynamic';

// (hub) shell: AppHeader on top, LayerRail on the left, page content
// fills the rest. Each (hub) page owns its own main+SmartSidebar grid
// inside the body cell — that way Doks/Lexicon/IA/Roles can each plug
// in their layer-specific preview component (DokPreview / TermPreview
// / RoutePreview / RolePreview) without the shell knowing about them.
//
// Phase 8: the command palette + keyboard shortcuts mount at the
// RootLayout level (so legacy pages get them too), so this layout no
// longer threads doks/live-docs/lexicon/roles into AppHeader — the palette
// reads them straight from the studio store.
export default async function HubLayout({ children }: { children: ReactNode }) {
  const workspace = await loadWorkspace();

  return (
    <div className="hub-shell grid h-screen grid-cols-[240px_minmax(0,1fr)] grid-rows-[56px_minmax(0,1fr)] bg-canvas">
      <div className="hub-header col-span-full row-start-1">
        <AppHeader workspace={workspace} />
      </div>
      <div className="hub-rail col-start-1 row-start-2 overflow-y-auto">
        <LayerRailNav />
      </div>
      {/* Body cell — children mount their own flex(main + SmartSidebar).
       *  Using min-h-0 + overflow-hidden so independent scroll regions
       *  inside children don't push the layout grid. */}
      <div className="hub-body col-start-2 row-start-2 min-h-0 overflow-hidden">
        {children}
      </div>
    </div>
  );
}
