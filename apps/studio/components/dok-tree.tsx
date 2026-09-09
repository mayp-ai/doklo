'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Dok } from '@doklo-beta/core';
import { dokDomain } from '../lib/dok-meta';
import {
  comparePriority,
  priorityLabels,
  tierRowTokens,
} from '../lib/dok-priority-order';
import { useStudio } from './studio-store';

const DOMAIN_ICONS: Record<string, string> = {
  AUTH: '🔐',
  PAY:  '💳',
  PROG: '🎯',
};

const STATUS_PIP: Record<Dok['status'], string> = {
  active:     'bg-status-active-fg',
  draft:      'bg-status-draft-fg',
  review:     'bg-status-review-fg',
  planned:    'bg-status-planned-fg',
  deprecated: 'bg-status-deprecated-fg',
  archived:   'bg-ink-faint',
};

/**
 * DokTree — 240px left rail for the editor route group. Replaces the
 * hub-views LayerRail because in the editor the user wants quick
 * navigation across Dok siblings inside the same domain rather than
 * across the 4 hub layers.
 *
 * Reads the workspace Doks from the studio store, groups them by id
 * prefix, and links each row to /doks/{id}.
 */
export function DokTree() {
  const pathname = usePathname() ?? '';
  const { doks } = useStudio();
  // Active dok id = last segment when pathname matches /doks/{id}.
  const activeId =
    pathname.startsWith('/doks/')
      ? pathname.split('/').filter(Boolean)[1] ?? null
      : null;

  // Group by id prefix, in priority order — the same rule the catalog uses, so
  // the two lists cannot disagree about what comes first. Deliberately NOT the
  // catalog's *filters*: this rail is how you reach a sibling, and hiding
  // siblings mid-navigation would strand the user.
  const grouped = new Map<string, Dok[]>();
  for (const d of [...doks].sort(comparePriority)) {
    const key = dokDomain(d.dok_id);
    const bucket = grouped.get(key) ?? [];
    bucket.push(d);
    grouped.set(key, bucket);
  }
  // Insertion order === priority order, so a domain sits where its highest
  // priority Dok put it.
  const ordered = Array.from(grouped.entries());

  return (
    <nav
      aria-label="Dok tree"
      className="flex min-h-full w-60 flex-col overflow-y-auto border-r border-border bg-surface py-3"
    >
      {ordered.map(([domain, doks]) => (
        <div key={domain} className="mb-1">
          <div className="flex items-center gap-2 px-4 pb-1.5 pt-3 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
            <span aria-hidden>{DOMAIN_ICONS[domain] ?? '◇'}</span>
            <span>{domain}</span>
            <span className="ml-auto font-mono text-[11px] text-ink-faint">
              {doks.length}
            </span>
          </div>
          <ul className="m-0 list-none p-0">
            {doks.map((d) => {
              const isActive = d.dok_id === activeId;
              const name = typeof d.name === 'string' ? d.name : `{${d.name.term_ref}}`;
              // Selection owns the left-edge bar; the tier marker yields to it.
              const tier = tierRowTokens(d);
              // The rail is 240px and already truncates names, so the axis
              // values ride in the tooltip rather than taking width.
              const labels = priorityLabels(d);
              return (
                <li key={d.dok_id} className="m-0 p-0">
                  <Link
                    href={`/doks/${d.dok_id}`}
                    aria-current={isActive ? 'page' : undefined}
                    title={
                      labels === null
                        ? `${d.dok_id} — priority not judged yet`
                        : `${d.dok_id} — ${labels.tier}: ${labels.impact} · ${labels.blast}`
                    }
                    className={[
                      'grid grid-cols-[8px_1fr_auto] items-center gap-2.5 px-4 py-1.5 text-[13px] no-underline',
                      'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent',
                      isActive
                        ? 'bg-accent-soft font-medium text-accent-ink shadow-[inset_3px_0_0_var(--color-accent)]'
                        : `text-ink-secondary hover:bg-surface-2 hover:text-ink ${tier.marker}`,
                    ].join(' ')}
                  >
                    <span
                      aria-label={`status ${d.status}`}
                      className={`h-1.5 w-1.5 rounded-full ${STATUS_PIP[d.status]}`}
                    />
                    <span className={`truncate ${isActive ? '' : tier.text}`}>{name}</span>
                    <span
                      className={[
                        'font-mono text-[10.5px] tracking-[0.02em]',
                        isActive ? 'text-accent-ink' : 'text-ink-faint',
                      ].join(' ')}
                    >
                      {d.dok_id}
                    </span>
                  </Link>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
    </nav>
  );
}
