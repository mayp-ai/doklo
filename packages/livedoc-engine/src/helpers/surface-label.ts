import type Handlebars from 'handlebars';

export function registerSurfaceLabel(hb: typeof Handlebars): void {
  /**
   * {{surface_label ref}} — v1 stub returns the ref unchanged.
   *
   * Spec §6: v1.1 will add ia.json path lookup. Templates can call this now
   * and the upgrade will be transparent.
   */
  hb.registerHelper('surface_label', function (ref: unknown) {
    return String(ref ?? '');
  });
}
