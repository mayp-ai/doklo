import {
  RoleIdSchema,
  type ProjectIR,
  type RoleConfidence,
  type RoleId,
  type RoleKind,
  type RoleSignalIR,
} from '@doklo-beta/core';

export type { RoleConfidence } from '@doklo-beta/core';

export interface RoleCandidate {
  role_id: RoleId;
  /** Suggested human-readable name. The user / Studio is expected to override. */
  name: string;
  kind: RoleKind;
  confidence: RoleConfidence;
  /** Free-form provenance for human review. */
  evidence: string[];
}

interface PrefixHint {
  role_id: RoleId;
  name: string;
}

// Route-only extraction intentionally stays restricted to known access prefixes.
const KNOWN_ROLE_PREFIXES: Record<string, PrefixHint> = {
  admin: { role_id: 'ROLE-ADMIN', name: 'Administrator' },
  editor: { role_id: 'ROLE-EDITOR', name: 'Editor' },
  manager: { role_id: 'ROLE-MANAGER', name: 'Manager' },
  owner: { role_id: 'ROLE-OWNER', name: 'Owner' },
  staff: { role_id: 'ROLE-STAFF', name: 'Staff' },
  guest: { role_id: 'ROLE-GUEST', name: 'Guest' },
  moderator: { role_id: 'ROLE-MODERATOR', name: 'Moderator' },
  reviewer: { role_id: 'ROLE-REVIEWER', name: 'Reviewer' },
};

const BASELINE_USER: RoleCandidate = {
  role_id: 'ROLE-USER',
  name: 'User',
  kind: 'access',
  confidence: 'high',
  evidence: ['default authenticated user (always present)'],
};

const KNOWN_ACCESS_NAMES = new Map<RoleId, string>([
  [BASELINE_USER.role_id, BASELINE_USER.name],
  ...Object.values(KNOWN_ROLE_PREFIXES).map(
    (hint): [RoleId, string] => [hint.role_id, hint.name],
  ),
]);
const KNOWN_ACCESS_ROLE_IDS = new Set(KNOWN_ACCESS_NAMES.keys());
const CONFIDENCE_STRENGTH: Record<RoleConfidence, number> = {
  low: 0,
  medium: 1,
  high: 2,
};
const EVIDENCE_PATH_LIMIT = 8;

export class RoleKindConflictError extends Error {
  readonly roleId: RoleId;

  constructor(roleId: RoleId, kinds: readonly RoleKind[]) {
    super(`Conflicting role kinds for ${roleId}: ${[...new Set(kinds)].sort(compareText).join(', ')}`);
    this.name = 'RoleKindConflictError';
    this.roleId = roleId;
  }
}

export function extractRoleCandidates(ir: ProjectIR): RoleCandidate[] {
  const candidates: RoleCandidate[] = [{ ...BASELINE_USER, evidence: [...BASELINE_USER.evidence] }];
  const pathHits = new Map<RoleId, { hint: PrefixHint; paths: string[] }>();

  for (const route of ir.routes) {
    if (route.kind !== 'page' && route.kind !== 'api') continue;
    const segment = roleSegment(route.path);
    if (!segment) continue;
    const hint = KNOWN_ROLE_PREFIXES[segment];
    if (!hint) continue;

    const entry = pathHits.get(hint.role_id) ?? { hint, paths: [] };
    entry.paths.push(route.path);
    pathHits.set(hint.role_id, entry);
  }

  for (const { hint, paths } of pathHits.values()) {
    candidates.push({
      role_id: hint.role_id,
      name: hint.name,
      kind: 'access',
      confidence: 'low',
      evidence: [buildRouteEvidence(paths)],
    });
  }

  for (const signal of ir.role_signals) {
    const roleId = roleIdForSignal(signal.value);
    if (!roleId) continue;
    candidates.push({
      role_id: roleId,
      name: KNOWN_ACCESS_NAMES.get(roleId) ?? displayName(roleId),
      kind: signal.kind,
      confidence: signal.source === 'explicit' ? 'high' : 'medium',
      evidence: [formatSignalEvidence(signal)],
    });
  }

  return mergeRoleCandidateSets([candidates]);
}

