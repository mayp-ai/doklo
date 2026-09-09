import type Handlebars from 'handlebars';
import type { Workspace } from '@doklo-beta/core';
import type { HelperRoot } from './translate.js';

export interface ServiceAwareHelperRoot extends HelperRoot {
  __workspace?: Workspace;
}

function getRoot(context: unknown, options: Handlebars.HelperOptions): ServiceAwareHelperRoot {
  return (options.data?.root ?? context) as ServiceAwareHelperRoot;
}

export function registerServiceLabel(hb: typeof Handlebars): void {
  /**
   * {{service_label "web"}} — look up service in __workspace.services and return
   * a human label. v5 Service has no localized name yet, so returns service_id
   * formatted (capitalized) until workspace.services gain a display name.
   */
  hb.registerHelper('service_label', function (this: unknown, serviceId: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    const id = String(serviceId ?? '');
    if (!id) return '';
    const svc = root.__workspace?.services.find((s) => s.service_id === id);
    if (!svc) {
      root.__collector?.unresolved.add(id);
      return id;
    }
    // No display name in v5 Service schema; emit type-prefixed id for clarity.
    // Templates that want plain id can still use {{service_id}} directly.
    return svc.type ? `${id} (${svc.type})` : id;
  });
}
