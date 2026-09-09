import type { Role, RoleKind } from '@doklo-beta/core';

export const KIND_ORDER = [
  'access',
  'actor_type',
] as const satisfies readonly RoleKind[];

const KIND_LABELS: Record<RoleKind, string> = {
  access: 'Access',
  actor_type: 'Actor type',
};

export interface RoleKindGroup {
  kind: RoleKind;
  roles: Role[];
}

export function roleKindLabel(kind: RoleKind): string {
  return KIND_LABELS[kind];
}

/** Group without mutating the catalog or changing order within a kind. */
export function groupRolesByKind(roles: readonly Role[]): RoleKindGroup[] {
  const buckets = new Map<RoleKind, Role[]>();
  for (const role of roles) {
    const bucket = buckets.get(role.kind) ?? [];
    bucket.push(role);
    buckets.set(role.kind, bucket);
  }

  return KIND_ORDER.flatMap((kind) => {
    const groupedRoles = buckets.get(kind);
    return groupedRoles ? [{ kind, roles: groupedRoles }] : [];
  });
}