export function mergeRoleCandidateSets(
  sets: readonly (readonly RoleCandidate[])[],
): RoleCandidate[] {
  const merged = new Map<RoleId, RoleCandidate>();

  for (const candidates of sets) {
    for (const candidate of candidates) {
      const current = merged.get(candidate.role_id);
      if (!current) {
        merged.set(candidate.role_id, {
          ...candidate,
          evidence: [...new Set(candidate.evidence)].sort(compareText),
        });
        continue;
      }

      let kind = current.kind;
      if (current.kind !== candidate.kind) {
        if (!KNOWN_ACCESS_ROLE_IDS.has(candidate.role_id)) {
          throw new RoleKindConflictError(candidate.role_id, [current.kind, candidate.kind]);
        }
        kind = 'access';
      }

      merged.set(candidate.role_id, {
        role_id: candidate.role_id,
        name: KNOWN_ACCESS_NAMES.get(candidate.role_id)
          ?? [current.name, candidate.name].sort(compareText)[0]!,
        kind,
        confidence: strongestConfidence(current.confidence, candidate.confidence),
        evidence: [...new Set([...current.evidence, ...candidate.evidence])].sort(compareText),
      });
    }
  }

  return [...merged.values()]
    .map((candidate) => ({
      ...candidate,
      confidence: hasCorroboratingSourceClasses(candidate.evidence)
        ? promoteConfidence(candidate.confidence)
        : candidate.confidence,
    }))
    .sort((a, b) => compareText(a.role_id, b.role_id));
}

export function suggestRoleFromRoutePath(
  path: string,
  knownRoles?: readonly RoleId[],
): RoleId | null {
  const segment = roleSegment(path);
  if (!segment) return null;
  const normalized = `ROLE-${segment.replace(/[^a-z0-9]+/gi, '-').toUpperCase()}` as RoleId;
  if (knownRoles) return knownRoles.includes(normalized) ? normalized : null;
  return KNOWN_ROLE_PREFIXES[segment]?.role_id ?? null;
}

function roleIdForSignal(value: string): RoleId | null {
  const normalizedValue = value
    .trim()
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toUpperCase();
  const parsed = RoleIdSchema.safeParse(`ROLE-${normalizedValue}`);
  return parsed.success ? parsed.data : null;
}

function formatSignalEvidence(signal: RoleSignalIR): string {
  return `${signal.file}:${signal.line ?? 1} — ${signal.detector} (${signal.source})`;
}

function roleSegment(path: string): string | null {
  const parts = path.replace(/^\/+|\/+$/g, '').split('/');
  let first = parts[0] ?? '';
  if (first === 'api') first = parts[1] ?? '';
  if (!first) return null;
  if (first.startsWith('[') || first.startsWith('(') || first.startsWith('@')) return null;
  return first.toLowerCase();
}

function buildRouteEvidence(paths: readonly string[]): string {
  const sortedPaths = [...paths].sort(compareText);
  const preview = sortedPaths.slice(0, EVIDENCE_PATH_LIMIT).join(', ');
  const suffix = sortedPaths.length > EVIDENCE_PATH_LIMIT ? '…' : '';
  return `routes (${sortedPaths.length}): ${preview}${suffix}`;
}

function displayName(roleId: RoleId): string {
  return roleId
    .slice('ROLE-'.length)
    .toLowerCase()
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part[0]!.toUpperCase() + part.slice(1))
    .join(' ');
}

function strongestConfidence(a: RoleConfidence, b: RoleConfidence): RoleConfidence {
  return CONFIDENCE_STRENGTH[a] >= CONFIDENCE_STRENGTH[b] ? a : b;
}

function promoteConfidence(confidence: RoleConfidence): RoleConfidence {
  if (confidence === 'low') return 'medium';
  return 'high';
}

function hasCorroboratingSourceClasses(evidence: readonly string[]): boolean {
  const classes = new Set<string>();
  for (const entry of evidence) {
    if (entry.startsWith('routes (')) {
      classes.add('path');
      continue;
    }
    const signalSource = entry.match(/\((explicit|middleware)\)$/)?.[1];
    if (signalSource) classes.add(signalSource);
  }
  return classes.size > 1;
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
