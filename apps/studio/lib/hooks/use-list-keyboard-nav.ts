'use client';

import { useCallback, type KeyboardEvent } from 'react';

/**
 * useListKeyboardNav — shared ↑/↓/Home/End handler for the catalog,
 * lexicon table, and role compact list. The host attaches the returned
 * onKeyDown to the list container (with tabIndex={-1}) so arrow keys
 * move selection regardless of which row currently has focus.
 *
 * Selected element gets scrollIntoView({block:'nearest'}) so long
 * lists stay anchored without jumping.
 */
export function useListKeyboardNav<T>({
  items,
  selectedId,
  getKey,
  onSelect,
}: {
  items: T[];
  selectedId: string | null;
  getKey: (item: T) => string;
  onSelect: (id: string) => void;
}) {
  const onKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>) => {
      if (items.length === 0) return;
      const idx = items.findIndex((i) => getKey(i) === selectedId);
      let next = -1;
      switch (e.key) {
        case 'ArrowDown': next = idx < 0 ? 0 : Math.min(idx + 1, items.length - 1); break;
        case 'ArrowUp':   next = idx <= 0 ? 0 : idx - 1; break;
        case 'Home':      next = 0; break;
        case 'End':       next = items.length - 1; break;
        default: return;
      }
      if (next === idx) return;
      e.preventDefault();
      const nextKey = getKey(items[next]);
      onSelect(nextKey);
      // Scroll the newly-selected row into view on the next paint —
      // the row gets re-rendered with aria-current/data-active and we
      // want to scroll to its updated position.
      requestAnimationFrame(() => {
        const el =
          e.currentTarget.querySelector?.(`[data-row-id="${nextKey}"]`) ??
          document.querySelector(`[data-row-id="${nextKey}"]`);
        (el as HTMLElement | null)?.scrollIntoView({ block: 'nearest' });
      });
    },
    [items, selectedId, getKey, onSelect],
  );
  return { onKeyDown };
}
