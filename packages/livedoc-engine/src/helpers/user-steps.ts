import type Handlebars from 'handlebars';
import type { UserActionStep } from '@doklo-beta/core';

export function registerUserSteps(hb: typeof Handlebars): void {
  /**
   * {{user_steps steps}} — UserActionStep[] minus system-actor steps.
   *
   * Customer-facing templates number/count only the steps a person performs;
   * system steps render as unnumbered "happens automatically" connectors.
   * This keeps counts like "4단계" consistent with the visible numbering.
   */
  hb.registerHelper('user_steps', function (steps: unknown) {
    if (!Array.isArray(steps)) return [];
    return (steps as UserActionStep[]).filter((s) => s?.actor?.kind !== 'system');
  });
}
