/**
 * Pure Dok helpers + per-domain decoration for the Studio presentation
 * layer.
 */

/**
 * Per-domain decoration for the catalog group header. Domain key is the
 * first segment of `dok_id` (AUTH-SIGNIN → AUTH, SHOP-CART → SHOP).
 *
 * Phase 5+ replaces this with real domain metadata from the workspace.
 */
export const DOMAIN_META: Record<string, { icon: string; subtitle: string }> = {
  AUTH: { icon: '🔐', subtitle: '인증' },
  SHOP: { icon: '🛒', subtitle: '쇼핑' },
};

/** Extract the domain key from a Dok id (the segment before the first `-`). */
export function dokDomain(dokId: string): string {
  return dokId.split('-')[0] ?? '';
}
