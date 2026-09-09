import type { Dok } from '@doklo-beta/core';
import type { TemplateSelector } from './template-manifest.js';

/**
 * Apply a TemplateSelector to a list of Doks.
 *
 * Semantics (spec §8):
 *  - explicit_ids are unconditional force-includes, bypassing all other filters.
 *  - Otherwise: each include_* field is AND across categories, OR within array.
 *  - exclude_tags removes matched Doks (does NOT remove explicit_ids force-adds).
 *
 * Empty selector → returns all input doks unchanged (caller handles "0 matches" case).
 */
export function selectDoks(doks: Dok[], selector: TemplateSelector): Dok[] {
  if (!selector) return doks.slice();
  const explicit = new Set(selector.explicit_ids ?? []);
  const includeTags = selector.include_tags;
  const includeServices = selector.include_services;
  const includeStatuses = selector.include_statuses;
  const excludeTags = selector.exclude_tags;

  const out: Dok[] = [];
  const seen = new Set<string>();

  for (const d of doks) {
    // Force-include path: bypass everything else.
    if (explicit.has(d.dok_id)) {
      if (!seen.has(d.dok_id)) {
        seen.add(d.dok_id);
        out.push(d);
      }
      continue;
    }

    if (includeTags && includeTags.length > 0) {
      const hit = d.tags.some((t) => includeTags.includes(t));
      if (!hit) continue;
    }
    if (includeServices && includeServices.length > 0) {
      const hit = d.surfaces.some((s) => includeServices.includes(s));
      if (!hit) continue;
    }
    if (includeStatuses && includeStatuses.length > 0) {
      if (!includeStatuses.includes(d.status)) continue;
    }
    if (excludeTags && excludeTags.length > 0) {
      const hit = d.tags.some((t) => excludeTags.includes(t));
      if (hit) continue;
    }
    if (seen.has(d.dok_id)) continue;
    seen.add(d.dok_id);
    out.push(d);
  }
  return out;
}
