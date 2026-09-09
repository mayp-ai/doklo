'use client';

import Link from 'next/link';
import { ArrowRight, Database, FileText, RefreshCw, ScanSearch, Sparkles } from 'lucide-react';
import { WIZARD_COPY } from '../../lib/wizard-copy';
import { useOnboarding } from './onboarding-store';
import { Reveal, STAGGER } from './reveal';
import { SplitBody } from './wizard-frame';

const FLOW_ICONS = [ScanSearch, FileText, Sparkles];

export function StepWelcome({ workspaceName }: { workspaceName: string }) {
  const { goTo, locale, workspace } = useOnboarding();
  const c = WIZARD_COPY[locale].welcome;
  const existing = workspace.existingDoks;
  const hasDocs = existing > 0;
  const generation = workspace.generation;
  const failed = generation.summary?.failed ?? 0;
  const needsRecovery = generation.status === 'partial' || generation.status === 'failed';
  const hasNoCandidates = generation.status === 'no-candidates';
  const generationComplete = generation.status === 'complete';
  const scan = workspace.services[0]?.scan;
  const ws = <span className="font-semibold text-ink">{workspaceName}</span>;
  const secondaryAction = generationComplete
    ? (locale === 'en' ? 'Check for code changes' : '코드 변경 확인')
    : hasNoCandidates
      ? c.reviewScan
      : needsRecovery
        ? (locale === 'en' ? 'Resume remaining work' : '남은 작업 재개')
        : c.generateRemaining;
  const scanSummary = scan?.status === 'ready' && scan.counts
    ? locale === 'en'
      ? `${scan.counts.routes} routes · ${scan.counts.components} components · ${scan.counts.stores} ${scan.counts.stores === 1 ? 'store' : 'stores'}`
      : `라우트 ${scan.counts.routes}개 · 컴포넌트 ${scan.counts.components}개 · 스토어 ${scan.counts.stores}개`
    : c.scanAutomatic(
      scan?.status === 'invalid' || scan?.status === 'unreadable' ? scan.status : 'missing',
    );

  return (
    <SplitBody
      narrative={
        <>
          <Reveal delay={0}>
            <span className="inline-flex items-center gap-2 rounded-pill bg-accent-soft px-3 py-1 text-xs font-semibold tracking-wide text-accent-ink">
              <span className="h-1.5 w-1.5 rounded-pill bg-accent" />
              {c.eyebrow}
            </span>
          </Reveal>
          <Reveal delay={STAGGER} as="h1" className="whitespace-nowrap text-2xl font-bold leading-tight tracking-tight text-ink-strong">
            {c.hi}
          </Reveal>
          <Reveal delay={STAGGER * 2} as="p" className="text-base leading-relaxed text-ink-muted">
            {generationComplete && hasDocs ? (
              locale === 'en' ? (
                <>
                  {ws} already has <span className="font-semibold text-ink">{existing} Doks</span>;
                  {' '}its last generation completed. Open Dok Studio, or check for code changes.
                </>
              ) : (
                <>
                  {ws}에는 이미 <span className="font-semibold text-ink">{existing}개의 Dok</span>이 있고
                  마지막 생성도 완료됐어요. Dok Studio를 열거나 코드 변경을 확인할 수 있어요.
                </>
              )
            ) : hasNoCandidates ? (
              <>{ws} — {c.noCandidates}</>
            ) : needsRecovery ? (
              locale === 'en' ? (
                <>
                  {hasDocs ? <>{ws} already has <span className="font-semibold text-ink">{existing} Doks</span>;</> : <>{ws} has no Doks yet;</>}
                  {' '}its last generation stopped with {failed} failed {failed === 1 ? 'item' : 'items'}.
                  {' '}Persisted work is preserved, so you can resume the remaining work.
                </>
              ) : (
                <>
                  {hasDocs ? <>{ws}에는 <span className="font-semibold text-ink">{existing}개의 Dok</span>이 있고</> : <>{ws}에는 아직 Dok이 없고</>}
                  {' '}마지막 생성에서 {failed}개 항목이 실패했어요. 저장된 작업은 보존되어 있으므로 남은 작업을 재개할 수 있어요.
                </>
              )
            ) : hasDocs ? (
              locale === 'en' ? (
                <>
                  {ws} already has{' '}
                  <span className="font-semibold text-ink">{existing} Doks</span>. Jump straight to Dok
                  Studio, or generate the remaining work.
                </>
              ) : (
                <>
                  {ws}에는 이미{' '}
                  <span className="font-semibold text-ink">{existing}개의 Dok</span>이 있어요. 바로 Dok
                  Studio로 가거나, 남은 작업을 생성할 수 있어요.
                </>
              )
            ) : locale === 'en' ? (
              <>
                We&apos;ll turn {ws}&apos;s code into docs that humans read and AI can query. It only
                takes a moment.
              </>
            ) : (
              <>
                {ws}의 코드를 사람도 읽고 AI도 query하는 문서로 정리할게요. 잠깐이면 됩니다.
              </>
            )}
          </Reveal>

          <Reveal delay={STAGGER * 3}>
            {hasDocs ? (
              <div className="flex items-center gap-2">
                <Link
                  href="/doks"
                  className="group inline-flex items-center gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-canvas no-underline shadow-md transition-all duration-200 hover:bg-accent-hover hover:no-underline hover:shadow-lg"
                >
                  {c.resume}
                  <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
                </Link>
                <button
                  type="button"
                  onClick={() => goTo('extract')}
                  className="inline-flex items-center gap-1.5 rounded-md border border-border px-4 py-3 text-sm font-medium text-ink-secondary transition-colors hover:bg-surface-2"
                >
                  <RefreshCw className="h-3.5 w-3.5" />
                  {secondaryAction}
                </button>
              </div>
            ) : (
              <button
                type="button"
                onClick={() => goTo('extract')}
                className="group inline-flex items-center gap-2 rounded-md bg-accent px-6 py-3 text-base font-semibold text-canvas shadow-md transition-all duration-200 hover:bg-accent-hover hover:shadow-lg active:bg-accent-active"
              >
                {secondaryAction === c.generateRemaining ? c.start : secondaryAction}
                <ArrowRight className="h-4 w-4 transition-transform duration-200 group-hover:translate-x-0.5" />
              </button>
            )}
          </Reveal>
        </>
      }
      peek={
        <div className="flex flex-col gap-2.5">
          {hasDocs ? (
            <div className="flex items-center gap-3 rounded-lg border border-border bg-surface/70 p-4 shadow-sm">
              <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                <Database className="h-5 w-5" />
              </div>
              <div>
                <p className="text-sm font-semibold text-ink-strong">{c.existingHub}</p>
                <p className="text-sm text-ink-muted">{c.doksHeld(existing)}</p>
              </div>
            </div>
          ) : (
            <ol className="flex flex-col gap-2.5">
              {FLOW_ICONS.map((Icon, i) => (
                <Reveal
                  key={i}
                  delay={STAGGER * (3 + i)}
                  as="li"
                  className="flex items-center gap-3 rounded-lg border border-border bg-surface/70 px-4 py-3 shadow-sm"
                >
                  <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-accent-soft text-accent">
                    <Icon className="h-4 w-4" />
                  </div>
                  <span className="text-sm font-medium text-ink">
                    <span className="mr-1.5 text-xs text-ink-faint">{i + 1}</span>
                    {c.flow[i]}
                  </span>
                </Reveal>
              ))}
            </ol>
          )}
          <div className="rounded-lg border border-border bg-surface/70 p-3 text-xs leading-relaxed text-ink-muted shadow-sm">
            <p className="truncate font-mono text-ink-secondary" title={workspace.workspacePath}>{workspace.workspacePath}</p>
            <p className="mt-1">{scanSummary}</p>
          </div>
        </div>
      }
    />
  );
}
