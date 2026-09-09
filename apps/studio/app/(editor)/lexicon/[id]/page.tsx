'use client';

import { useEffect, useMemo } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useStudio, type FocusedField } from '../../../../components/studio-store';
import { LexiconEditor } from '../../../../components/lexicon-editor';
import { SmartSidebar } from '../../../../components/smart-sidebar';
import { LexiconEditSidebar } from '../../../../components/smart-sidebar-content/lexicon-edit-sidebar';
import { focusKey } from '../../../../lib/hooks/use-focus-context';
import { LoadRecovery } from '../../../../components/load-recovery';

/**
 * /lexicon/[id] — canonical Lexicon term deep-edit URL. Mirrors the
 * doks/[id] page:
 *
 *   1. seed editingTerm from the matching workspace term (store.lexicon)
 *   2. clear on unmount so the next session starts clean
 *   3. mount <LexiconEditor /> + <SmartSidebar transitionKey>
 *
 * Deep-link focus: ?focus=<key> (e.g. ?focus=locale.ja or ?focus=canonical)
 * lands the editor on a specific block. When the id doesn't match any
 * workspace term, render a not-found state (no fixture fallback).
 */
export default function LexiconEditorPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id;
  const {
    lexicon,
    lexiconState,
    editingTerm,
    setEditingTerm,
    setFocusedField,
    focusedField,
  } = useStudio();

  const found = useMemo(
    () => (id ? lexicon.find((t) => t.term_id === id) ?? null : null),
    [id, lexicon],
  );

  useEffect(() => {
    if (!id) return;
    setEditingTerm(found);
    // Decide initial focus from ?focus= only (canonical / binding / used_in
    // / locale.<loc>). Anything else → null (default panel).
    setFocusedField(parseFocusParam(search?.get('focus') ?? null));

    return () => {
      setEditingTerm(null);
      setFocusedField(null);
    };
    // search is stable across rerenders for the same URL; depending on
    // it would refire focus on transient URL updates we don't trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id, found, setEditingTerm, setFocusedField]);

  if (lexiconState.kind === 'invalid' || lexiconState.kind === 'unreadable') {
    return <LoadRecovery layer="lexicon" state={lexiconState} />;
  }

  if (lexiconState.kind === 'missing' || lexiconState.kind === 'empty') {
    return (
      <section className="flex h-full items-center justify-center p-8 text-center text-ink-muted">
        <div>
          <h1 className="text-sm font-medium text-ink">No Lexicon terms are available.</h1>
          <code className="mt-2 block text-xs">{lexiconState.path}</code>
          <p className="mt-2 text-xs">Run <code>doklo generate</code> to create the Hub layers.</p>
        </div>
      </section>
    );
  }

  if (id && !found) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-ink-muted">
        <div>
          <p className="text-sm">
            Not found:{' '}
            <code className="font-mono text-ink-secondary">{id}</code>
          </p>
          <p className="mt-1 text-xs">
            <Link href="/lexicon" className="text-accent hover:underline">
              Back to Lexicon
            </Link>
          </p>
        </div>
      </div>
    );
  }

  if (!editingTerm) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        Loading Lexicon term…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <LexiconEditor />
      </main>
      <SmartSidebar transitionKey={focusKey(focusedField)}>
        <LexiconEditSidebar />
      </SmartSidebar>
    </div>
  );
}

/** Parse the `?focus=` query string into a FocusedField. Recognised
 *  shapes: "canonical", "binding", "used_in", "locale.<loc>". Anything
 *  else (or absent) returns null so the caller can fall back. */
function parseFocusParam(raw: string | null): FocusedField {
  if (!raw) return null;
  if (raw === 'canonical') return { kind: 'canonical' };
  if (raw === 'binding')   return { kind: 'binding' };
  if (raw === 'used_in')   return { kind: 'used_in' };
  if (raw.startsWith('locale.')) {
    const loc = raw.slice('locale.'.length);
    if (loc.length > 0) return { kind: 'locale', loc };
  }
  return null;
}
