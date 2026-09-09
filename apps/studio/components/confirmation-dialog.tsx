'use client';

import { useEffect, useId, useRef, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not(:disabled)',
  'input:not(:disabled):not([type="hidden"])',
  'select:not(:disabled)',
  'textarea:not(:disabled)',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export interface ConfirmationCopy {
  title: string;
  description: string;
  confirmLabel: string;
}

export function ConfirmationDialog({
  id,
  title,
  description,
  confirmLabel,
  cancelLabel = 'Cancel',
  confirmDisabled = false,
  children,
  returnFocus,
  fallbackFocus,
  onCancel,
  onConfirm,
}: ConfirmationCopy & {
  id?: string;
  cancelLabel?: string;
  confirmDisabled?: boolean;
  children?: ReactNode;
  returnFocus: HTMLElement | null;
  fallbackFocus?: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const titleId = useId();
  const descriptionId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const onCancelRef = useRef(onCancel);

  useEffect(() => {
    onCancelRef.current = onCancel;
  }, [onCancel]);

  useEffect(() => {
    const dialog = dialogRef.current;
    const cancel = cancelRef.current;
    if (!dialog || !cancel) return;
    const ownerDocument = dialog.ownerDocument;

    const focusables = () =>
      [...dialog.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)].filter(
        (element) => element.tabIndex >= 0,
      );

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onCancelRef.current();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = focusables();
      if (items.length === 0) {
        event.preventDefault();
        dialog.focus({ preventScroll: true });
        return;
      }
      const active = ownerDocument.activeElement;
      const index = active instanceof HTMLElement ? items.indexOf(active) : -1;
      const wrapBackward = event.shiftKey && index <= 0;
      const wrapForward = !event.shiftKey && (index === -1 || index === items.length - 1);
      if (!wrapBackward && !wrapForward) return;
      event.preventDefault();
      const target = event.shiftKey ? items.at(-1) : items[0];
      target?.focus({ preventScroll: true });
    };

    const onFocusIn = (event: FocusEvent) => {
      if (event.target instanceof Node && dialog.contains(event.target)) return;
      cancel.focus({ preventScroll: true });
    };

    ownerDocument.addEventListener('keydown', onKeyDown, true);
    ownerDocument.addEventListener('focusin', onFocusIn, true);
    cancel.focus({ preventScroll: true });

    return () => {
      ownerDocument.removeEventListener('keydown', onKeyDown, true);
      ownerDocument.removeEventListener('focusin', onFocusIn, true);
      const target = [returnFocus, fallbackFocus].find(
        (candidate): candidate is HTMLElement =>
          candidate !== null &&
          candidate !== undefined &&
          candidate.isConnected &&
          !candidate.matches(':disabled'),
      );
      target?.focus({ preventScroll: true });
    };
  }, [fallbackFocus, returnFocus]);

  if (typeof document === 'undefined') return null;

  return createPortal(
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-ink-strong/35 p-4 sm:p-6">
      <div
        ref={dialogRef}
        id={id}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={descriptionId}
        tabIndex={-1}
        className="w-full max-w-[440px] rounded-lg border border-border bg-canvas p-5 shadow-xl"
      >
        <h2 id={titleId} className="text-base font-semibold tracking-tight text-ink-strong">
          {title}
        </h2>
        <p id={descriptionId} className="mt-2 text-[13px] leading-relaxed text-ink-secondary">
          {description}
        </p>
        {children}
        <div className="mt-5 flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded-md border border-border bg-canvas px-3 py-1.5 text-[13px] font-medium text-ink-secondary hover:bg-surface focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
          >
            {cancelLabel}
          </button>
          <button
            type="button"
            disabled={confirmDisabled}
            onClick={onConfirm}
            className={[
              'rounded-md border border-status-deprecated-fg bg-status-deprecated-bg px-3 py-1.5 text-[13px] font-semibold text-status-deprecated-fg focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent',
              confirmDisabled
                ? 'cursor-not-allowed opacity-45'
                : 'hover:brightness-95',
            ].join(' ')}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
