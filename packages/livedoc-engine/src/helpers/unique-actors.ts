import type Handlebars from 'handlebars';
import type { Actor, UserActionStep } from '@doklo-beta/core';

function actorKey(a: Actor): string {
  switch (a.kind) {
    case 'role':
      return `role:${a.role_ref}`;
    case 'system':
      return 'system';
    case 'external':
      return `external:${a.label}`;
  }
}

export function registerUniqueActors(hb: typeof Handlebars): void {
  /**
   * {{#each (unique_actors steps)}} ... {{/each}}
   *
   * Take a UserActionStep[] (`dok.user_actions.steps`) and return the unique
   * actors in order of first appearance. Bypasses the manual {{#each}}/{{#unless}}
   * pattern that templates would otherwise duplicate, and prevents the same
   * actor from appearing once per step in the "Users" section.
   */
  hb.registerHelper('unique_actors', function (steps: unknown) {
    if (!Array.isArray(steps)) return [];
    const seen = new Set<string>();
    const out: Actor[] = [];
    for (const step of steps as UserActionStep[]) {
      if (!step?.actor) continue;
      const k = actorKey(step.actor);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(step.actor);
    }
    return out;
  });
}
