'use client';

import Link from 'next/link';
import { usePathname } from 'next/navigation';
import type { Workspace } from '@doklo-beta/core';
import { useStudio } from './studio-store';
import { isStaleServerActionError } from '../lib/save-error';

interface Props {
  workspace: Workspace | null;
  reloadPage?: () => void;
}

// First URL segment → human breadcrumb. Both the new (hub) routes and the
// legacy routes pass through here so the header stays useful in both shells.
const CRUMBS: Record<string, { label: string; href: string }> = {
  doks: { label: 'Doks', href: '/doks' },
  dok: { label: 'Doks', href: '/doks' },
  lexicon: { label: 'Lexicon', href: '/lexicon' },
  ia: { label: 'IA', href: '/ia' },
  role: { label: 'Roles', href: '/roles' },
  roles: { label: 'Roles', href: '/roles' },
  spoke: { label: 'Live Docs', href: '/livedocs' },
  livedocs: { label: 'Live Docs', href: '/livedocs' },
};

function deriveCrumb(
  pathname: string | null,
): { label: string; href: string } | null {
  if (!pathname || pathname === '/') return null;
  const seg = pathname.split('/').filter(Boolean)[0];
  return seg ? CRUMBS[seg] ?? null : null;
}

export function AppHeader({
  workspace,
  reloadPage = () => window.location.reload(),
}: Props) {
  const pathname = usePathname();
  // Phase 8 — palette state moved to the studio store so KeyboardShortcuts
  // can drive ⌘K from anywhere, not just from this header's keydown listener.
  const { openPalette, saveStatus } = useStudio();
  const saveError = saveStatus.kind === 'error' ? saveStatus.message : null;
  const reloadRequired =
    saveStatus.kind === 'error' &&
    isStaleServerActionError(saveStatus.message);
  const statusText = formatSaveStatus(saveStatus);

  const wsName = workspace?.name ?? 'Doklo Studio';
  const crumb = deriveCrumb(pathname);

  return (
    <header className="app-header flex h-14 items-center gap-4 border-b border-border bg-surface px-5">
      <div
        aria-hidden
        className="grid h-7 w-7 place-items-center rounded-md bg-gradient-to-br from-accent to-accent-hover text-[13px] font-bold tracking-tight text-canvas"
      >
        D
      </div>
      <span className="app-header-workspace text-sm font-semibold text-ink">{wsName}</span>
      {crumb && (
        <span className="app-header-crumb flex items-center gap-1.5 text-[13px] text-ink-muted">
          <span className="opacity-50">/</span>
          <span>Hub</span>
          <span className="opacity-50">/</span>
          <Link
            href={crumb.href}
            className="rounded-sm font-medium text-ink hover:text-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-surface"
          >
            {crumb.label}
          </Link>
        </span>
      )}
      {/* Save status is fed by the durable save coordinator. Always mounted
          (empty when idle) so the
          aria-live region exists before announcements fire. */}
      <div className="app-header-status ml-auto flex min-w-0 items-center gap-2">
        <span
          role="status"
          aria-live="polite"
          title={saveError ?? undefined}
          className={[
            'max-w-[420px] truncate font-mono text-[11px]',
            saveStatus.kind === 'error' || saveStatus.kind === 'conflict'
              ? 'text-status-deprecated-fg'
              : saveStatus.kind === 'saved'
                ? 'text-status-active-fg'
                : 'text-ink-muted',
          ].join(' ')}
        >
          {statusText}
        </span>
        {(saveStatus.kind === 'error' || saveStatus.kind === 'conflict') && (
          <button
            type="button"
            onClick={() => {
              if (reloadRequired) reloadPage();
              else void saveStatus.retry();
            }}
            className="shrink-0 rounded border border-status-deprecated-fg px-2 py-1 text-[11px] font-medium text-status-deprecated-fg hover:bg-status-deprecated-bg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {reloadRequired ? 'Reload' : 'Retry'}
          </button>
        )}
      </div>
      <button
        type="button"
        onClick={() => openPalette()}
        aria-label="Open search"
        data-command-palette-trigger
        className="flex h-8 w-[280px] items-center gap-2 rounded-md border border-border bg-canvas px-3 text-[13px] text-ink-faint hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
      >
        <span aria-hidden className="opacity-70">⌕</span>
        <span className="app-header-search-label">Search Dok · Term · Route · Role</span>
        <span className="app-header-search-key ml-auto rounded-[3px] border border-border bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-ink-muted">
          ⌘K
        </span>
      </button>
      <div
        aria-label="User menu"
        role="img"
        className="h-7 w-7 rounded-full bg-surface-3"
      />
    </header>
  );
}

function formatSaveStatus(status: ReturnType<typeof useStudio>['saveStatus']): string {
  if (
    status.kind === 'error' &&
    isStaleServerActionError(status.message)
  ) {
    return 'Studio restarted before this change could be saved · Reload required';
  }
  switch (status.kind) {
    case 'idle':
      return '';
    case 'dirty':
      return `Unsaved · ${status.path}`;
    case 'saving':
      return `Saving · ${status.path}`;
    case 'saved':
      return `Saved · ${status.path}`;
    case 'error':
      return `Save failed · ${status.path}: ${status.message}`;
    case 'conflict':
      return `File changed outside Studio · ${status.path}`;
  }
}
