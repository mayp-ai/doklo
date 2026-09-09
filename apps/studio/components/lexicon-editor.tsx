'use client';

import { useCallback } from 'react';
import type { LexiconTerm } from '@doklo-beta/core';
import { useStudio } from './studio-store';
import { saveOwnedLexiconLocaleAction } from '../lib/actions';
import { useFocusContext } from '../lib/hooks/use-focus-context';
import { useDurableSave } from '../lib/hooks/use-durable-save';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import { termDisplay, resolveDokName } from '../lib/term-display';

/** Resolve owned/constant display text from the schema-authorized map.
 * i18n bindings return null because their text lives in source files. */
function resolveDisplay(
  term: LexiconTerm,
  loc: string,
): string | null {
  return termDisplay(term, loc);
}

type LocalePatch = { locale: string; text: string };

/**
 * LexiconEditor — main pane of the lexicon-editor route. Reads the
 * editing term from the studio store (so the dynamic
 * SmartSidebar can subscribe to the same source) and renders only fields
 * that exist on the LexiconTerm schema. Related-Dok names + i18n file
 * paths come from real workspace data; there is no synthetic meta/sync
 * layer (the schema has none).
 */
export function LexiconEditor() {
  const {
    editingTerm,
    updateEditingTerm,
    lexiconState,
    doks,
    lexicon,
    projectLocales,
  } = useStudio();
  const { handlers, clearFocus } = useFocusContext();
  const termId = editingTerm?.term_id ?? '';
  const exactRevision =
    lexiconState.kind === 'ready' || lexiconState.kind === 'empty'
      ? lexiconState.revision
      : '';
  const persist = useCallback(
    (patch: LocalePatch, expectedRevision: string) =>
      saveOwnedLexiconLocaleAction({
        termId,
        locale: patch.locale,
        text: patch.text,
        expectedRevision,
      }),
    [termId],
  );
  const durable = useDurableSave<LocalePatch>({
    key: `lexicon:${termId}`,
    path: lexiconState.path,
    initialRevision: exactRevision,
    merge: (_current, next) => next,
    persist,
  });
  const updateOwnedLocale = useCallback((locale: string, text: string) => {
    if (!editingTerm || editingTerm.binding.type !== 'owned') return;
    updateEditingTerm({
      locales: { ...editingTerm.locales, [locale]: text },
    });
    durable.queue({ locale, text });
  }, [durable, editingTerm, updateEditingTerm]);

  if (!editingTerm) return null;
  const term = editingTerm;

  // i18n file list (empty for owned/constant) — used by the locale rows
  // and the Source files section. Real schema field: binding.files.
  const i18nFiles = term.binding.type === 'i18n' ? term.binding.files : [];

  // Visible locales — i18n trusts binding.supported_locales; owned/constant
  // use whichever text map the binding owns.
  const visibleLocales =
    term.binding.type === 'i18n'
      ? term.binding.supported_locales
      : Array.from(new Set([
          ...projectLocales,
          ...Object.keys(term.locales ?? term.snapshot ?? {}),
        ]));

  // Studio can only resolve/judge owned + constant text. i18n text lives
  // in files Studio has no reader for, so it never claims those "missing".
  const canResolveText = term.binding.type !== 'i18n';
  const missingLocales = canResolveText
    ? visibleLocales.filter((loc) => resolveDisplay(term, loc) == null)
    : [];
  const allFilled = missingLocales.length === 0;

  // Canonical = ko display (or any first-filled locale) — mockup renders
  // this as the 28px headline. Falls back to the term_id when no text is
  // Studio-resolvable (i18n).
  const canonical =
    resolveDisplay(term, 'ko') ??
    visibleLocales
      .map((l) => resolveDisplay(term, l))
      .find((t) => t != null) ??
    term.term_id;

  const usedInCount = term.related_doks.length;
  const usedInRows = term.related_doks.slice(0, 6);
  const usedInOverflow = Math.max(usedInCount - usedInRows.length, 0);

  const statusBadgeClass =
    term.binding.type === 'i18n'
      ? 'bg-surface-2 text-ink-muted'
      : allFilled
        ? 'bg-status-active-bg text-status-active-fg'
        : 'bg-status-draft-bg text-status-draft-fg';

  return (
    <article
      onClick={(e) => {
        if (e.target === e.currentTarget) clearFocus();
      }}
      className="mx-auto w-full max-w-[720px] px-10 pb-20 pt-8"
    >
      {/* ─── Header ─── */}
      <header className="mb-6">
        <div className="mb-3 flex items-center gap-2.5">
          <span className="rounded-full bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium tracking-[0.02em] text-accent-ink">
            {term.term_id}
          </span>
          <span
            className={[
              'inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 font-mono text-[10.5px] font-semibold uppercase tracking-[0.08em]',
              statusBadgeClass,
            ].join(' ')}
          >
            {term.binding.type === 'i18n'
              ? 'i18n · text in files'
              : allFilled
                ? 'synced'
                : `${missingLocales.join(', ')} missing`}
          </span>
          <span className="ml-auto font-mono text-[11px] text-ink-muted">
            used in{' '}
            <span className="font-semibold text-ink">{usedInCount}</span> doks
          </span>
        </div>

        {/* Missing-locale notice — owned/constant with a genuinely empty
            locale (i18n is never judged missing). */}
        {!allFilled && (
          <MissingLocaleNotice missing={missingLocales} count={usedInCount} />
        )}

        {/* Canonical (28px) + meta row */}
        <CanonicalBlock
          value={canonical}
          onFocus={handlers({ kind: 'canonical' }).onFocus}
        />
        <TermMetaRow term={term} />
      </header>

      {/* ─── Binding section ─── */}
      <Section
        label="Binding"
        hint="SoT — where the source of truth for this wording lives"
      >
        <div
          className="grid grid-cols-3 gap-2"
          onFocus={handlers({ kind: 'binding' }).onFocus}
          tabIndex={-1}
        >
          <BindingCard
            kind="i18n"
            active={term.binding.type === 'i18n'}
            desc="i18n files are the SoT. The snapshot is a lexicon cache."
          />
          <BindingCard
            kind="constant"
            active={term.binding.type === 'constant'}
            desc="A code constant is the SoT. The snapshot is a lexicon cache."
          />
          <BindingCard
            kind="owned"
            active={term.binding.type === 'owned'}
            desc="The Lexicon itself is the SoT (no external file)."
          />
        </div>
      </Section>

      {/* ─── Locales table ─── */}
      <Section
        label="Locales"
        count={`${visibleLocales.length - missingLocales.length} of ${visibleLocales.length}${
          missingLocales.length > 0 ? ` · ${missingLocales.join(', ')} missing` : ''
        }`}
        hint={
          term.binding.type === 'i18n'
            ? 'i18n source files are the source of truth. Edit them in your codebase.'
            : term.binding.type === 'constant'
              ? 'Code constants are the source of truth. Studio shows the cached snapshot.'
              : 'The Lexicon is the SoT'
        }
      >
        <div className="overflow-hidden rounded-md border border-border bg-surface">
          {visibleLocales.map((loc, idx) => {
            const text = resolveDisplay(term, loc);
            return (
              <LocaleRow
                key={loc}
                loc={loc}
                text={text}
                missing={canResolveText && text == null}
                fileMeta={
                  i18nFiles.find((f) => f.includes(`/${loc}.`)) ?? null
                }
                isLast={idx === visibleLocales.length - 1}
                onFocus={handlers({ kind: 'locale', loc }).onFocus}
                readOnly={term.binding.type !== 'owned'}
                onBlur={() => void durable.flush()}
                onChange={(v) => updateOwnedLocale(loc, v)}
              />
            );
          })}
        </div>
      </Section>

      {/* ─── Used in N doks ─── */}
      <Section
        label="Used in"
        count={`${usedInCount} doks`}
        hint="Doks where this term appears — changes propagate automatically"
      >
        <div
          className="grid grid-cols-2 gap-x-3 gap-y-1.5"
          onFocus={handlers({ kind: 'used_in' }).onFocus}
          tabIndex={-1}
        >
          {usedInRows.map((id) => (
            <UsedRow
              key={id}
              id={id}
              name={resolveDokName(id, doks, lexicon, projectLocales)}
            />
          ))}
          {usedInOverflow > 0 && (
            <div className="col-span-2 px-3 py-2 text-center text-[12px] text-ink-muted">
              + {usedInOverflow} more
            </div>
          )}
        </div>
      </Section>

      {/* ─── Source files (i18n only) ─── */}
      {term.binding.type === 'i18n' && i18nFiles.length > 0 && (
        <Section label="Source files" hint="i18n binding, so external files are the SoT">
          <ul className="m-0 list-none rounded-md border border-border bg-surface px-4 py-3.5">
            {i18nFiles.map((path, idx) => (
              <li
                key={path}
                className={[
                  'py-1.5 font-mono text-[11.5px] text-ink',
                  idx === i18nFiles.length - 1
                    ? ''
                    : 'border-b border-dashed border-border',
                ].join(' ')}
              >
                {path}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </article>
  );
}

// ─── Block primitives ───────────────────────────────────────────────

function Section({
  label,
  count,
  hint,
  children,
}: {
  label: string;
  count?: string;
  hint?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mb-10">
      <header className="mb-3.5 flex items-center gap-2.5">
        <span className="font-mono text-[10.5px] font-semibold uppercase tracking-[0.14em] text-ink-muted">
          {label}
        </span>
        {count && <span className="font-mono text-[11px] text-ink-faint">{count}</span>}
        {hint && (
          <span className="ml-auto text-[12px] italic text-ink-faint">{hint}</span>
        )}
      </header>
      {children}
    </section>
  );
}

function MissingLocaleNotice({
  missing,
  count,
}: {
  missing: string[];
  count: number;
}) {
  const list = missing.join(', ');
  return (
    <div className="mb-6 flex items-center gap-3 rounded-r-md border-l-[3px] border-l-status-draft-fg bg-status-draft-bg px-3.5 py-3">
      <span
        aria-hidden
        className="grid h-5 w-5 shrink-0 place-items-center text-[14px] text-status-draft-fg"
      >
        ⚠
      </span>
      <div className="flex-1 text-[13px] text-ink">
        <strong className="font-semibold text-status-draft-fg">
          {list} translation is empty
        </strong>
        {' '}— filling it in propagates to {count} Doks automatically
      </div>
    </div>
  );
}

function CanonicalBlock({
  value,
  onFocus,
}: {
  value: string;
  onFocus: () => void;
}) {
  return (
    <div className="mt-2 flex items-baseline gap-3.5">
      <span className="w-16 shrink-0 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        canonical
      </span>
      <button
        type="button"
        onClick={onFocus}
        onFocus={onFocus}
        className="-mx-1 cursor-text rounded-sm px-1 py-0.5 text-left text-[28px] font-bold leading-[1.15] tracking-[-0.02em] text-ink-strong hover:bg-surface focus:bg-surface focus:shadow-focus focus:outline-none"
      >
        {value}
      </button>
    </div>
  );
}

function TermMetaRow({ term }: { term: LexiconTerm }) {
  const catShort = CAT_SHORT[term.category] ?? term.category;
  return (
    <div className="ml-[78px] mt-1 flex flex-wrap items-center gap-2.5 text-[12.5px] text-ink-muted">
      <span className="rounded-sm border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
        {catShort}
      </span>
      <span className="opacity-50">·</span>
      {term.binding.type === 'i18n' && (
        <span className="font-mono text-[11px]">
          i18n · key:{' '}
          <strong className="font-semibold text-ink">{term.binding.key}</strong>
        </span>
      )}
      {term.binding.type === 'constant' && (
        <span className="font-mono text-[11px]">
          constant ·{' '}
          <strong className="font-semibold text-ink">{term.binding.reference}</strong>
        </span>
      )}
      {term.binding.type === 'owned' && (
        <span className="font-mono text-[11px]">owned · Lexicon SoT</span>
      )}
    </div>
  );
}

const CAT_SHORT: Record<LexiconTerm['category'], string> = {
  concept: 'concept',
  role:    'role',
};

function BindingCard({
  kind,
  active,
  desc,
}: {
  kind: LexiconTerm['binding']['type'];
  active: boolean;
  desc: string;
}) {
  return (
    <div
      aria-current={active ? 'true' : undefined}
      className={[
        'rounded-md border p-3.5 text-left',
        active
          ? 'border-accent bg-accent-soft'
          : 'border-border bg-surface',
      ].join(' ')}
    >
      <div className="mb-1 flex items-center gap-2">
        <span
          className={[
            'relative h-3.5 w-3.5 shrink-0 rounded-full border-[1.5px]',
            active ? 'border-accent' : 'border-border-strong',
          ].join(' ')}
        >
          {active && (
            <span className="absolute inset-[3px] rounded-full bg-accent" />
          )}
        </span>
        <span
          className={[
            'font-mono text-[13px] font-semibold',
            active ? 'text-accent-ink' : 'text-ink-strong',
          ].join(' ')}
        >
          {kind}
        </span>
      </div>
      <div
        className={[
          'text-[11.5px] leading-[1.55]',
          active ? 'text-accent-ink opacity-85' : 'text-ink-muted',
        ].join(' ')}
      >
        {desc}
      </div>
    </div>
  );
}

function LocaleRow({
  loc,
  text,
  missing,
  fileMeta,
  isLast,
  onFocus,
  onBlur,
  onChange,
  readOnly,
}: {
  loc: string;
  text: string | null;
  missing: boolean;
  fileMeta: string | null;
  isLast: boolean;
  onFocus: () => void;
  onBlur: () => void;
  onChange: (v: string) => void;
  readOnly: boolean;
}) {
  return (
    <div
      className={[
        'grid grid-cols-[60px_1fr_auto] items-center gap-4 px-4 py-2.5 text-[15px]',
        isLast ? '' : 'border-b border-border',
        missing
          ? 'border-l-[3px] border-l-status-draft-fg bg-status-draft-bg pl-[13px]'
          : '',
        'focus-within:bg-surface focus-within:shadow-[inset_0_0_0_1.5px_var(--color-accent)]',
      ].join(' ')}
    >
      <span className="font-mono text-[11.5px] tracking-[0.04em] text-ink-muted">
        {loc}
      </span>
      <input
        type="text"
        value={text ?? ''}
        placeholder="Enter the translation for this locale"
        onFocus={onFocus}
        onBlur={onBlur}
        onChange={(e) => onChange(e.target.value)}
        readOnly={readOnly}
        aria-readonly={readOnly ? 'true' : undefined}
        spellCheck={false}
        aria-label={`${loc} translation`}
        className={[
          'rounded-sm bg-transparent px-1.5 py-1 outline-none',
          missing
            ? 'italic placeholder:text-ink-faint placeholder:italic text-ink-strong'
            : 'text-ink-strong',
        ].join(' ')}
      />
      <span
        className={[
          'font-mono text-[10.5px]',
          missing ? 'font-semibold text-status-draft-fg' : 'text-ink-faint',
        ].join(' ')}
      >
        {missing ? '⚠ empty' : fileMeta ?? ''}
      </span>
    </div>
  );
}

function UsedRow({ id, name }: { id: string; name: string }) {
  const { push } = useSafeNavigation();
  return (
    <button
      type="button"
      onClick={() => void push(`/doks/${encodeURIComponent(id)}`)}
      className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 text-left text-[12.5px] hover:border-border-strong hover:bg-canvas focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
    >
      <span className="shrink-0 rounded-full bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
        {id}
      </span>
      <span className="flex-1 truncate text-ink-secondary">{name}</span>
    </button>
  );
}
