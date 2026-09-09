'use client';

import { useMemo, useState, type KeyboardEvent } from 'react';
import type { LexiconTerm } from '@doklo-beta/core';
import {
  useLexiconStats,
  useStudio,
  useFilteredTerms,
  termDisplay,
  termSupportedLocales,
} from './studio-store';
import { SmartSidebar } from './smart-sidebar';
import { TermPreview } from './term-preview';
import { useTermDeepLink } from '../lib/hooks/use-deep-link-sync';
import { useListKeyboardNav } from '../lib/hooks/use-list-keyboard-nav';

const BINDING_BADGE: Record<LexiconTerm['binding']['type'], string> = {
  i18n:     'border border-accent-soft-strong bg-accent-soft text-accent-ink',
  constant: 'bg-status-draft-bg text-status-draft-fg',
  owned:    'bg-status-deprecated-bg text-status-deprecated-fg',
};

const LOCALE_FLAG: Record<string, string> = {
  ko: '🇰🇷',
  en: '🇺🇸',
  ja: '🇯🇵',
  zh: '🇨🇳',
};

// ──────────────────────────────────────────────────────────────────────

export function LexiconCatalog() {
  useTermDeepLink();
  const stats = useLexiconStats();
  const flatTerms = useFilteredTerms();
  const [query, setQuery] = useState('');
  const {
    projectLocales,
    activeLocales,
    toggleLocale,
    selectedTermId,
    setSelectedTerm,
    missingOnly,
    setMissingOnly,
  } = useStudio();
  const visibleTerms = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase();
    if (!normalized) return flatTerms;
    return flatTerms.filter((term) => {
      if (term.term_id.toLocaleLowerCase().includes(normalized)) return true;
      return projectLocales.some((locale) =>
        termDisplay(term, locale)?.toLocaleLowerCase().includes(normalized),
      );
    });
  }, [flatTerms, projectLocales, query]);
  const listNav = useListKeyboardNav({
    items: visibleTerms,
    selectedId: selectedTermId,
    getKey: (t) => t.term_id,
    onSelect: setSelectedTerm,
  });

  return (
    <div className="flex h-full">
      <main className="flex min-w-0 flex-1 flex-col overflow-y-auto">
        {/* Search-first (Lexicon's primary affordance) */}
        <div className="border-b border-border bg-surface px-7 pb-[18px] pt-[22px]">
          <label className="flex max-w-xl items-center gap-3 rounded-md border border-border-strong bg-canvas px-4 py-2.5 shadow-sm transition-colors focus-within:border-accent focus-within:shadow-focus">
            <span aria-hidden className="text-sm text-ink-muted">⌕</span>
            <input
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search terms and translations · in any of ko / en / ja"
              className="flex-1 bg-transparent text-sm text-ink-strong placeholder:text-ink-faint focus:outline-none"
            />
            <span className="rounded-sm border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
              ⌘K
            </span>
          </label>
          <div className="mt-4 flex flex-wrap items-baseline gap-x-5 gap-y-1 font-mono text-xs text-ink-muted">
            <MetaStat n={stats.total}    label="terms" />
            <MetaStat n={stats.i18n}     label="i18n-bound" tone="accent" />
            <MetaStat n={stats.constant} label="constant-bound" />
            <MetaStat n={stats.owned}    label="owned" />
            <MetaStat n={stats.missing}  label="translations missing" tone="warn" />
          </div>
        </div>

        {/* Locale strip — distinct to Lexicon */}
        <div className="flex flex-wrap items-center gap-1.5 border-b border-border bg-canvas px-7 py-2.5">
          <span className="mr-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
            project locales:
          </span>
          {projectLocales.map((loc) => (
            <LocaleChip
              key={loc}
              loc={loc}
              active={activeLocales.includes(loc)}
              onClick={() => toggleLocale(loc)}
            />
          ))}
          <div className="ml-auto flex items-center gap-1.5">
            <button
              type="button"
              aria-pressed={missingOnly}
              onClick={() => setMissingOnly(!missingOnly)}
              className={[
                'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]',
                'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
                missingOnly
                  ? 'border-accent-soft-strong bg-accent-soft text-accent-ink'
                  : 'border-border bg-transparent text-ink-secondary hover:bg-surface hover:text-ink',
              ].join(' ')}
            >
              missing only
            </button>
          </div>
        </div>

        {/* Table */}
        <div tabIndex={-1} onKeyDown={listNav.onKeyDown} className="outline-none">
          <table className="w-full border-collapse text-[13px]">
            <thead>
              <tr>
                <Th className="w-[200px]">Term ID</Th>
                <Th className="min-w-[260px]">Display</Th>
                <Th className="w-[88px]">Binding</Th>
                <Th className="w-[96px] text-right">Used in</Th>
                <Th className="w-[130px] text-center">Locales</Th>
              </tr>
            </thead>
            <tbody>
              {visibleTerms.length === 0 ? (
                <tr>
                  <td
                    colSpan={5}
                    className="px-7 py-12 text-center text-sm text-ink-muted"
                  >
                    No matching terms.
                  </td>
                </tr>
              ) : (
                visibleTerms.map((t) => (
                  <TermRow
                    key={t.term_id}
                    term={t}
                    activeLocales={activeLocales}
                    selected={t.term_id === selectedTermId}
                    onSelect={() => setSelectedTerm(t.term_id)}
                  />
                ))
              )}
            </tbody>
          </table>
        </div>

        {/* i18n-less project note */}
        <div className="border-t border-border bg-surface px-7 py-3.5 text-[12.5px] leading-relaxed text-ink-secondary">
          <div className="mb-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
            No i18n in your project?
          </div>
          Turn on just ko in the locale strip and{' '}
          <strong className="text-ink">the "Locales" column drops automatically.</strong>{' '}
          The remaining columns (<strong className="text-ink">Display · Binding · Used in</strong>) still power
          the catalog, search, and duplicate-wording cleanup. The point of Lexicon is{' '}
          <em className="font-medium not-italic text-accent">
            "one place for every word this project uses"
          </em>
          , not multilingual support itself.
        </div>
      </main>
      <SmartSidebar>
        <TermPreview />
      </SmartSidebar>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────────

function Th({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <th
      className={[
        'sticky top-0 z-10 border-b border-border bg-surface-2 px-4 py-3',
        'font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted text-left',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </th>
  );
}

function TermRow({
  term,
  activeLocales,
  selected,
  onSelect,
}: {
  term: LexiconTerm;
  activeLocales: string[];
  selected: boolean;
  onSelect: () => void;
}) {
  // Primary text — first defined locale across the project locales.
  // For owned/constant we read from their own maps; i18n bindings have no
  // in-Studio text (their SoT lives in workspace i18n files, and Studio has
  // no reader yet), so termDisplay returns null and we fall back to '(not set)'.
  const primary =
    activeLocales.map((l) => termDisplay(term, l)).find((t) => t != null) ??
    '(not set)';

  const handleKey = (e: KeyboardEvent<HTMLTableRowElement>) => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onSelect();
    }
  };

  return (
    <tr
      role="button"
      tabIndex={0}
      data-row-id={term.term_id}
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      onKeyDown={handleKey}
      className={[
        'cursor-pointer transition-colors',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
        selected
          ? 'bg-accent-soft shadow-[inset_3px_0_0_var(--color-accent)]'
          : 'hover:bg-surface',
      ].join(' ')}
    >
      <Td>
        <span className="font-mono text-[11.5px] tracking-[0.02em] text-accent-ink">
          {term.term_id}
        </span>
      </Td>
      <Td>
        <span className="inline-flex items-center gap-2">
          <span className="text-[13.5px] font-medium text-ink-strong">
            {primary}
          </span>
          {term.category === 'role' && (
            <span className="inline-block rounded-sm bg-accent-soft px-2 py-0.5 font-mono text-[10.5px] font-medium tracking-[0.04em] text-accent-ink">
              role
            </span>
          )}
        </span>
      </Td>
      <Td>
        <span
          className={[
            'inline-block rounded-sm px-2 py-0.5 font-mono text-[10.5px] font-medium tracking-[0.04em]',
            BINDING_BADGE[term.binding.type],
          ].join(' ')}
        >
          {term.binding.type}
        </span>
      </Td>
      <Td className="text-right">
        <span className="font-mono text-xs text-ink-muted">
          <span className="text-[13px] font-semibold text-ink">
            {term.related_doks.length}
          </span>{' '}
          {term.related_doks.length === 1 ? 'dok' : 'doks'}
        </span>
      </Td>
      <Td className="text-center">
        <LocalesCell term={term} activeLocales={activeLocales} />
      </Td>
    </tr>
  );
}

function Td({ children, className }: { children: React.ReactNode; className?: string }) {
  return (
    <td
      className={[
        'border-b border-border px-4 py-3 align-middle',
        className ?? '',
      ].join(' ')}
    >
      {children}
    </td>
  );
}

function LocalesCell({
  term,
  activeLocales,
}: {
  term: LexiconTerm;
  activeLocales: string[];
}) {
  const supported = new Set(termSupportedLocales(term));

  // "ko only" pill: owned binding with exactly one locale present and
  // it being ko (mockup AUTH-SIGNIN row example). When that triggers we
  // skip the flag row entirely.
  const koOnly =
    term.binding.type === 'owned' &&
    supported.size === 1 &&
    supported.has('ko');
  if (koOnly) {
    return (
      <span className="inline-block rounded-full border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[10.5px] text-ink-muted">
        ko only
      </span>
    );
  }

  // Per-active-locale flag, dimmed when missing.
  const missing = activeLocales.filter((l) => termDisplay(term, l) == null);

  return (
    <span className="inline-flex items-center gap-0.5 whitespace-nowrap text-base tracking-[2px]">
      {activeLocales.map((loc) => {
        const isMissing = termDisplay(term, loc) == null;
        return (
          <span
            key={loc}
            aria-label={`${loc}${isMissing ? ' (missing)' : ''}`}
            className={isMissing ? 'opacity-25 grayscale-[0.85]' : 'opacity-95'}
          >
            {LOCALE_FLAG[loc] ?? '🏳'}
          </span>
        );
      })}
      {missing.length > 0 && (
        <span className="ml-0.5 text-[11px] font-semibold tracking-normal text-status-draft-fg">
          {missing.length === 1 ? '⚠' : `⚠ ${missing.length}`}
        </span>
      )}
    </span>
  );
}

function MetaStat({
  n,
  label,
  tone,
}: {
  n: number;
  label: string;
  tone?: 'accent' | 'warn';
}) {
  const numCls =
    tone === 'accent' ? 'text-accent' :
    tone === 'warn'   ? 'text-status-draft-fg' :
                        'text-ink';
  return (
    <span className="inline-flex items-baseline gap-1">
      <span className={`text-sm font-semibold ${numCls}`}>{n}</span>
      <span>{label}</span>
    </span>
  );
}

function LocaleChip({
  loc,
  active,
  onClick,
}: {
  loc: string;
  active: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border px-3 py-1 text-[12.5px]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
        active
          ? 'border-accent-soft-strong bg-accent-soft text-accent-ink'
          : 'border-border bg-transparent text-ink-secondary hover:bg-surface hover:text-ink',
      ].join(' ')}
    >
      {active && <span className="text-[11px]">✓</span>}
      {loc}
    </button>
  );
}
