'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import type { LexiconTerm, Translatable } from '@doklo-beta/core';
import { createLexiconTermAction } from '../lib/actions';
import { usePersistentAction } from '../lib/hooks/use-persistent-action';
import { useStudio } from './studio-store';

export interface TermOption {
  term_id: string;
  category: string;
  preview: string;
}

interface Props {
  value: Translatable;
  onChange: (next: Translatable) => void;
  onBlurSave?: () => void;
  onFocus?: () => void;
  terms: TermOption[];
  termByIdLocale: Record<string, string>; // term_id → resolved preview in active locale
  /** "input" — single-line, "textarea" — multi-line. Default input. */
  variant?: 'input' | 'textarea';
  className?: string;
  placeholder?: string;
  rows?: number;
  ariaLabel?: string;
  /** Default term_id seed when promoting string → TermRef. e.g. "TERM-NAME-{DOK}". */
  newTermIdSeed?: string;
  /** Lexicon term category to use when creating a new term inline. */
  newTermCategory?: LexiconTerm['category'];
  /** Called when the user clicks the resolved TermRef chip — Smart Sidebar
   *  uses this to swap into "inspect this term" mode. */
  onInspectTerm?: (termId: string) => void;
}

/**
 * Inline Translatable editor.
 *
 * - String form: renders a normal input / textarea.
 * - TermRef form: shows resolved locale text + small "→ TERM-xxx" chip linking
 *   to /lexicon/<id>. To edit the wording, jump into Lexicon.
 *
 * A small ↔ toggle next to the field switches between the two forms.
 */
export function TranslatableEditor({
  value,
  onChange,
  onBlurSave,
  onFocus,
  terms,
  termByIdLocale,
  variant = 'input',
  className,
  placeholder,
  rows = 3,
  ariaLabel,
  newTermIdSeed,
  newTermCategory = 'concept',
  onInspectTerm,
}: Props) {
  const [pickerOpen, setPickerOpen] = useState(false);
  const wrapperRef = useRef<HTMLSpanElement>(null);
  const isRef = typeof value !== 'string';
  const stringValue = typeof value === 'string' ? value : '';
  const refValue = isRef ? value.term_ref : '';
  const resolved = isRef ? termByIdLocale[refValue] ?? '' : '';

  const openPicker = () => setPickerOpen(true);
  const closePicker = () => setPickerOpen(false);

  // Promote: string → newly minted TermRef (creating the Lexicon entry server-side)
  const { lexiconState } = useStudio();
  const lexiconRevision =
    lexiconState.kind === 'ready' || lexiconState.kind === 'empty'
      ? lexiconState.revision
      : null;
  const lexiconRevisionRef = useRef(lexiconRevision);
  useEffect(() => {
    lexiconRevisionRef.current = lexiconRevision;
  }, [lexiconRevision]);
  const createTerm = usePersistentAction<LexiconTerm>({
    key: `inline-term:${newTermIdSeed ?? 'auto'}`,
    path: lexiconState.path,
    persist: (term) => {
      const expectedRevision = lexiconRevisionRef.current;
      if (expectedRevision === null) {
        return Promise.resolve({
          ok: false,
          code: 'MISSING',
          path: lexiconState.path,
          error: 'Lexicon is not available for inline term creation.',
          preserved: true,
        });
      }
      return createLexiconTermAction({
        term,
        expectedRevision,
      });
    },
    onSuccess: (term, result) => {
      lexiconRevisionRef.current = result.revision;
      onChange({ term_ref: term.term_id });
      closePicker();
    },
  });

  const handleSelect = (id: string) => {
    onChange({ term_ref: id });
    closePicker();
  };

  const handlePromote = async () => {
    const text = stringValue.trim();
    if (!text) return;
    const baseId = (newTermIdSeed ?? slugify(text)).toUpperCase();
    let id = baseId.startsWith('TERM-') ? baseId : `TERM-${baseId}`;
    // Avoid clashing with an existing term
    const existingIds = new Set(terms.map((t) => t.term_id));
    if (existingIds.has(id)) {
      let n = 2;
      while (existingIds.has(`${id}-${n}`)) n += 1;
      id = `${id}-${n}`;
    }
    await createTerm.execute({
      term_id: id,
      category: newTermCategory,
      binding: { type: 'owned' },
      locales: { ko: text, en: text },
      related_doks: [],
    });
  };

  const handleDemote = () => {
    const fallback = resolved || refValue;
    onChange(fallback);
    closePicker();
  };

  return (
    <span className="translatable-row" ref={wrapperRef}>
      {isRef ? (
        <button
          type="button"
          className="termref-resolved termref-resolved-button"
          onClick={() => onInspectTerm?.(refValue)}
          title={`Inspect ${refValue}`}
        >
          <span className="termref-resolved-locale">term</span>
          <span>
            {resolved || (
              <em style={{ color: 'var(--color-ink-faint)' }}>
                (locale empty)
              </em>
            )}
          </span>
          <span className="termref-resolved-id">{refValue}</span>
        </button>
      ) : variant === 'textarea' ? (
        <textarea
          className={className}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlurSave}
          rows={rows}
          placeholder={placeholder}
          aria-label={ariaLabel}
          spellCheck={false}
        />
      ) : (
        <input
          className={className}
          value={stringValue}
          onChange={(e) => onChange(e.target.value)}
          onFocus={onFocus}
          onBlur={onBlurSave}
          placeholder={placeholder}
          aria-label={ariaLabel}
          spellCheck={false}
        />
      )}

      <span style={{ position: 'relative', display: 'inline-flex' }}>
        <button
          type="button"
          className="termref-toggle"
          data-active={isRef ? 'true' : 'false'}
          onClick={() => (isRef ? handleDemote() : openPicker())}
          aria-pressed={isRef}
          aria-label={isRef ? 'Convert TermRef to plain text' : 'Link to a Lexicon term'}
          title={isRef ? 'Unlink to plain text' : 'Link to a Lexicon term'}
        >
          {isRef ? 'TERM ↩' : '↪ TERM'}
        </button>
        {pickerOpen && !isRef && (
          <TermRefPicker
            anchor={wrapperRef.current}
            initialQuery={stringValue}
            terms={terms}
            onSelect={handleSelect}
            onPromote={stringValue.trim() && lexiconRevision !== null ? handlePromote : undefined}
            onClose={closePicker}
          />
        )}
      </span>
    </span>
  );
}

