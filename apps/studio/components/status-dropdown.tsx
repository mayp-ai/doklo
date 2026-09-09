'use client';

import { useState } from 'react';
import type { Dok } from '@doklo-beta/core';

const STATUSES: Array<{ value: Dok['status']; label: string }> = [
  { value: 'draft', label: 'AI-generated, pending review' },
  { value: 'review', label: 'In review' },
  { value: 'active', label: 'Verified, in production' },
  { value: 'planned', label: 'Designed, not built' },
  { value: 'deprecated', label: 'Being removed' },
  { value: 'archived', label: 'Archived, inactive' },
];

interface Props {
  status: Dok['status'];
  onChange: (status: Dok['status']) => void;
  onFocusStatus: () => void;
}

export function StatusDropdown({ status, onChange, onFocusStatus }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <span className="status-dropdown">
      <button
        type="button"
        className="status-pill focusable-inline"
        data-status={status}
        onClick={() => {
          setOpen((v) => !v);
          onFocusStatus();
        }}
        aria-haspopup="listbox"
        aria-expanded={open}
      >
        <span className="status-dot" data-status={status} aria-hidden />
        {status}
      </button>

      {open && (
        <>
          <div
            className="dropdown-overlay"
            onClick={() => setOpen(false)}
            aria-hidden
          />
          <div className="dropdown-menu status-dropdown-menu" role="listbox">
            {STATUSES.map((s) => (
              <button
                key={s.value}
                type="button"
                className={
                  s.value === status
                    ? 'dropdown-item is-active'
                    : 'dropdown-item'
                }
                onClick={() => {
                  onChange(s.value);
                  setOpen(false);
                }}
              >
                <span className="status-dropdown-row">
                  <span
                    className="status-dot"
                    data-status={s.value}
                    aria-hidden
                  />
                  <strong>{s.value}</strong>
                </span>
                <span className="dropdown-item-desc">{s.label}</span>
              </button>
            ))}
          </div>
        </>
      )}
    </span>
  );
}
