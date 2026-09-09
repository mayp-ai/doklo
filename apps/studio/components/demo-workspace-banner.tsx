// Persistent, non-dismissible label for a workspace Studio cannot present as
// the viewer's own analysis.
//
// Two things it must never do: let bundled sample data pass for a real
// result, and assert "this is sample data" over a real Hub just because the
// marker could not be read. So the `demo` copy states a fact and the
// `unverified` copy states an uncertainty, naming the path and errno that
// produced it.
//
// Overlay, not layout: the Hub shell is a full-height grid, so the label is
// fixed and the frame is pointer-events-none. Nothing below it shifts.

import type { DemoWorkspaceState } from '../lib/demo-workspace';

export function DemoWorkspaceBanner({ state }: { state: DemoWorkspaceState }) {
  const unverified = state.status === 'unverified';
  return (
    <>
      <div
        aria-hidden="true"
        className={`demo-workspace-frame pointer-events-none fixed inset-0 z-40 ${
          unverified ? 'demo-workspace-frame-unverified' : ''
        }`}
      />
      <div
        role="status"
        className="pointer-events-none fixed bottom-4 left-1/2 z-50 w-[min(46rem,calc(100vw-2rem))] -translate-x-1/2"
      >
        <p
          className={`rounded-pill border px-4 py-2 text-center text-xs font-medium leading-relaxed text-ink-strong shadow-md ${
            unverified ? 'border-info bg-info-bg' : 'border-warning bg-warning-bg'
          }`}
        >
          {unverified ? (
            <>
              <span className="font-bold uppercase tracking-wide">Unverified workspace</span>
              {' — '}
              Doklo Studio could not check whether this is its bundled sample data:
              {' '}
              reading <code className="font-mono">{state.markerPath}</code> failed with{' '}
              <code className="font-mono">{state.reason ?? 'unknown'}</code>.
              {' '}
              Until that path is readable, treat what is shown as unconfirmed.
            </>
          ) : (
            <>
              <span className="font-bold uppercase tracking-wide">Demo data</span>
              {' — '}
              this sample workspace ships with Doklo Studio and was not generated from your code.
              {' '}
              Run <code className="font-mono">doklo init</code> and{' '}
              <code className="font-mono">doklo generate</code> in your project to see your own
              analysis.
            </>
          )}
        </p>
      </div>
    </>
  );
}
