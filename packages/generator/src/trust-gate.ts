import { access, stat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import {
  DokSchema,
  PathOutsideRootError,
  resolveContainedPath,
  type Dok,
  type RoleId,
} from '@doklo-beta/core';

export interface DokWriteTrustContext {
  expectedDokId: string;
  expectedStatus?: Dok['status'];
  serviceRoots: ReadonlyMap<string, string>;
  knownRoleIds: ReadonlySet<string>;
}

export class DokTrustFailure extends Error {
  readonly code = 'DOK_TRUST_FAILED' as const;
  readonly details: Readonly<Record<string, unknown>>;

  constructor(reason: string, details: Record<string, unknown> = {}) {
    super(`Dok write trust check failed: ${reason}`);
    this.name = 'DokTrustFailure';
    this.details = { reason, ...details };
  }
}

/** Parse and prove the invariants required before a Dok may enter the Hub. */
export async function validateDokForWrite(
  raw: unknown,
  context: DokWriteTrustContext,
): Promise<Dok> {
  // Check identity before parsing so a malformed/escaped generated ID cannot
  // be written under an otherwise expected filename.
  if (!isRecord(raw) || raw.dok_id !== context.expectedDokId) {
    throw new DokTrustFailure('DOK_ID_PATH_MISMATCH', {
      expectedDokId: context.expectedDokId,
      actualDokId: isRecord(raw) ? raw.dok_id : undefined,
    });
  }

  let dok: Dok;
  try {
    dok = DokSchema.parse(raw);
  } catch (error) {
    throw new DokTrustFailure('SCHEMA_INVALID', {
      cause: error instanceof Error ? error.message : String(error),
    });
  }

  if (context.expectedStatus !== undefined && dok.status !== context.expectedStatus) {
    throw new DokTrustFailure('REVIEW_STATUS_MISMATCH', {
      expectedStatus: context.expectedStatus,
      actualStatus: dok.status,
    });
  }

  const anchors = dok._meta.source_anchors ?? [];
  if (anchors.length === 0) throw new DokTrustFailure('ZERO_SOURCE_ANCHORS');

  const declaredService = dok._meta.anchor_service_id;
  if (declaredService !== undefined && !context.serviceRoots.has(declaredService)) {
    throw new DokTrustFailure('UNKNOWN_ANCHOR_SERVICE', { serviceId: declaredService });
  }
  const anchorServices = new Set(
    anchors.flatMap((anchor) => anchor.service_id === undefined ? [] : [anchor.service_id]),
  );
  if (declaredService === undefined && context.serviceRoots.size > 1) {
    throw new DokTrustFailure('ANCHOR_SERVICE_REQUIRED', {
      serviceIds: [...anchorServices].sort(),
    });
  }

  const fallbackService = context.serviceRoots.size === 1
    ? context.serviceRoots.keys().next().value as string | undefined
    : undefined;
  for (const [index, anchor] of anchors.entries()) {
    if (anchor.service_id !== undefined && !context.serviceRoots.has(anchor.service_id)) {
      throw new DokTrustFailure('UNKNOWN_ANCHOR_SERVICE', { index, serviceId: anchor.service_id });
    }
    if (declaredService !== undefined
      && anchor.service_id !== undefined
      && anchor.service_id !== declaredService) {
      throw new DokTrustFailure('ANCHOR_SERVICE_MISMATCH', {
        index,
        declaredService,
        anchorServiceId: anchor.service_id,
      });
    }
    const serviceId = anchor.service_id ?? dok._meta.anchor_service_id ?? fallbackService;
    if (!serviceId || !context.serviceRoots.has(serviceId)) {
      throw new DokTrustFailure('UNKNOWN_ANCHOR_SERVICE', { index, serviceId });
    }
    const root = context.serviceRoots.get(serviceId)!;
    let source: string;
    try {
      source = await resolveContainedPath(root, anchor.file);
    } catch (error) {
      throw new DokTrustFailure(
        error instanceof PathOutsideRootError
          ? 'ESCAPED_SOURCE_ANCHOR'
          : 'MISSING_SOURCE_ANCHOR',
        {
        index,
        serviceId,
        file: anchor.file,
        cause: error instanceof Error ? error.message : String(error),
        },
      );
    }
    try {
      await access(source, FS.R_OK);
      const metadata = await stat(source);
      if (!metadata.isFile()) {
        throw new DokTrustFailure('SOURCE_ANCHOR_NOT_FILE', {
          index,
          serviceId,
          file: anchor.file,
        });
      }
    } catch (error) {
      if (error instanceof DokTrustFailure) throw error;
      throw new DokTrustFailure('MISSING_SOURCE_ANCHOR', {
        index,
        serviceId,
        file: anchor.file,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const roleId of collectRoleRefs(dok)) {
    if (!context.knownRoleIds.has(roleId)) {
      throw new DokTrustFailure('UNKNOWN_ROLE_REF', { roleId });
    }
  }
  return dok;
}

function collectRoleRefs(dok: Dok): RoleId[] {
  const refs: RoleId[] = [];
  for (const step of dok.user_actions?.steps ?? []) {
    if (step.actor.kind === 'role') refs.push(step.actor.role_ref);
  }
  for (const rule of dok.business_rules?.rules ?? []) {
    refs.push(...(rule.applies_to_roles ?? []));
  }
  return refs;
}

function isRecord(value: unknown): value is Record<string, any> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
