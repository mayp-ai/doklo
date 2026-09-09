'use client';

import Link from 'next/link';
import type { ReactNode } from 'react';
import {
  BookOpen,
  CircleDot,
  Map,
  ScrollText,
  Users,
  type LucideIcon,
} from 'lucide-react';
import { useStudio } from './studio-store';

export type LayerId = 'doks' | 'lexicon' | 'ia' | 'roles';

// Rail highlight target — the Hub layers plus output pages that live in
// the (hub) shell without being layers themselves (PRODUCT.md sidebar
// hierarchy: outputs are a separate group, never crammed into Hub).
export type RailActive = LayerId | 'livedocs';

interface LayerEntry {
  id: LayerId;
  label: string;
  href: string;
  Icon: LucideIcon;
}

const LAYERS: LayerEntry[] = [
  { id: 'doks',    label: 'Doks',    href: '/doks',    Icon: CircleDot },
  { id: 'lexicon', label: 'Lexicon', href: '/lexicon', Icon: BookOpen },
  { id: 'ia',      label: 'IA',      href: '/ia',      Icon: Map },
  { id: 'roles',   label: 'Roles',   href: '/roles',   Icon: Users },
];

export function LayerRail({
  active,
  publicationCount,
}: {
  active: RailActive;
  publicationCount?: number;
}) {
  const { layerCounts } = useStudio();

  return (
    <nav
      aria-label="Hub sidebar"
      className="hub-layer-rail flex min-h-full w-60 flex-col gap-6 border-r border-border bg-surface py-4"
    >
      <Group label="Hub">
        {LAYERS.map(({ id, label, href, Icon }) => {
          const isActive = id === active;
          return (
            <li key={id} className="m-0 p-0">
              <Link
                href={href}
                aria-current={isActive ? 'page' : undefined}
                className={railItemClass(isActive)}
              >
                <Icon size={14} aria-hidden className="opacity-80" />
                <span>{label}</span>
                <span
                  className={[
                    'font-mono text-[11px]',
                    isActive ? 'text-accent-ink' : 'text-ink-faint',
                  ].join(' ')}
                >
                  {layerCounts[id]}
                </span>
              </Link>
            </li>
          );
        })}
      </Group>

      <Group label="Outputs">
        <li className="m-0 p-0">
          <Link
            href="/livedocs"
            aria-current={active === 'livedocs' ? 'page' : undefined}
            className={railItemClass(active === 'livedocs')}
          >
            <ScrollText size={14} aria-hidden className="opacity-80" />
            <span>Live Docs</span>
            <span
              className={[
                'font-mono text-[11px]',
                active === 'livedocs' ? 'text-accent-ink' : 'text-ink-faint',
              ].join(' ')}
            >
              {publicationCount ?? '—'}
            </span>
          </Link>
        </li>
      </Group>
    </nav>
  );
}

function Group({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="hub-layer-group">
      <div className="hub-layer-label mb-1.5 px-5 font-mono text-[10.5px] uppercase tracking-wide text-ink-muted">
        {label}
      </div>
      <ul className="hub-layer-list m-0 flex list-none flex-col gap-0.5 p-0 px-3">
        {children}
      </ul>
    </div>
  );
}

// Single source of truth for rail-item styling so all rail entries stay
// visually identical — only the active treatment differs.
function railItemClass(isActive: boolean): string {
  return [
    'grid w-full grid-cols-[18px_1fr_auto] items-center gap-2.5',
    'rounded-md border px-2.5 py-1.5 text-sm no-underline',
    'transition-colors',
    'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas',
    isActive
      ? 'border-accent bg-accent-soft font-medium text-accent-ink'
      : 'border-transparent text-ink-secondary hover:border-border hover:bg-surface-2 hover:text-ink',
  ].join(' ');
}
