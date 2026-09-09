import type Handlebars from 'handlebars';
import type { Dok } from '@doklo-beta/core';

interface TagGroup {
  tag: string;
  doks: Dok[];
}

export function registerGroupByTag(hb: typeof Handlebars): void {
  /**
   * {{#each (group_doks_by_primary_tag doks)}} ... {{/each}}
   *
   * Group a list of Doks by each Dok's first (primary) tag so every Dok
   * appears in exactly one group. Useful when a template wants a
   * domain-by-domain view without the tag×Dok cartesian blowup of
   * naive nested iteration.
   *
   * Status=archived Doks are excluded. Doks with no tags fall under
   * 'untagged'. Groups are sorted by Dok count desc, then alpha.
   */
  hb.registerHelper('group_doks_by_primary_tag', function (input: unknown): TagGroup[] {
    if (!Array.isArray(input)) return [];
    const buckets = new Map<string, Dok[]>();
    for (const d of input as Dok[]) {
      if (!d || d.status === 'archived') continue;
      const primary = (d.tags && d.tags.length > 0) ? d.tags[0]! : 'untagged';
      const list = buckets.get(primary) ?? [];
      list.push(d);
      buckets.set(primary, list);
    }
    const out: TagGroup[] = Array.from(buckets.entries()).map(([tag, doks]) => ({ tag, doks }));
    out.sort((a, b) => (b.doks.length - a.doks.length) || a.tag.localeCompare(b.tag));
    return out;
  });

  /**
   * {{#each (limit arr N)}} ... {{/each}}
   *
   * Slice an array to the first N elements (no-op when input is not an array).
   * Used together with {{len}} to render "and X more" tails.
   */
  hb.registerHelper('limit', function (input: unknown, n: unknown) {
    if (!Array.isArray(input)) return [];
    const cap = Number(n);
    if (!Number.isFinite(cap) || cap < 0) return input;
    return input.slice(0, cap);
  });

  /**
   * {{#each (filter_active_with_steps doks)}} ... {{/each}}
   *
   * Doks where status === 'active' AND user_actions.steps.length > 0.
   * Useful for "first-week tour" type sections that need walkable flows.
   */
  hb.registerHelper('filter_active_with_steps', function (input: unknown) {
    if (!Array.isArray(input)) return [];
    return (input as Dok[]).filter((d) => d?.status === 'active' && (d.user_actions?.steps?.length ?? 0) > 0);
  });
}
