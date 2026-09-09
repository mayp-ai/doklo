'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  acceptLexiconSuggestionAction,
  rejectLexiconSuggestionAction,
} from '../lib/actions';
import type { LexiconSuggestion } from '../lib/data';
import { usePersistentAction } from '../lib/hooks/use-persistent-action';
import { useStudio } from './studio-store';

interface Props {
  initialSuggestions: LexiconSuggestion[];
  generatedAt: string;
  corpusSize: number;
  defaultLocale: string;
  suggestionsRevision: string;
  suggestionsPath: string;
}

type SuggestionRequest = {
  kind: 'accept' | 'reject';
  suggestion: LexiconSuggestion;
};

export function LexiconSuggestions({
  initialSuggestions,
  generatedAt,
  corpusSize,
  defaultLocale,
  suggestionsRevision,
  suggestionsPath,
}: Props) {
  const router = useRouter();
  const [items, setItems] = useState<LexiconSuggestion[]>(initialSuggestions);
  const [pendingText, setPendingText] = useState<string | null>(null);
  const [awaitingRefresh, setAwaitingRefresh] = useState(false);
  const awaitingRefreshRef = useRef(false);
  const { lexiconState } = useStudio();
  const lexiconRevision =
    lexiconState.kind === 'ready' || lexiconState.kind === 'empty'
      ? lexiconState.revision
      : null;
  const revisionKey = `${suggestionsRevision}:${lexiconRevision ?? 'missing'}`;
  const revisionKeyRef = useRef(revisionKey);
  useEffect(() => {
    if (revisionKeyRef.current === revisionKey) return;
    revisionKeyRef.current = revisionKey;
    awaitingRefreshRef.current = false;
    setAwaitingRefresh(false);
    setPendingText(null);
    setItems(initialSuggestions);
  }, [initialSuggestions, revisionKey]);
  const mutation = usePersistentAction<SuggestionRequest>({
    key: `lexicon-suggestions:${revisionKey}`,
    path: suggestionsPath,
    persist: ({ kind, suggestion }) => {
      if (kind === 'reject') {
        return rejectLexiconSuggestionAction({
          text: suggestion.text,
          expectedRevision: suggestionsRevision,
        });
      }
      if (lexiconRevision === null) {
        return Promise.resolve({
          ok: false,
          code: 'MISSING',
          path: lexiconState.path,
          error: 'Lexicon is not available for suggestion acceptance.',
          preserved: true,
        });
      }
      return acceptLexiconSuggestionAction({
        text: suggestion.text,
        category: suggestion.category,
        reason: suggestion.reason,
        dok_refs: suggestion.dok_refs,
        defaultLocale,
        expectedRevision: lexiconRevision,
        expectedSuggestionsRevision: suggestionsRevision,
      });
    },
    onSuccess: ({ suggestion }) => {
      awaitingRefreshRef.current = true;
      setAwaitingRefresh(true);
      setItems((prev) => prev.filter((item) => item.text !== suggestion.text));
      router.refresh();
    },
  });

  if (items.length === 0) return null;

  const handleAccept = async (s: LexiconSuggestion) => {
    if (awaitingRefreshRef.current) return;
    setPendingText(s.text);
    await mutation.execute({ kind: 'accept', suggestion: s });
    setPendingText(null);
  };

  const handleReject = async (s: LexiconSuggestion) => {
    if (awaitingRefreshRef.current) return;
    setPendingText(s.text);
    await mutation.execute({ kind: 'reject', suggestion: s });
    setPendingText(null);
  };

  return (
    <section
      className="dok-section"
      aria-busy={pendingText !== null || awaitingRefresh ? 'true' : undefined}
    >
      <h2 className="section-title">
        <span className="section-title-label">Suggested candidates</span>
        <span className="section-title-count">{items.length}</span>
      </h2>
      <p className="sidebar-hint" style={{ marginBottom: 'var(--space-4)' }}>
        Candidate domain key terms Claude extracted from the body of {corpusSize} Doks.
        <span style={{ color: 'var(--color-ink-faint)', marginLeft: 8 }}>
          {generatedAt
            ? `Generated: ${new Date(generatedAt).toLocaleString('en-US')}`
            : ''}
        </span>
      </p>
      {awaitingRefresh && (
        <p role="status" className="sidebar-hint">
          Refreshing suggestions…
        </p>
      )}
      <ul
        style={{
          listStyle: 'none',
          padding: 0,
          margin: 0,
          display: 'grid',
          gap: 'var(--space-2)',
        }}
      >
        {items.map((s) => {
          const isPending = pendingText === s.text;
          const actionsDisabled = pendingText !== null || awaitingRefresh;
          return (
            <li key={s.text}>
              <article
                className="suggestion-card"
                aria-busy={isPending || undefined}
              >
                <div className="suggestion-head">
                  <span className="suggestion-text">{s.text}</span>
                </div>
                {s.reason && (
                  <p className="suggestion-reason">{s.reason}</p>
                )}
                {s.dok_refs.length > 0 && (
                  <div className="suggestion-refs">
                    {s.dok_refs.map((d) => (
                      <a
                        key={d}
                        href={`/doks/${d}`}
                        className="meta-chip"
                        style={{ fontSize: 10 }}
                      >
                        {d}
                      </a>
                    ))}
                  </div>
                )}
                <div className="suggestion-actions">
                  <button
                    type="button"
                    className="suggestion-btn accept"
                    onClick={() => void handleAccept(s)}
                    disabled={actionsDisabled}
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="suggestion-btn reject"
                    onClick={() => void handleReject(s)}
                    disabled={actionsDisabled}
                  >
                    Reject
                  </button>
                </div>
              </article>
            </li>
          );
        })}
      </ul>
    </section>
  );
}