function TermRefPicker({
  initialQuery,
  terms,
  onSelect,
  onPromote,
  onClose,
}: {
  anchor: HTMLElement | null;
  initialQuery: string;
  terms: TermOption[];
  onSelect: (id: string) => void;
  onPromote?: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState(initialQuery);
  const [active, setActive] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return terms;
    return terms.filter(
      (t) =>
        t.term_id.toLowerCase().includes(q) ||
        t.preview.toLowerCase().includes(q),
    );
  }, [query, terms]);

  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      } else if (e.key === 'ArrowDown') {
        e.preventDefault();
        setActive((a) => Math.min(a + 1, filtered.length - 1));
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setActive((a) => Math.max(a - 1, 0));
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = filtered[active];
        if (t) onSelect(t.term_id);
      }
    }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [filtered, active, onClose, onSelect]);

  return (
    <>
      <div className="dropdown-overlay" onClick={onClose} aria-hidden />
      <div className="termref-picker" role="dialog">
        <input
          className="termref-picker-input"
          value={query}
          onChange={(e) => {
            setQuery(e.target.value);
            setActive(0);
          }}
          placeholder="Search an existing term or create a new one…"
          autoFocus
          spellCheck={false}
        />
        <ul className="termref-picker-list" role="listbox">
          {filtered.length === 0 ? (
            <li
              style={{
                padding: 'var(--space-3)',
                fontSize: 12,
                color: 'var(--color-ink-faint)',
              }}
            >
              No matching term.
            </li>
          ) : (
            filtered.map((t, i) => (
              <li key={t.term_id}>
                <button
                  type="button"
                  className={
                    i === active
                      ? 'termref-picker-item is-active'
                      : 'termref-picker-item'
                  }
                  onClick={() => onSelect(t.term_id)}
                  onMouseEnter={() => setActive(i)}
                >
                  <span className="termref-picker-item-id">{t.term_id}</span>
                  <span className="termref-picker-item-preview">
                    {t.preview || (
                      <em style={{ color: 'var(--color-ink-faint)' }}>
                        (empty)
                      </em>
                    )}
                  </span>
                  <span className="termref-picker-item-category">
                    {t.category}
                  </span>
                </button>
              </li>
            ))
          )}
        </ul>
        {onPromote && (
          <button
            type="button"
            className="termref-picker-create"
            onClick={onPromote}
          >
            <span>＋</span>
            <span>
              Create a new owned term from <strong>“{query.trim() || '(enter text)'}”</strong>
            </span>
          </button>
        )}
      </div>
    </>
  );
}

function slugify(s: string): string {
  return s
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9가-힣]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/[가-힣]+/g, (m) => `KO-${m.length}`) // hangul: collapse to KO-N marker
    .slice(0, 40);
}
