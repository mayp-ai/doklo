'use client';

import { useEffect, useState, type ReactNode } from 'react';
import Link from 'next/link';
import type { Dok, Workspace } from '@doklo-beta/core';
import { projectDokDetail, type DetailRule, type DokDetailProjection } from '../lib/dok-detail-view';
import { readDokViewPreference, writeDokViewPreference } from '../lib/dok-view-preferences';
import { priorityLabels, TIER_CHIP } from '../lib/dok-priority-order';
import { githubSourceUrl, type SourceRepository } from '../lib/source-repository-shared';

const RULE_LABEL: Record<string, string> = {
  restriction: 'Restriction', policy: 'Policy', validation: 'Validation', calculation: 'Calculation', permission: 'Permission',
};

// Same type → tone pairing as the editor's BR_TONE, so a rule keeps its colour
// between the read view and the edit view.
const RULE_TONE: Record<string, string> = {
  validation: 'bg-status-review-bg text-status-review-fg',
  restriction: 'bg-status-deprecated-bg text-status-deprecated-fg',
  policy: 'bg-status-active-bg text-status-active-fg',
  calculation: 'bg-status-draft-bg text-status-draft-fg',
  permission: 'bg-accent-soft text-accent-ink',
};

function Icon({ kind, className = 'h-4 w-4' }: { kind: string; className?: string }) {
  const common = { className, viewBox: '0 0 24 24', fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, 'aria-hidden': true };
  if (kind === 'flow') return <svg {...common}><circle cx="5" cy="5" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><path d="M7 5h5a3 3 0 0 1 3 3v1a3 3 0 0 0 3 3M17 12h-5a3 3 0 0 0-3 3v1a3 3 0 0 1-3 3"/></svg>;
  if (kind === 'criterion') return <svg {...common}><rect x="4" y="3" width="16" height="18" rx="2"/><circle cx="8" cy="8" r="1"/><circle cx="8" cy="13" r="1"/><path d="M12 8h4M12 13h4"/></svg>;
  if (kind === 'restriction') return <svg {...common}><circle cx="12" cy="12" r="9"/><path d="m6 6 12 12"/></svg>;
  if (kind === 'permission') return <svg {...common}><path d="m12 2 8 4v6c0 5-8 9-8 9s-8-4-8-9V6zM9 12l2 2 4-4"/></svg>;
  if (kind === 'validation') return <svg {...common}><path d="M4 5h16M4 12h16M4 19h16M8 3v4M16 10v4M10 17v4"/></svg>;
  if (kind === 'calculation') return <svg {...common}><rect x="4" y="3" width="16" height="18" rx="2"/><path d="M8 7h8M8 12h2M14 12h2M8 16h2M14 16h2"/></svg>;
  if (kind === 'policy') return <svg {...common}><path d="M6 3h12v18H6zM9 7h6M9 11h6M9 15h4"/></svg>;
  if (kind === 'system') return <svg {...common}><rect x="3" y="5" width="18" height="14" rx="3"/><path d="M8 9h.01M16 9h.01M8 15h8M12 2v3"/></svg>;
  if (kind === 'external') return <svg {...common}><path d="M14 3h7v7M21 3l-11 11M10 3H4v17h17v-6"/></svg>;
  return <svg {...common}><path d="M7 3h10v18H4V3h3M8 7h6M8 11h6M8 15h4"/></svg>;
}

function Head({ id, icon, title, count, children }: { id: string; icon: string; title: string; count: number; children?: ReactNode }) {
  return <div className="mb-4 flex flex-wrap items-center gap-2">
    <span className="grid h-8 w-8 place-items-center rounded-md border border-border bg-surface text-accent"><Icon kind={icon}/></span>
    <h2 id={id} tabIndex={-1} className="text-[19px] font-semibold text-ink-strong">{title}</h2>
    <span className="font-mono text-xs text-ink-faint">{count}</span>{children}
  </div>;
}

function relationIcon(rule: DetailRule | undefined): string { return rule?.type ?? 'rule'; }

