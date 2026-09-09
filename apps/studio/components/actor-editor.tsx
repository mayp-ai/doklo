'use client';

import { useMemo, useState } from 'react';
import type { Actor, Role } from '@doklo-beta/core';

interface RoleOption {
  role_id: string;
  display: string;
}

interface Props {
  actor: Actor;
  onChange: (actor: Actor) => void;
  onBlurSave: () => void;
  roles?: RoleOption[];
  /** When set, clicking a role-kind pill dispatches an inspect request to the
   *  Smart Sidebar instead of opening the kind/role picker popup. The picker
   *  is then reachable via a small ▾ caret affordance. */
  onInspectRole?: (roleId: string) => void;
}

export function ActorEditor({
  actor,
  onChange,
  onBlurSave,
  roles = [],
  onInspectRole,
}: Props) {
  const [open, setOpen] = useState(false);

  const display =
    actor.kind === 'role'
      ? actor.role_ref.replace(/^ROLE-/, '')
      : actor.kind === 'system'
        ? 'SYSTEM'
        : actor.label;

  const selectKind = (kind: Actor['kind']) => {
    if (kind === actor.kind) return;
    if (kind === 'role') {
      // First workspace role when available, else empty — the user then
      // types/picks a real role_ref (no fixture role hardcoded).
      const defaultRole = roles[0]?.role_id ?? '';
      onChange({ kind: 'role', role_ref: defaultRole });
    } else if (kind === 'system') {
      onChange({ kind: 'system' });
    } else {
      onChange({ kind: 'external', label: 'External' });
    }
  };

  const isInspectable = actor.kind === 'role' && !!onInspectRole;

  const handlePillClick = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (isInspectable && actor.kind === 'role') {
      onInspectRole!(actor.role_ref);
      return;
    }
    setOpen((v) => !v);
  };

  return (
    <span className="actor-editor">
      <button
        type="button"
        className={
          isInspectable ? 'actor-pill is-inspectable' : 'actor-pill'
        }
        data-actor={actor.kind}
        onClick={handlePillClick}
        aria-haspopup={isInspectable ? undefined : 'dialog'}
        aria-expanded={isInspectable ? undefined : open}
        title={
          isInspectable
            ? `Inspect ${actor.kind === 'role' ? actor.role_ref : ''}`
            : undefined
        }
      >
        {display}
      </button>
      {isInspectable && (
        <button
          type="button"
          className="actor-pill-caret"
          onClick={(e) => {
            e.stopPropagation();
            setOpen((v) => !v);
          }}
          aria-haspopup="dialog"
          aria-expanded={open}
          aria-label="Change actor kind / role"
        >
          ▾
        </button>
      )}

      {open && (
        <>
          <div
            className="dropdown-overlay"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="actor-editor-popup" role="dialog">
            <div>
              <div className="actor-editor-section-title">Actor kind</div>
              <div className="actor-kind-row">
                <KindButton
                  active={actor.kind === 'role'}
                  kind="role"
                  label="role"
                  desc="A person (customer, admin). References a Role in roles.json"
                  onSelect={() => selectKind('role')}
                />
                <KindButton
                  active={actor.kind === 'system'}
                  kind="system"
                  label="system"
                  desc="Automation. Performed by the system with no user"
                  onSelect={() => selectKind('system')}
                />
                <KindButton
                  active={actor.kind === 'external'}
                  kind="external"
                  label="external"
                  desc="An external actor (payment gateway, OAuth provider)"
                  onSelect={() => selectKind('external')}
                />
              </div>
            </div>

            {actor.kind === 'role' && (
              <RolePicker
                value={actor.role_ref}
                roles={roles}
                onChange={(v) => onChange({ kind: 'role', role_ref: v })}
                onBlurSave={onBlurSave}
              />
            )}

            {actor.kind === 'external' && (
              <div>
                <div className="actor-editor-section-title">label</div>
                <input
                  className="actor-editor-input"
                  value={actor.label}
                  onChange={(e) =>
                    onChange({ kind: 'external', label: e.target.value })
                  }
                  onBlur={onBlurSave}
                  placeholder="Payment gateway"
                  spellCheck={false}
                  autoFocus
                />
                <div className="actor-editor-hint">
                  Name of an external system or person. Free text.
                </div>
              </div>
            )}
          </div>
        </>
      )}
    </span>
  );
}

function RolePicker({
  value,
  roles,
  onChange,
  onBlurSave,
}: {
  value: string;
  roles: RoleOption[];
  onChange: (v: string) => void;
  onBlurSave: () => void;
}) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    if (!roles.length) return [];
    const q = query.trim().toLowerCase();
    if (!q) return roles;
    return roles.filter(
      (r) =>
        r.role_id.toLowerCase().includes(q) ||
        r.display.toLowerCase().includes(q),
    );
  }, [query, roles]);

  const known = roles.find((r) => r.role_id === value);

  return (
    <div>
      <div className="actor-editor-section-title">role_ref</div>
      <input
        className="actor-editor-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onBlur={onBlurSave}
        placeholder="ROLE-USER"
        spellCheck={false}
        autoFocus
      />
      <div className="actor-editor-hint">
        {known ? (
          <>
            <code>{known.role_id}</code> · {known.display}
          </>
        ) : (
          <>
            Starts with <code>ROLE-</code>. An ID not in roles.json must be registered separately.
          </>
        )}
      </div>

      {roles.length > 0 && (
        <>
          <div
            className="actor-editor-section-title"
            style={{ marginTop: 12 }}
          >
            roles.json
          </div>
          <input
            className="actor-editor-input"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            spellCheck={false}
            style={{ marginBottom: 4 }}
          />
          <ul
            style={{
              listStyle: 'none',
              padding: 0,
              margin: 0,
              maxHeight: 180,
              overflow: 'auto',
              display: 'grid',
              gap: 2,
            }}
          >
            {filtered.map((r) => (
              <li key={r.role_id}>
                <button
                  type="button"
                  className={
                    r.role_id === value
                      ? 'actor-kind-button is-active'
                      : 'actor-kind-button'
                  }
                  onClick={() => onChange(r.role_id)}
                  style={{ width: '100%' }}
                >
                  <span className="actor-pill" data-actor="role">
                    {r.role_id.replace(/^ROLE-/, '')}
                  </span>
                  <span className="actor-kind-desc">{r.display}</span>
                </button>
              </li>
            ))}
            {filtered.length === 0 && (
              <li
                style={{
                  padding: 'var(--space-2) var(--space-3)',
                  fontSize: 12,
                  color: 'var(--color-ink-faint)',
                }}
              >
                No matching role.
              </li>
            )}
          </ul>
        </>
      )}
    </div>
  );
}

function KindButton({
  active,
  kind,
  label,
  desc,
  onSelect,
}: {
  active: boolean;
  kind: Actor['kind'];
  label: string;
  desc: string;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      className={
        active ? 'actor-kind-button is-active' : 'actor-kind-button'
      }
      onClick={onSelect}
    >
      <span className="actor-pill" data-actor={kind}>
        {label}
      </span>
      <span className="actor-kind-desc">{desc}</span>
    </button>
  );
}

// Re-export for consumers that want to map Role[] → RoleOption[]
export type { RoleOption };
export function rolesToOptions(
  roles: Pick<Role, 'role_id'>[],
  display: Record<string, string>,
): RoleOption[] {
  return roles.map((r) => ({
    role_id: r.role_id,
    display: display[r.role_id] ?? r.role_id,
  }));
}
