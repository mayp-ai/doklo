import type Handlebars from 'handlebars';
import { resolveTranslatable } from '@doklo-beta/core';
import type { HelperRoot } from './translate.js';

function getRoot(context: unknown, options: Handlebars.HelperOptions): HelperRoot {
  return (options.data?.root ?? context) as HelperRoot;
}

export function registerRoleLabel(hb: typeof Handlebars): void {
  /**
   * {{role_label "ROLE-ADMIN"}} — look up role in __roles and translate its name.
   * Returns the role_id raw + records to collector when role not found.
   */
  hb.registerHelper('role_label', function (this: unknown, roleId: unknown, options: Handlebars.HelperOptions) {
    const root = getRoot(this, options);
    const id = String(roleId ?? '');
    if (!id) return '';
    const role = root.__roles?.roles.find((r) => r.role_id === id);
    if (!role) {
      root.__collector?.unresolved.add(id);
      return id;
    }
    return resolveTranslatable(
      role.name,
      {
        locale: root.__locale,
        primaryLocale: root.__primaryLocale,
        lexicon: root.__lexicon,
        roles: root.__roles,
      },
      root.__collector,
    );
  });
}
