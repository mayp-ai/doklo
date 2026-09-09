'use client';

// Hub-ready screen — lands the trust message right after extraction:
//   ① the generated Hub (Dok list, with code_anchor provenance)
//   ② the "AI agents query this Hub over MCP" cut
// then hands over to the Live Docs step, the journey's final deliverable.
// The quality score is intentionally absent (2026-06-02 decision).

import { ArrowRight, Bot, Database, FileText } from 'lucide-react';
import { WIZARD_COPY } from '../../lib/wizard-copy';
import { useOnboarding, type DokCard } from './onboarding-store';
import { Reveal, STAGGER } from './reveal';
import { SplitBody } from './wizard-frame';

const HUB_LIST_MAX = 6;

export function StepHub() {
  const { revealedDoks, goTo, locale } = useOnboarding();
  const c = WIZARD_COPY[locale].hub;

  const doks: DokCard[] = revealedDoks;
  const n = doks.length;
  const shown = doks.slice(0, HUB_LIST_MAX);
  const firstDok = doks[0];

  return (
    <SplitBody
      narrative={
        <>
          <Reveal delay={0}>
            <span className="text-xs font-semibold uppercase tracking-wide text-accent">
              {c.eyebrow}
            </span>
          </Reveal>
          <Reveal delay={STAGGER} as="h2" className="whitespace-nowrap text-2xl font-bold leading-tight tracking-tight text-ink-strong">
            {c.title}
          </Reveal>
          <Reveal delay={STAGGER * 2} as="p" className="text-base leading-relaxed text-ink-muted">
            {locale === 'en' ? (
              <>
                <span className="font-semibold text-ink">{n} Doks</span> are organized in your Hub.
                People read and refine them in Studio — AI agents query them over MCP.
              </>
            ) : (
              <>
                <span className="font-semibold text-ink">{n}개 Dok</span>이 Hub에 정리됐어요. 사람은
                Studio에서 읽고 다듬고, AI 에이전트는 MCP로 query합니다.
              </>
            )}
          </Reveal>

          <Reveal delay={STAGGER * 3} className="rounded-lg border border-border bg-surface/70 p-4 shadow-sm">
            <div className="flex items-start gap-3">
              <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                <Bot className="h-4 w-4" />
              </div>
              <div className="min-w-0">
                <p className="text-sm font-semibold text-ink-strong">{c.mcpTitle}</p>
                <p className="mt-1 text-xs leading-relaxed text-ink-muted">{c.mcpDesc}</p>
              </div>
            </div>
            {/* The query names a Dok this workspace actually holds. With an
             *  empty Hub there is nothing to name, so the block shows the
             *  call *shape* and says so — borrowing a plausible Dok ID here
             *  would read as a result Doklo found in the user's code. */}
            <div className="mt-3 rounded-md bg-ink-strong p-3 font-mono text-[11px] leading-relaxed text-canvas">
              {firstDok === undefined && (
                <p className="mb-2 font-sans text-[10px] uppercase tracking-wide text-canvas/60">
                  {c.mcpExampleLabel}
                </p>
              )}
              <p>
                <span className="text-success">agent</span>
                <span className="text-canvas/60"> › </span>
                doklo.get_dok(&quot;{firstDok?.dok_id ?? '<dok-id>'}&quot;)
              </p>
              <p className="truncate text-canvas/70">
                ← {firstDok === undefined
                  ? c.mcpExampleReturn
                  : `${firstDok.name} · scenarios · rules · acceptance`}
              </p>
            </div>
          </Reveal>

          <Reveal delay={STAGGER * 4} className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => goTo('livedocs')}
              className="group inline-flex items-center gap-2 rounded-md bg-accent px-5 py-2.5 text-sm font-semibold text-canvas shadow-md transition-all duration-200 hover:bg-accent-hover hover:shadow-lg"
            >
              {c.next}
              <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
            </button>
            {/* Generation mutates the Hub on disk after the root layout was
             * hydrated. A document navigation reloads that server-owned data. */}
            <a
              href="/doks"
              className="inline-flex items-center rounded-md border border-border px-4 py-2.5 text-sm font-medium text-ink-secondary no-underline transition-colors hover:bg-surface-2 hover:no-underline"
            >
              {c.editStudio}
            </a>
          </Reveal>
        </>
      }
      peek={
        <Reveal delay={STAGGER * 3} className="rounded-lg border border-border bg-surface/70 p-4 shadow-sm">
          <div className="mb-3 flex items-center justify-between text-xs">
            <span className="flex items-center gap-1.5 font-semibold text-ink-secondary">
              <Database className="h-3.5 w-3.5 text-accent" />
              {c.hubLabel}
            </span>
            <span className="font-mono text-ink-faint">{n} Dok</span>
          </div>
          <ul className="flex flex-col gap-1.5">
            {shown.map((dok) => {
              const anchors = dok.anchorFiles ?? [];
              return (
                <li
                  key={dok.dok_id}
                  className="flex flex-col gap-0.5 rounded-md bg-surface px-2.5 py-1.5"
                >
                  <div className="flex items-center gap-2">
                    <FileText className="h-3.5 w-3.5 shrink-0 text-accent" />
                    <span className="shrink-0 font-mono text-[10px] text-ink-faint">
                      {dok.dok_id}
                    </span>
                    <span className="min-w-0 flex-1 truncate text-sm text-ink">{dok.name}</span>
                  </div>
                  {/* code_anchor provenance — "this Dok ← these files".
                   *  Hidden when the Hub predates anchor injection. */}
                  {anchors.length > 0 && (
                    <p
                      className="truncate pl-[1.375rem] font-mono text-[10px] text-ink-faint"
                      title={anchors.join('\n')}
                    >
                      ← {anchors[0]}
                      {anchors.length > 1 && ` +${anchors.length - 1}`}
                    </p>
                  )}
                </li>
              );
            })}
          </ul>
          {n > HUB_LIST_MAX && (
            <p className="mt-2 text-center text-xs text-ink-faint">{c.moreDoks(n - HUB_LIST_MAX)}</p>
          )}
        </Reveal>
      }
    />
  );
}
