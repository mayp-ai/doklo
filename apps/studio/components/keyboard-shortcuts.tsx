'use client';

import { useEffect } from 'react';
import { useStudio } from './studio-store';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';

/**
 * KeyboardShortcuts — global keydown handler. Mounted once at the
 * (hub) layout level. Renders nothing; its only side effect is
 * attaching a window listener.
 *
 * Bindings:
 *   ⌘1..⌘4 → layer switch (Doks / Lexicon / IA / Roles)
 *   ⌘K     → open command palette (current layer search)
 *   ⌘⇧K    → open command palette (cross-layer search)
 *   Esc    → close command palette
 *
 * macOS uses metaKey, Windows/Linux uses ctrlKey — we accept either.
 * ⌘1..⌘4 are skipped when focus is in an editable element so typing
 * "1" in a search box doesn't yank the user to /doks.
 */
export function KeyboardShortcuts() {
  const { push } = useSafeNavigation();
  const { paletteOpen, openPalette, closePalette } = useStudio();

  useEffect(() => {
    function isEditable(el: EventTarget | null): boolean {
      if (!(el instanceof HTMLElement)) return false;
      const tag = el.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
      if (el.isContentEditable) return true;
      return false;
    }

    function handleKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;

      // Esc — palette close (works regardless of focus, but only when
      // the palette is open so we don't steal Esc from other modals).
      if (e.key === 'Escape' && paletteOpen) {
        e.preventDefault();
        closePalette();
        return;
      }

      if (!mod) return;
      const editable = isEditable(e.target);

      // ⌘K / ⌘⇧K — always available, even in inputs, because the user
      // expects ⌘K to escape any field and reach search.
      if (e.key.toLowerCase() === 'k') {
        e.preventDefault();
        openPalette({ crossLayer: e.shiftKey });
        return;
      }

      // ⌘1..⌘4 — only when not typing.
      if (editable) return;
      switch (e.key) {
        case '1':
          e.preventDefault();
          void push('/doks');
          break;
        case '2':
          e.preventDefault();
          void push('/lexicon');
          break;
        case '3':
          e.preventDefault();
          void push('/ia');
          break;
        case '4':
          e.preventDefault();
          void push('/roles');
          break;
      }
    }

    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [push, paletteOpen, openPalette, closePalette]);

  return null;
}
