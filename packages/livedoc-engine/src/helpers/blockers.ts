import type Handlebars from 'handlebars';
import type { Dok } from '@doklo-beta/core';

export function hasBlockers(value: unknown): boolean {
  if (!value || typeof value !== 'object') return false;
  const dok = value as Partial<Dok>;
  if ((dok.business_rules?.rules?.length ?? 0) > 0) return true;
  return (dok.user_actions?.steps ?? []).some(
    (step) => (step.preconditions?.length ?? 0) > 0,
  );
}

export function registerBlockers(hb: typeof Handlebars): void {
  hb.registerHelper('has_blockers', hasBlockers);
}
