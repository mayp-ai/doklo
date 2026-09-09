'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { LexiconCategory, LexiconTerm } from '@doklo-beta/core';
import { useStudio } from './studio-store';
import { CATEGORY_META, termDisplay } from '../lib/term-display';

const CATEGORY_ORDER: LexiconCategory[] = ['concept', 'role'];

type PipKind = 'synced' | 'missing' | 'never-used';

const PIP_CLASS: Record<PipKind, string> = {
  synced:       'bg-status-active-fg',
  missing:      'bg-status-draft-fg',
  'never-used': 'bg-ink-faint',
};

/**
 * TermTree — 240px left rail for the (editor)/lexicon/[id] route.
 * Replaces DokTree on the lexicon-editor page. Same shell shape
 * (category group header + linked rows) so the rail feels consistent
 * across the three editors.
 *
 * Renders the real workspace Lexicon (store.lexicon), grouped by
 * category in the mockup's display order.
 */
export function TermTree() {
  const pathname = usePathname() ?? '';
  const { lexicon, projectLocales } = useStudio();
  const activeId =
    pathname.startsWith('/lexicon/')
      ? decodeURIComponent(pathname.split('/').filter(Boolean)[1] ?? '')
      : null;

  const grouped = new Map<LexiconCategory, LexiconTerm[]>();
  for (const t of lexicon) {
    const bucket = grouped.get(t.category) ?? [];
    bucket.push(t);
    grouped.set(t.category, bucket);
  }
  const ordered = CATEGORY_ORDER
    .filter((c) => grouped.has(c))
    .map((c) => [c, grouped.get(c)!] as const);

  return (
    <nav
      aria-label="Lexicon term tree"
      className="flex min-h-full w-60 flex-col overflow-y-auto border-r border-border bg-surface py-3"
    >
      {ordered.map(([category, terms]) => {
        const meta = CATEGORY_META[category];
        return (
          <div key={category} className="mb-1">
            <div className="flex items-center gap-2 px-4 pb-1.5 pt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
              <span aria-hidden>{meta.icon}</span>
              <span>{meta.label.split(' · ')[0]}</span>
              <span className="ml-auto font-mono text-[11px] text-ink-faint">
                {terms.length}
              </span>
            </div>
            <ul className="m-0 list-none p-0">
              {terms.map((t) => (
                <TermRow
                  key={t.term_id}
                  term={t}
                  active={t.term_id === activeId}
                  projectLocales={projectLocales}
                />
              ))}
            </ul>
          </div>
        );
      })}
    </nav>
  );
}

function TermRow({
  term,
  active,
  projectLocales,
}: {
  term: LexiconTerm;
  active: boolean;
  projectLocales: readonly string[];
}) {
  const pip = computePip(term, projectLocales);

  // Display label = first resolvable project-locale text, falling back to
  // the term_id when no text is Studio-resolvable (e.g. i18n bindings,
  // whose text lives in workspace i18n files Studio has no reader for).
  // The id shown to the right is the short tail (everything after the
  // second `-`). Full id stays in the link aria-label.
  const label =
    projectLocales
      .map((loc) => termDisplay(term, loc))
      .find((t) => t != null) ?? term.term_id;
  const shortId = shortenTermId(term.term_id);

  return (
    <li className="m-0 p-0">
      <Link
        href={`/lexicon/${term.term_id}`}
        aria-current={active ? 'page' : undefined}
        aria-label={`${term.term_id} · ${label}`}
        className={[
          'grid grid-cols-[8px_1fr_auto] items-center gap-2.5 px-4 py-1.5 text-[12.5px] no-underline',
          'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
          active
            ? 'bg-accent-soft font-medium text-accent-ink shadow-[inset_3px_0_0_var(--color-accent)]'
            : 'text-ink-secondary hover:bg-surface-2 hover:text-ink',
        ].join(' ')}
      >
        <span
          aria-label={`status ${pip}`}
          className={`h-1.5 w-1.5 rounded-full ${PIP_CLASS[pip]}`}
        />
        <span className="truncate">{label}</span>
        <span
          className={[
            'font-mono text-[10px] tracking-[0.02em]',
            active ? 'text-accent-ink' : 'text-ink-faint',
          ].join(' ')}
        >
          {shortId}
        </span>
      </Link>
    </li>
  );
}

function computePip(
  term: LexiconTerm,
  projectLocales: readonly string[],
): PipKind {
  if (term.related_doks.length === 0) return 'never-used';
  // i18n-bound terms have no Studio-resolvable text (their text lives in
  // workspace i18n files with no reader yet) → Studio can't judge them
  // missing, matching the store's missing-locale accounting.
  if (term.binding.type === 'i18n') return 'synced';
  const missing = projectLocales.some(
    (loc) => termDisplay(term, loc) == null,
  );
  return missing ? 'missing' : 'synced';
}

/** TERM-CON-SELLER → SELLER.  TERM-BTN-CREATE-DASHBOARD → CRT-DASH.
 *  Keep it pragmatic: take the segment after the category, drop any
 *  internal hyphens beyond a comfortable length. */
function shortenTermId(id: string): string {
  // TERM-<CAT>-<TAIL>
  const parts = id.split('-');
  if (parts.length < 3) return id.replace(/^TERM-/, '');
  const tail = parts.slice(2).join('-');
  if (tail.length <= 8) return tail;
  // Compact common bigrams (-CREATE- → CRT, -DASHBOARD → DASH).
  const compact = tail
    .replace(/CREATE/i, 'CRT')
    .replace(/DASHBOARD/i, 'DASH')
    .replace(/INVALID/i, 'INV')
    .replace(/EXPIRED/i, 'EXP')
    .replace(/INVITE/i, 'IV')
    .replace(/INVITATION/i, 'INVITE')
    .replace(/OVERDUE/i, 'OVERDU')
    .replace(/CREDENTIAL/i, 'CR');
  return compact.length > 10 ? compact.slice(0, 10) : compact;
}
