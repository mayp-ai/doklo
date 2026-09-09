'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams } from 'next/navigation';
import { useStudio } from '../../../../components/studio-store';
import { DokEditor } from '../../../../components/dok-editor';
import { SmartSidebar } from '../../../../components/smart-sidebar';
import { DokEditSidebar } from '../../../../components/smart-sidebar-content/dok-edit-sidebar';
import { focusKey } from '../../../../lib/hooks/use-focus-context';
import { LoadRecovery } from '../../../../components/load-recovery';

/**
 * /doks/[id] — the canonical Dok deep-edit URL. Resolves the target Dok
 * from the workspace catalog in the store (no synthetic fallback), seeds the
 * store's editingDok on mount, and clears it on unmount so the dynamic
 * SmartSidebar always reads a fresh dok. An id with no match renders a
 * not-found state rather than falling back to fabricated data.
 *
 * Layout: <main DokEditor /> + <SmartSidebar transitionKey=focusKey>
 *   <DokEditSidebar />
 * </SmartSidebar>
 */
export default function DokEditorPage() {
  const params = useParams<{ id: string }>();
  const id = params?.id;
  const { doks, doksState, editingDok, setEditingDok, focusedField } = useStudio();

  // Resolve straight from the store so "not found" is decided
  // synchronously — no fixture fallback, and no flash while the mount
  // effect below syncs editingDok for the SmartSidebar.
  const target = id ? doks.find((d) => d.dok_id === id) ?? null : null;

  useEffect(() => {
    setEditingDok(target);
    return () => {
      // Clear on unmount so a stale Dok doesn't bleed into the next
      // editor session.
      setEditingDok(null);
    };
  }, [target, setEditingDok]);

  if (doksState.kind === 'invalid' || doksState.kind === 'unreadable') {
    return <LoadRecovery layer="doks" state={doksState} />;
  }

  if (doksState.kind === 'missing' || doksState.kind === 'empty') {
    return <MissingDoks path={doksState.path} />;
  }

  if (!target) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-ink-muted">
        <p className="text-sm">
          Not found: <code className="font-mono text-ink-secondary">{id}</code>
        </p>
        <Link
          href="/doks"
          className="rounded text-[13px] text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          Back to Doks
        </Link>
      </div>
    );
  }

  if (!editingDok) {
    // target exists but the mount effect hasn't synced the store yet
    // (one frame) — brief by construction.
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        Loading Dok…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <DokEditor />
      </main>
      <SmartSidebar transitionKey={focusKey(focusedField)}>
        <DokEditSidebar />
      </SmartSidebar>
    </div>
  );
}

function MissingDoks({ path }: { path: string }) {
  return (
    <section className="flex h-full items-center justify-center p-8 text-center text-ink-muted">
      <div>
        <h1 className="text-sm font-medium text-ink">No Doks are available.</h1>
        <code className="mt-2 block text-xs">{path}</code>
        <p className="mt-2 text-xs">Run <code>doklo generate</code> to extract them from code.</p>
      </div>
    </section>
  );
}
