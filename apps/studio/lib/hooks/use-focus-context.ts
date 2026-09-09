'use client';

import { useCallback } from 'react';
import { useStudio, type FocusedField } from '../../components/studio-store';

/**
 * useFocusContext — small surface over the existing FocusedField store
 * field so editor blocks don't keep importing useStudio just for the
 * focus tracking pair.
 *
 *   const focus = useFocusContext();
 *   const onDescFocus = focus.handlers({ kind: 'description' }).onFocus;
 *
 * Blur is intentionally NOT immediate. If the user tabs from
 * description into a step's intent textarea, we don't want a flash of
 * the default sidebar between blur and the next focus. The
 * sidebar-routing component decides what to render when focus is null;
 * we just hand it the current value.
 */
export function useFocusContext() {
  const { focusedField, setFocusedField } = useStudio();

  const handlers = useCallback(
    (field: FocusedField) => ({
      onFocus: () => setFocusedField(field),
      // Blur is a no-op here — the next focus event will replace the
      // field naturally. Use explicit clearFocus() for "leave editor"
      // moments (e.g. clicking outside any field).
      onBlur: undefined as undefined,
    }),
    [setFocusedField],
  );

  const clearFocus = useCallback(() => setFocusedField(null), [setFocusedField]);

  return { focus: focusedField, setFocus: setFocusedField, handlers, clearFocus };
}

/** Stable string key for the active focus context. Used as
 *  SmartSidebar's transitionKey so the sidebar fades on every focus
 *  change. Distinct locales (locale.ko vs locale.ja) need distinct
 *  keys so the lexicon-editor sidebar re-animates when the user
 *  tabs between rows. */
export function focusKey(field: FocusedField): string {
  if (field === null) return 'default';
  switch (field.kind) {
    case 'step':       return `step:${field.order}`;
    case 'rule':       return `rule:${field.id}`;
    case 'criterion':  return `criterion:${field.id}`;
    case 'locale':     return `locale:${field.loc}`;
    case 'inspect-term': return `inspect-term:${field.term_id}`;
    case 'inspect-role': return `inspect-role:${field.role_id}`;
    default:           return field.kind;
  }
}
