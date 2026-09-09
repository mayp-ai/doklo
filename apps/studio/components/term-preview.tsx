'use client';

import type { LexiconTerm } from '@doklo-beta/core';
import { useSelectedTerm, useStudio, termDisplay } from './studio-store';
import { SmartSidebarSection } from './smart-sidebar';
import { CATEGORY_META } from '../lib/term-display';
import { useCrossLayerJump } from '../lib/hooks/use-cross-layer-jump';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';

/** Country flag for a locale code. Centralized so the table and the
 *  preview use the same glyph for the same locale. */
const LOCALE_FLAG: Record<string, string> = {
  ko: '🇰🇷',
  en: '🇺🇸',
  ja: '🇯🇵',
  zh: '🇨🇳',
};

/**
 * TermPreview — Lexicon-specific SmartSidebar content. Subscribes to
 * useSelectedTerm() directly so it can render in any view that mounts
 * <SmartSidebar><TermPreview /></SmartSidebar>. Returns null when no
 * term is selected; the SmartSidebar shell shows its empty hint.
 */
export function TermPreview() {
  const term = useSelectedTerm();
  const { projectLocales } = useStudio();
  const jump = useCrossLayerJump();
  const { push } = useSafeNavigation();
  if (!term) return null;

  const display = projectLocales.map((loc) => ({
    loc,
    text: termDisplay(term, loc),
  }));
  const present = display.filter((d) => d.text != null).length;
  const total = display.length;

  const primary =
    display.find((d) => d.text != null)?.text ?? `(${term.term_id})`;

  const catMeta = CATEGORY_META[term.category];

  return (
    <div>
      <div className="mb-2 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Selected Term
      </div>
      <span className="mb-3 inline-block rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
        {term.term_id}
      </span>
      <h3 className="mb-1.5 text-xl font-semibold leading-tight tracking-tight text-ink-strong">
        {primary}
      </h3>
      <div className="mb-4 text-[12.5px] text-ink-muted">
        {term.category === 'role'
          ? `${catMeta.icon} role · UI wording`
          : 'UI wording'}
      </div>

      <SmartSidebarSection title="Binding">
        <BindingCard term={term} />
      </SmartSidebarSection>

      <SmartSidebarSection title="Locales" count={`${present} / ${total}`}>
        <ul className="m-0 list-none p-0">
          {display.map(({ loc, text }) => (
            <li
              key={loc}
              className="grid grid-cols-[28px_24px_1fr] items-center gap-2.5 py-2 text-[13px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border"
            >
              <span className="text-base" aria-hidden>
                {LOCALE_FLAG[loc] ?? '🏳'}
              </span>
              <span className="font-mono text-[11px] tracking-wide text-ink-muted">
                {loc}
              </span>
              {text != null ? (
                <span className="text-ink-strong">{text}</span>
              ) : (
                <span className="inline-flex items-center gap-2 text-[12px] italic text-status-draft-fg">
                  <span>Empty</span>
                  <span className="rounded-full bg-status-draft-bg px-1.5 py-0.5 text-[10.5px] not-italic text-status-draft-fg">
                    Add
                  </span>
                </span>
              )}
            </li>
          ))}
        </ul>
      </SmartSidebarSection>

      <SmartSidebarSection
        title="Used in"
        count={`${term.related_doks.length} doks`}
      >
        {term.related_doks.length === 0 ? (
          <div className="text-[12px] text-ink-muted">
            No Dok references this term yet.
          </div>
        ) : (
          <ul className="m-0 list-none p-0">
            {term.related_doks.map((dokId) => (
              <li key={dokId} className="m-0 p-0">
                <button
                  type="button"
                  onClick={() => jump.jumpToDok(dokId)}
                  className="flex w-full items-center gap-2 py-1.5 text-left text-[13px] hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border"
                >
                  <span className="shrink-0 rounded-full border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
                    {dokId}
                  </span>
                  <span className="flex-1 truncate text-ink-secondary">
                    {/* Real Dok name lookup arrives once topology edges
                     *  are wired — for now we surface the id. */}
                    {dokId}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </SmartSidebarSection>

      {term.binding.type === 'i18n' && (
        <SmartSidebarSection title="Source files">
          <ul className="m-0 list-none p-0">
            {term.binding.files.map((file, i) => (
              <li
                key={file}
                className="flex items-baseline justify-between py-1.5 font-mono text-[11.5px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border"
              >
                <span className="text-ink-muted">
                  {term.binding.type === 'i18n'
                    ? term.binding.supported_locales[i] ?? '—'
                    : ''}
                </span>
                <span className="font-medium text-ink">{file}</span>
              </li>
            ))}
          </ul>
        </SmartSidebarSection>
      )}

      <button
        type="button"
        onClick={() => void push(`/lexicon/${term.term_id}`)}
        className="mt-6 flex w-full items-center justify-center gap-2 rounded-md bg-accent px-3.5 py-2.5 text-[13.5px] font-semibold text-canvas transition-colors hover:bg-accent-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        <span>Open in lexicon-editor</span>
        <span className="rounded-[3px] bg-white/15 px-1.5 py-0.5 font-mono text-[10.5px] font-medium">
          ⌘↵
        </span>
      </button>
    </div>
  );
}

function BindingCard({ term }: { term: LexiconTerm }) {
  return (
    <div className="rounded-md border border-border bg-canvas p-3">
      <KV k="type" v={term.binding.type} vClass="text-accent-ink" />
      {term.binding.type === 'i18n' && (
        <>
          <KV k="key" v={term.binding.key} />
          <KV k="supported" v={term.binding.supported_locales.join(' · ')} />
        </>
      )}
      {term.binding.type === 'constant' && (
        <KV k="reference" v={term.binding.reference} />
      )}
      {term.binding.type === 'owned' && (
        <KV
          k="owns"
          v={`${Object.keys(term.locales ?? {}).length} locale(s)`}
        />
      )}
    </div>
  );
}

function KV({
  k,
  v,
  vClass,
}: {
  k: string;
  v: string;
  vClass?: string;
}) {
  return (
    <div className="flex justify-between gap-2 py-1 text-[12.5px]">
      <span className="text-ink-muted">{k}</span>
      <span className={`truncate text-right font-mono text-[12px] font-medium text-ink ${vClass ?? ''}`}>
        {v}
      </span>
    </div>
  );
}
