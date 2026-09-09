'use client';

import { useEffect } from 'react';
import Link from 'next/link';
import { useParams, useSearchParams } from 'next/navigation';
import { useStudio, type FocusedField } from '../../../../components/studio-store';
import { RoleEditor } from '../../../../components/role-editor';
import { SmartSidebar } from '../../../../components/smart-sidebar';
import { RoleEditSidebar } from '../../../../components/smart-sidebar-content/role-edit-sidebar';
import { focusKey } from '../../../../lib/hooks/use-focus-context';
import { LoadRecovery } from '../../../../components/load-recovery';

/**
 * /roles/[id] — the canonical Role deep-edit URL. Mirrors doks/[id] and
 * lexicon/[id]: resolve the target Role from the workspace catalog in the
 * store (no synthetic fallback), seed editingRole on mount, clear on unmount. An id
 * with no match renders a not-found state rather than fabricated data.
 *
 * Supports a `?focus=<key>` deep-link (e.g. ?focus=extends, ?focus=scope).
 */
export default function RoleEditorPage() {
  const params = useParams<{ id: string }>();
  const search = useSearchParams();
  const id = params?.id;
  const { roles, rolesState, editingRole, setEditingRole, setFocusedField, focusedField } =
    useStudio();

  // Resolve straight from the store so "not found" is decided
  // synchronously — no fixture fallback.
  const target = id ? roles.find((r) => r.role_id === id) ?? null : null;

  useEffect(() => {
    setEditingRole(target);
    setFocusedField(parseFocusParam(search?.get('focus') ?? null));
    return () => {
      setEditingRole(null);
      setFocusedField(null);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target, setEditingRole, setFocusedField]);

  if (rolesState.kind === 'invalid' || rolesState.kind === 'unreadable') {
    return <LoadRecovery layer="roles" state={rolesState} />;
  }

  if (rolesState.kind === 'missing' || rolesState.kind === 'empty') {
    return (
      <section className="flex h-full items-center justify-center p-8 text-center text-ink-muted">
        <div>
          <h1 className="text-sm font-medium text-ink">No Roles are available.</h1>
          <code className="mt-2 block text-xs">{rolesState.path}</code>
          <p className="mt-2 text-xs">Run <code>doklo generate</code> to extract them from code.</p>
        </div>
      </section>
    );
  }

  if (!target) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center text-ink-muted">
        <p className="text-sm">
          Not found: <code className="font-mono text-ink-secondary">{id}</code>
        </p>
        <Link
          href="/roles"
          className="rounded text-[13px] text-accent hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
        >
          Back to Roles
        </Link>
      </div>
    );
  }

  if (!editingRole) {
    // target exists but the mount effect hasn't synced the store yet
    // (one frame) — brief by construction.
    return (
      <div className="flex h-full items-center justify-center text-sm text-ink-muted">
        Loading Role…
      </div>
    );
  }

  return (
    <div className="flex h-full">
      <main className="min-w-0 flex-1 overflow-y-auto">
        <RoleEditor />
      </main>
      <SmartSidebar transitionKey={focusKey(focusedField)}>
        <RoleEditSidebar />
      </SmartSidebar>
    </div>
  );
}

/** Parse the `?focus=` query string into a FocusedField. Recognised
 *  shapes: "name" | "extends" | "scope" | "code_anchor" | "actor_in".
 *  Anything else (or absent) returns null. */
function parseFocusParam(raw: string | null): FocusedField {
  if (!raw) return null;
  if (raw === 'name')        return { kind: 'name' };
  if (raw === 'extends')     return { kind: 'extends' };
  if (raw === 'scope')       return { kind: 'scope' };
  if (raw === 'code_anchor') return { kind: 'code_anchor' };
  if (raw === 'actor_in')    return { kind: 'actor_in' };
  return null;
}
