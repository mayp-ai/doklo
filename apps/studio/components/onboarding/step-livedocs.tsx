'use client';

import { useState, type ComponentType } from 'react';
import {
  ArrowRight,
  BookOpen,
  Check,
  Download,
  FileText,
  Loader2,
  Users,
} from 'lucide-react';
import {
  WIZARD_LIVEDOCS,
  LIVEDOCS_UI,
  type DocLocale,
  type LivedocTemplateMeta,
  type WizardLivedoc,
} from '../../lib/livedoc-templates';
import { triggerDownload } from '../../lib/download';
import { useOnboarding } from './onboarding-store';
import { Reveal, STAGGER } from './reveal';

const ICONS: Record<string, ComponentType<{ className?: string }>> = {
  'saas-prd': FileText,
  'help-page': BookOpen,
  'github-onboarding': Users,
};

export function StepLivedocs() {
  const { locale } = useOnboarding();
  const [selected, setSelected] = useState<LivedocTemplateMeta>(WIZARD_LIVEDOCS[0]!);
  const [busy, setBusy] = useState(false);
  const [made, setMade] = useState<Set<string>>(new Set()); // keyed `${ref}:${locale}`
  const [error, setError] = useState<string | null>(null);

  const madeKey = (ref: string) => `${ref}:${locale}`;
  const ui = LIVEDOCS_UI[locale];

  async function onMake(meta: LivedocTemplateMeta) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch('/api/wizard/livedoc', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ref: meta.ref, locale }),
      });
      const data = (await res.json()) as WizardLivedoc & { error?: string };
      if (!res.ok || data.error) throw new Error(data.error ?? `HTTP ${res.status}`);
      triggerDownload(data);
      setMade((prev) => new Set(prev).add(madeKey(meta.ref)));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-2">
        <Reveal delay={0} className="flex items-center gap-3">
          <span className="text-xs font-semibold uppercase tracking-wide text-accent">
            STEP · LIVE DOCS
          </span>
        </Reveal>
        <Reveal delay={STAGGER} as="h2" className="text-xl font-bold tracking-tight text-ink-strong">
          {ui.heading}
        </Reveal>
      </div>

      <div className="flex gap-6">
        {/* Left: selectable list */}
        <Reveal delay={STAGGER * 2} className="flex w-64 shrink-0 flex-col gap-2">
          {WIZARD_LIVEDOCS.map((t) => {
            const Icon = ICONS[t.ref] ?? FileText;
            const active = selected.ref === t.ref;
            return (
              <button
                key={t.ref}
                type="button"
                onClick={() => setSelected(t)}
                className={[
                  'flex items-center gap-3 rounded-lg border px-3 py-2.5 text-left transition-all duration-150',
                  active
                    ? 'border-accent bg-accent-soft/60'
                    : 'border-border bg-surface hover:border-border-strong hover:bg-surface-2',
                ].join(' ')}
              >
                <div
                  className={[
                    'flex h-8 w-8 shrink-0 items-center justify-center rounded-md',
                    active ? 'bg-accent text-canvas' : 'bg-accent-soft text-accent',
                  ].join(' ')}
                >
                  <Icon className="h-4 w-4" />
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-semibold text-ink-strong">{t.title[locale]}</p>
                  <p className="text-xs text-ink-faint">{t.audience[locale]}</p>
                </div>
                {made.has(madeKey(t.ref)) && <Check className="h-4 w-4 shrink-0 text-success" />}
              </button>
            );
          })}
        </Reveal>

        {/* Right: simple depiction of the selected document + make button */}
        <Reveal delay={STAGGER * 3} className="flex min-w-0 flex-1 flex-col gap-3">
          <div className="flex items-center justify-between gap-3">
            <p className="text-sm text-ink-muted">{selected.desc[locale]}</p>
            <button
              type="button"
              onClick={() => onMake(selected)}
              disabled={busy}
              className="inline-flex shrink-0 items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas shadow-sm transition-all duration-200 hover:bg-accent-hover disabled:opacity-60"
            >
              {busy ? (
                <Loader2 className="wizard-spin h-3.5 w-3.5" />
              ) : made.has(madeKey(selected.ref)) ? (
                <Check className="h-3.5 w-3.5" />
              ) : (
                <Download className="h-3.5 w-3.5" />
              )}
              {busy ? ui.busy : made.has(madeKey(selected.ref)) ? ui.made : ui.make}
            </button>
          </div>
          <DocSketch key={`${selected.ref}:${locale}`} meta={selected} locale={locale} />
          {error && (
            <p className="rounded-md bg-danger-bg px-3 py-2 text-sm text-danger">{error}</p>
          )}
        </Reveal>
      </div>

      {/* Generation mutates the Hub after the root layout was hydrated.
       * A document navigation reloads the generated layers for Studio. */}
      <Reveal delay={STAGGER * 4}>
        <a
          href="/doks"
          className="group inline-flex items-center gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-canvas no-underline shadow-md transition-all duration-200 hover:bg-accent-hover hover:no-underline hover:shadow-lg"
        >
          {ui.finish}
          <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
        </a>
      </Reveal>
    </div>
  );
}

const BAR_WIDTHS = ['100%', '92%', '78%', '85%', '64%'];

/** A lightweight depiction of what the rendered document looks like — a
 *  faux page with the title, audience chip, and labelled sections of
 *  placeholder lines. Not the real render (intentionally simple). */
function DocSketch({ meta, locale }: { meta: LivedocTemplateMeta; locale: DocLocale }) {
  const Icon = ICONS[meta.ref] ?? FileText;
  const sections = meta.sections[locale];
  return (
    <div className="wizard-rise min-h-[23rem] overflow-hidden rounded-lg border border-border bg-white shadow-sm">
      <div className="h-1 w-full bg-accent" />
      <div className="flex flex-col gap-4 p-6">
        <div className="flex items-center gap-2">
          <div className="flex h-7 w-7 items-center justify-center rounded-md bg-accent-soft text-accent">
            <Icon className="h-4 w-4" />
          </div>
          <span className="rounded-pill bg-surface-2 px-2 py-0.5 text-[10px] font-medium text-ink-secondary">
            {meta.audience[locale]}
          </span>
        </div>
        <div className="h-4 w-3/5 rounded bg-ink-strong/85" />

        {sections.map((section, i) => (
          <div key={section} className="flex flex-col gap-1.5">
            <div className="flex items-center gap-1.5">
              <span className="text-[11px] font-semibold text-accent">{i + 1}</span>
              <span className="text-xs font-semibold text-ink-secondary">{section}</span>
            </div>
            <div className="h-2 rounded bg-surface-2" style={{ width: BAR_WIDTHS[i % BAR_WIDTHS.length] }} />
            <div className="h-2 rounded bg-surface-2" style={{ width: BAR_WIDTHS[(i + 2) % BAR_WIDTHS.length] }} />
          </div>
        ))}
      </div>
    </div>
  );
}
