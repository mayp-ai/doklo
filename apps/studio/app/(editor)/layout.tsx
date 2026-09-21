import type { ReactNode } from 'react';
import { loadWorkspace } from '../../lib/data';
import { AppHeader } from '../../components/app-header';
import { EditorTreeRail } from '../../components/editor-tree-rail';

export const dynamic = 'force-dynamic';

/**
 * (editor) shell — used by single-item edit routes (doks/[id],
 * lexicon/[id], roles/[id]). Same header as hub-views, but the left
 * rail swaps per route via EditorTreeRail (DokTree on /doks/*,
 * TermTree on /lexicon/*, future RoleTree on /roles/*).
 *
 * The page itself owns the main + SmartSidebar(dynamic) split so each
 * editor can plug its own focus-driven sidebar content.
 */
export default async function EditorLayout({ children }: { children: ReactNode }) {
  const workspace = await loadWorkspace();
  return (
    <div className="grid h-screen grid-cols-1 grid-rows-[56px_minmax(0,1fr)] bg-canvas md:grid-cols-[240px_minmax(0,1fr)]">
      <div className="col-span-full row-start-1">
        <AppHeader workspace={workspace} />
      </div>
      <div className="hidden overflow-y-auto md:col-start-1 md:row-start-2 md:block">
        <EditorTreeRail />
      </div>
      <div className="col-start-1 row-start-2 min-h-0 overflow-hidden md:col-start-2">
        {children}
      </div>
    </div>
  );
}
