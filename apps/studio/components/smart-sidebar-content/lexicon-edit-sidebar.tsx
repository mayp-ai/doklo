'use client';

import type { ReactNode } from 'react';
import { useStudio } from '../studio-store';
import { resolveDokName } from '../../lib/term-display';

/**
 * LexiconEditSidebar — focus-driven content router for the lexicon
 * editor's right pane. Mirrors DokEditSidebar's shape:
 *
 *   focusedField → which card stack to render
 *   null         → DefaultMetaPanel (schema-field term overview)
 *
 * Every card is backed by real LexiconTerm schema fields; there are no
 * synthetic suggestion / impact / meta cards.
 */
export function LexiconEditSidebar() {
  const { focusedField, editingTerm } = useStudio();
  if (!editingTerm) return null;

  switch (focusedField?.kind) {
    case 'canonical':
      return <CanonicalCollisionCard />;
    case 'binding':
      return <BindingDescriptionCard />;
    case 'locale':
      return <LocaleEditorCards loc={focusedField.loc} />;
    case 'used_in':
      return <UsedInDetailCard />;
    default:
      return <DefaultMetaPanel />;
  }
}

// ── Focus-specific cards ────────────────────────────────────────────

function NowEditingBadge({ label }: { label: string }) {
  return (
    <div className="mb-4 inline-flex w-fit items-center gap-1.5 rounded-full bg-accent-soft px-2.5 py-1.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-accent-ink">
      <span className="h-1.5 w-1.5 animate-[pulse_1.4s_ease-in-out_infinite] rounded-full bg-accent" />
      Now editing — {label}
    </div>
  );
}

function Card({
  children,
  tone = 'plain',
}: {
  children: ReactNode;
  tone?: 'plain' | 'accent';
}) {
  const cls =
    tone === 'accent'
      ? 'border-accent-soft-strong bg-accent-soft'
      : 'border-border bg-canvas';
  return (
    <div className={`mb-3.5 rounded-md border ${cls} p-4.5`}>{children}</div>
  );
}

function LocaleEditorCards({ loc }: { loc: string }) {
  const { editingTerm } = useStudio();
  if (!editingTerm) return null;

  const sourceFile =
    editingTerm.binding.type === 'i18n'
      ? editingTerm.binding.files.find((f) => f.includes(`/${loc}.`)) ??
        `locales/${loc}.json`
      : null;

  return (
    <>
      <NowEditingBadge label={`locale.${loc}`} />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Edit locale.{loc}
        </h4>
        {editingTerm.binding.type === 'i18n' ? (
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            Refine the {loc} translation of this i18n key. On save it&apos;s
            written through to{' '}
            <code className="font-mono text-[11.5px] text-ink">{sourceFile}</code>
            .
          </p>
        ) : (
          <p className="text-[12.5px] leading-relaxed text-ink-secondary">
            Refine the {loc} wording.{' '}
            {editingTerm.binding.type === 'owned'
              ? 'The Lexicon owns this text (SoT).'
              : 'This snapshot caches the code constant.'}
          </p>
        )}
      </Card>
    </>
  );
}

function CanonicalCollisionCard() {
  const { editingTerm } = useStudio();
  if (!editingTerm) return null;
  return (
    <>
      <NowEditingBadge label="canonical" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          canonical wording
        </h4>
        <p className="text-[12.5px] leading-relaxed text-ink-secondary">
          The <strong className="text-ink-strong">reference wording</strong> for
          multilingual comparison — usually the ko text. Changing it updates the
          inline wording of{' '}
          <strong className="text-ink-strong">
            {editingTerm.related_doks.length} Doks
          </strong>{' '}
          that reference this term.
        </p>
      </Card>
    </>
  );
}

function BindingDescriptionCard() {
  return (
    <>
      <NowEditingBadge label="binding" />
      <Card>
        <h4 className="mb-1.5 text-[15px] font-semibold tracking-tight text-ink-strong">
          Binding — where the SoT lives
        </h4>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
          Sets this wording&apos;s <strong className="text-ink-strong">source of truth</strong>.
          Switching it moves the SoT, so it carries a large operational impact.
        </p>
        <ul className="m-0 list-none space-y-2 p-0 text-[12px] text-ink-secondary">
          <li>
            <strong className="font-mono text-[11px] text-ink">i18n</strong> — the i18n
            file is the SoT. The snapshot is a lexicon cache.
          </li>
          <li>
            <strong className="font-mono text-[11px] text-ink">constant</strong> — the code
            constant is the SoT. The snapshot is a lexicon cache.
          </li>
          <li>
            <strong className="font-mono text-[11px] text-ink">owned</strong> — the Lexicon
            itself is the SoT (no external file).
          </li>
        </ul>
      </Card>
    </>
  );
}

function UsedInDetailCard() {
  const { editingTerm, doks, lexicon, projectLocales } = useStudio();
  if (!editingTerm) return null;
  return (
    <>
      <NowEditingBadge label="used in" />
      <Card>
        <h4 className="mb-2 text-[15px] font-semibold tracking-tight text-ink-strong">
          Doks that use this term
        </h4>
        <p className="mb-3 text-[12.5px] leading-relaxed text-ink-secondary">
          Wording changes or added locales propagate to the inline wording of{' '}
          <strong className="text-ink-strong">
            {editingTerm.related_doks.length} Doks
          </strong>
          .
        </p>
        {editingTerm.related_doks.length > 0 ? (
          <ul className="m-0 list-none space-y-1 p-0">
            {editingTerm.related_doks.map((id) => (
              <li
                key={id}
                className="flex items-center gap-2 rounded-sm bg-surface px-2 py-1.5 text-[12px] text-ink-secondary"
              >
                <span className="shrink-0 rounded-full border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10px] font-medium text-accent-ink">
                  {id}
                </span>
                <span className="truncate">
                  {resolveDokName(id, doks, lexicon, projectLocales)}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-[12px] text-ink-muted">Not referenced by any Dok.</p>
        )}
      </Card>
    </>
  );
}

function DefaultMetaPanel() {
  const { editingTerm } = useStudio();
  if (!editingTerm) return null;
  const t = editingTerm;
  const localeCount =
    t.binding.type === 'i18n'
      ? t.binding.supported_locales.length
      : Object.keys(t.locales ?? t.snapshot ?? {}).length;
  return (
    <>
      <div className="mb-4 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Term overview
      </div>
      <Card>
        <ul className="m-0 list-none p-0">
          <OverviewKV k="term_id" v={t.term_id} />
          <OverviewKV k="category" v={t.category} />
          <OverviewKV k="binding" v={t.binding.type} />
          {t.binding.type === 'i18n' && <OverviewKV k="key" v={t.binding.key} />}
          {t.binding.type === 'constant' && (
            <OverviewKV k="reference" v={t.binding.reference} />
          )}
          <OverviewKV k="locales" v={`${localeCount}`} />
          <OverviewKV k="used in" v={`${t.related_doks.length} doks`} />
        </ul>
      </Card>
    </>
  );
}

function OverviewKV({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex justify-between gap-2 py-1.5 text-[12px] text-ink-muted [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border">
      <span>{k}</span>
      <span className="max-w-[60%] truncate font-mono text-[11.5px] text-ink-secondary">
        {v}
      </span>
    </li>
  );
}