function RelationLink({ id, icon }: { id: string; icon: string }) {
  const match = /^(BR|AC)-.*?-(\d+)$/.exec(id);
  const label = match ? `${match[1] === 'BR' ? 'Rule' : 'Criterion'} ${match[2]}` : id;
  return <a href={`#${id}`} title={id} className="inline-flex items-center gap-1 rounded border border-border bg-surface px-2 py-0.5 font-mono text-[10.5px] text-accent hover:border-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"><Icon kind={icon} className="h-3 w-3"/>{label}</a>;
}

function Flow({ detail, sourceRepository }: { detail: DokDetailProjection; sourceRepository: SourceRepository | null }) {
  const [showSystem, setShowSystem] = useState(false);
  const [showEvidence, setShowEvidence] = useState(false);
  useEffect(() => {
    const storage = safeStorage();
    if (storage === null) return;
    setShowSystem(readDokViewPreference(storage, 'system'));
    setShowEvidence(readDokViewPreference(storage, 'evidence'));
  }, []);
  const changeSystem = (checked: boolean) => { setShowSystem(checked); const storage = safeStorage(); if (storage) writeDokViewPreference(storage, 'system', checked); };
  const changeEvidence = (checked: boolean) => { setShowEvidence(checked); const storage = safeStorage(); if (storage) writeDokViewPreference(storage, 'evidence', checked); };
  const visibleCount = detail.steps.filter((step) => step.actorKind !== 'system').length;
  const visibleSteps = detail.steps.filter((step) => step.actorKind !== 'system' || showSystem);
  let userIndex = 0;
  return <section className="mt-8" aria-labelledby="flow-title" data-testid="dok-detail-flow">
    <Head id="flow-title" icon="flow" title="User flow" count={visibleCount}>
      <div className="ml-auto flex flex-wrap gap-x-4 gap-y-1 text-xs text-ink-muted">
        <label className="flex min-h-8 cursor-pointer items-center gap-2"><input className="h-3.5 w-3.5 accent-accent" type="checkbox" checked={showSystem} onChange={(event) => changeSystem(event.target.checked)}/>Show system processes</label>
        <label className={`flex min-h-8 items-center gap-2 ${showSystem ? 'cursor-pointer' : 'text-ink-faint'}`} title={showSystem ? 'Show files and lines linked to each step' : 'Show system processes first'}><input className="h-3.5 w-3.5 accent-accent" type="checkbox" checked={showEvidence} disabled={!showSystem} onChange={(event) => changeEvidence(event.target.checked)}/>Show process evidence</label>
      </div>
    </Head>
    <p className="mb-4 text-xs text-ink-muted">Actions remain primary. System responses and evidence can be revealed when needed.</p>
    <ol className="m-0 list-none p-0">{visibleSteps.map((step, index) => {
      const isLast = index === visibleSteps.length - 1;
      // One continuous rail: every cell in the 28px column draws its own
      // segment, so the line never depends on how tall a step's text wraps.
      const rail = !isLast && <span className="absolute inset-y-0 left-3.5 w-px bg-border-strong"/>;
      const response = <><span className="inline-flex items-center gap-1.5 font-mono text-[10px] uppercase tracking-[0.08em] text-accent"><Icon kind="system" className="h-3 w-3"/>{step.actorKind === 'system' ? 'System outcome' : 'System response'}</span><p className="mt-1 text-sm leading-relaxed text-ink-secondary">{step.outcome}</p>{showEvidence && <div className="mt-3 border-t border-border pt-3 text-xs text-ink-muted"><b className="font-semibold text-ink-secondary">Process evidence</b>{step.evidence.length === 0 ? <p className="mt-1">No code evidence is linked to this step.</p> : <ul className="mt-2 space-y-1.5">{step.evidence.map((item, itemIndex) => { const href = sourceRepository && item.file ? githubSourceUrl(sourceRepository, item.file, item.startLine, item.endLine) : null; const fileName = item.file?.split('/').at(-1); const label = <>{item.label && <span className="text-accent">{item.label}</span>}{item.label && fileName ? ' · ' : ''}{fileName}{item.startLine ? `:${item.startLine}${item.endLine !== item.startLine ? `–${item.endLine}` : ''}` : ''}</>; return <li key={`${item.file ?? 'metadata'}-${itemIndex}`} title={item.file ?? undefined}>{href ? <a href={href} target="_blank" rel="noreferrer" className="underline underline-offset-2">{label}</a> : label}</li>; })}</ul>}<a className="mt-2 inline-block text-accent underline underline-offset-2 xl:hidden" href="#source-files">View whole-Dok source files</a><a className="mt-2 hidden text-accent underline underline-offset-2 xl:inline-block" href="#source-files-context">View whole-Dok source files</a></div>}</>;
      const heading = <>
        <div className="mb-1 flex flex-wrap items-center gap-2"><span className="rounded-full bg-accent-soft px-2 py-0.5 font-mono text-[10.5px] text-accent-ink">{step.actor}</span>{step.actorKind === 'system' && <span className="font-mono text-[10px] uppercase tracking-[0.08em] text-ink-faint">automatic step</span>}</div>
        <p className="text-sm font-semibold leading-relaxed text-ink-strong">{step.intent}</p>
      </>;
      const footnotes = <>
        {step.preconditions.length > 0 && <p className="mt-2 text-xs text-status-draft-fg">Starts when · {step.preconditions.join(' · ')}</p>}
        {step.variants.length > 0 && <div className="mt-2 flex flex-wrap gap-1.5">{step.variants.map((variant) => <span key={variant} className="rounded-full border border-border px-2 py-0.5 font-mono text-[10.5px] text-ink-faint">{variant}</span>)}</div>}
      </>;
      if (step.actorKind === 'system') {
        return <li key={`${step.order}-${index}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3" data-testid="flow-step">
          <div className="relative" aria-hidden>{rail}<span className="absolute left-3.5 top-0 h-7 w-[26px] rounded-bl-md border-b border-l border-border-strong" data-testid="flow-branch"/></div>
          <div className="min-w-0 pb-7"><div className="flex items-start gap-3 rounded-md border border-border bg-accent-soft px-4 py-3">
            <span className="grid h-7 w-7 flex-none place-items-center rounded-md bg-accent-soft-strong text-accent"><Icon kind="system"/></span>
            <div className="min-w-0 flex-1">{heading}<div className="mt-3 rounded-md border border-border bg-canvas px-3 py-2.5">{response}</div>{footnotes}</div>
          </div></div>
        </li>;
      }
      const displayNumber = ++userIndex;
      return <li key={`${step.order}-${index}`} className="grid grid-cols-[28px_minmax(0,1fr)] gap-x-3" data-testid="flow-step">
        <div className="relative">
          <span className="relative z-10 grid h-7 w-7 place-items-center rounded-full border border-border-strong bg-surface-2 font-mono text-xs font-semibold text-ink-secondary">{String(displayNumber).padStart(2, '0')}</span>
          {(showSystem || !isLast) && <span aria-hidden className="absolute bottom-0 left-3.5 top-7 w-px bg-border-strong" data-testid="flow-rail"/>}
        </div>
        <div className="min-w-0 pb-3">{heading}</div>
        {showSystem && <>
          <div className="relative" aria-hidden>{rail}<span className="absolute left-3.5 top-0 h-7 w-[42px] rounded-bl-md border-b border-l border-border-strong" data-testid="flow-branch"/></div>
          <div className="ml-4 min-w-0 rounded-md border border-border bg-accent-soft px-3 py-2.5">{response}</div>
        </>}
        <div className="relative" aria-hidden>{rail}</div>
        <div className="min-w-0 pb-7">{footnotes}</div>
      </li>;
    })}</ol>
  </section>;
}

function safeStorage(): Storage | null {
  try { return window.localStorage; } catch { return null; }
}

export function DokDetailView({ dok, workspace, sourceRepository }: { dok: Dok; workspace: Workspace; sourceRepository: SourceRepository | null }) {
  const detail = projectDokDetail(dok, workspace);
  const priority = priorityLabels(dok);
  const ruleMap = new Map(detail.rules.map((rule) => [rule.id, rule]));
  return <article className="mx-auto w-full max-w-[820px] px-5 pb-20 pt-8 sm:px-8 lg:px-12" data-testid="dok-detail-view">
    <header>
      <div className="mb-3 flex flex-wrap items-center gap-2"><span className="rounded bg-accent-soft px-2.5 py-1 font-mono text-[11px] font-medium text-accent-ink">{dok.dok_id}</span><span className="font-mono text-[10.5px] uppercase tracking-[0.08em] text-ink-muted">{dok.status}</span>{priority && <span className={`rounded px-2 py-0.5 font-mono text-[10.5px] ${TIER_CHIP[priority.tier]}`}>{priority.tier}</span>}<Link href={`/doks/${dok.dok_id}?edit=1`} className="ml-auto rounded-md border border-border bg-surface px-3 py-1.5 text-xs font-semibold text-ink-secondary hover:border-accent hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent">Edit Dok</Link></div>
      <h1 className="text-[28px] font-bold tracking-[-0.02em] text-ink-strong">{detail.name}</h1>
      <p className="mt-2 max-w-[70ch] text-base leading-[1.7] text-ink-secondary">{detail.description}</p>
      <nav className="mt-6 flex flex-wrap gap-x-5 gap-y-2 border-y border-border py-3 text-xs text-accent" aria-label="Dok sections"><a className="inline-flex items-center gap-1.5" href="#flow-title"><Icon kind="flow"/>User flow <span className="text-ink-faint">{detail.steps.filter((step) => step.actorKind !== 'system').length}</span></a><a className="inline-flex items-center gap-1.5" href="#rules-title"><Icon kind="rule"/>Business rules <span className="text-ink-faint">{detail.rules.length}</span></a><a className="inline-flex items-center gap-1.5" href="#criteria-title"><Icon kind="criterion"/>Acceptance criteria <span className="text-ink-faint">{detail.criteria.length}</span></a></nav>
    </header>
    <Flow detail={detail} sourceRepository={sourceRepository}/>
    <section className="mt-10" aria-labelledby="rules-title" data-testid="dok-detail-rules"><Head id="rules-title" icon="rule" title="Business rules" count={detail.rules.length}/><p className="mb-4 text-xs text-ink-muted">Policies and constraints the product must keep.</p><ul className="m-0 list-none space-y-3 p-0">{detail.rules.map((rule, index) => <li id={rule.id} tabIndex={-1} key={rule.id} className="rounded-md border border-border bg-canvas px-4 py-4 focus:outline-none focus:ring-2 focus:ring-accent"><div className="mb-2 flex items-center gap-2"><span className="font-mono text-xs font-semibold text-ink-secondary">{String(index + 1).padStart(2, '0')}</span><span className={`inline-flex items-center gap-1 rounded px-2 py-0.5 text-[11px] font-semibold ${RULE_TONE[rule.type] ?? 'bg-surface-2 text-ink-secondary'}`} data-testid="rule-type"><Icon kind={rule.type} className="h-3 w-3"/>{RULE_LABEL[rule.type]}</span><span className="ml-auto font-mono text-[9px] text-ink-faint">{rule.id}</span></div><p className="max-w-[75ch] text-[15px] leading-[1.8] text-ink">{rule.description}</p>{(rule.appliesToRoles.length > 0 || rule.evidence) && <details className="mt-2 text-xs"><summary className="cursor-pointer text-accent">Rule scope and code anchor</summary><div className="mt-2 space-y-1 text-ink-muted">{rule.appliesToRoles.length > 0 && <p>Roles · {rule.appliesToRoles.join(', ')}</p>}{rule.evidence && <p title={rule.evidence.file ?? undefined}>Code · {[rule.evidence.label, rule.evidence.file].filter(Boolean).join(' · ')}</p>}</div></details>}<div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3 text-xs text-ink-muted"><span>Linked criteria <b>{rule.relatedCriteria.length}</b></span>{rule.relatedCriteria.map((id) => <RelationLink key={id} id={id} icon="criterion"/>)}</div>{rule.relatedCriteria.length > 0 && <details className="mt-2 text-xs"><summary className="cursor-pointer text-accent">Read linked criteria here</summary><ul className="mt-2 space-y-2">{rule.relatedCriteria.map((id) => <li key={id}><span className="mr-2 font-mono text-accent">{id}</span>{detail.criteria.find((criterion) => criterion.id === id)?.statement}</li>)}</ul></details>}</li>)}</ul></section>
    <section className="mt-10" aria-labelledby="criteria-title" data-testid="dok-detail-criteria"><Head id="criteria-title" icon="criterion" title="Acceptance criteria" count={detail.criteria.length}/><p className="mb-4 text-xs text-ink-muted">Expected outcomes. These entries do not claim a test was run or passed.</p><ol className="m-0 list-none space-y-3 p-0">{detail.criteria.map((criterion, index) => <li id={criterion.id} tabIndex={-1} key={criterion.id} className="rounded-md border border-border bg-canvas px-4 py-4 focus:outline-none focus:ring-2 focus:ring-accent"><div className="mb-2 flex items-center gap-2"><span className="font-mono text-xs font-semibold text-ink-secondary">{String(index + 1).padStart(2, '0')}</span><span className="inline-flex items-center gap-1 text-xs text-ink-muted"><Icon kind="criterion" className="h-3 w-3"/>Criterion</span><span className="ml-auto font-mono text-[9px] text-ink-faint">{criterion.id}</span></div><p className="max-w-[75ch] text-[15px] leading-[1.8] text-ink">{criterion.statement}</p><div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3 text-xs text-ink-muted"><span>Linked rules <b>{criterion.relatedRules.length}</b></span>{criterion.relatedRules.map((id) => <RelationLink key={id} id={id} icon={relationIcon(ruleMap.get(id))}/>)}</div>{(criterion.given || criterion.when || criterion.then) && <details className="mt-2 text-xs"><summary className="cursor-pointer text-accent">Given · When · Then</summary><dl className="mt-2 grid grid-cols-[52px_1fr] gap-y-2">{criterion.given && <><dt className="font-mono text-ink-faint">Given</dt><dd>{criterion.given}</dd></>}{criterion.when && <><dt className="font-mono text-ink-faint">When</dt><dd>{criterion.when}</dd></>}{criterion.then && <><dt className="font-mono text-ink-faint">Then</dt><dd>{criterion.then}</dd></>}</dl></details>}</li>)}</ol></section>
    <section id="source-files" className="mt-10 scroll-mt-4 xl:hidden" aria-labelledby="sources-title" data-testid="dok-detail-sources"><Head id="sources-title" icon="external" title="Source files" count={detail.anchors.length}/><SourceFiles anchors={detail.anchors} sourceRepository={sourceRepository}/></section>
  </article>;
}

function SourceFiles({ anchors, sourceRepository }: { anchors: DokDetailProjection['anchors']; sourceRepository: SourceRepository | null }) {
  return <>{anchors.length === 0 ? <p className="rounded-md border border-dashed border-border px-4 py-3 text-sm text-ink-muted">No whole-Dok source files are recorded.</p> : <ul className="m-0 list-none space-y-2 p-0">{anchors.map((anchor) => { const href = sourceRepository && githubSourceUrl(sourceRepository, anchor.file, anchor.startLine, anchor.endLine); const name = anchor.file.split('/').at(-1); return <li key={anchor.file} className="flex items-center gap-2 rounded-md border border-border bg-surface px-3 py-2 font-mono text-xs text-ink-secondary"><span className="text-status-active-fg">●</span>{href ? <a href={href} target="_blank" rel="noreferrer" className="min-w-0 truncate text-accent underline underline-offset-2" title={anchor.file}>{name}</a> : <span className="min-w-0 truncate" title={anchor.file}>{name}</span>}</li>; })}</ul>}<p className="mt-2 text-xs leading-relaxed text-ink-faint">{sourceRepository ? <>Current checkout · <span className="font-mono">{sourceRepository.commit.slice(0, 7)}</span></> : 'No GitHub repository is connected. File links are unavailable.'}</p></>;
}

export function DokDetailSourceSidebar({ dok, workspace, sourceRepository }: { dok: Dok; workspace: Workspace; sourceRepository: SourceRepository | null }) {
  const anchors = projectDokDetail(dok, workspace).anchors;
  return <aside id="source-files-context" tabIndex={-1} className="h-full w-[320px] overflow-y-auto border-l border-border bg-surface px-5 py-7 focus:outline-none focus:ring-2 focus:ring-accent" aria-label="Dok source files" data-testid="dok-detail-source-sidebar">
    <div className="mb-4 flex items-center gap-2 text-ink-strong"><Icon kind="external"/><h2 className="text-sm font-semibold">Source files</h2><span className="font-mono text-xs text-ink-faint">{anchors.length}</span></div>
    <p className="mb-4 text-xs leading-relaxed text-ink-muted">Whole-Dok evidence recorded by the pipeline.</p>
    <SourceFiles anchors={anchors} sourceRepository={sourceRepository}/>
  </aside>;
}
