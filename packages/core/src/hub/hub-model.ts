// HubModel — the in-memory shape of a loaded v5 5-Layer Hub.
// Promoted from preserved-branch packages/spoke-user-guide/src/types.ts
// because all 7 preserved-branch spokes redeclared the same shape.
// This is the single import surface for the Livedoc engine.

import type { Dok } from '../schemas/dok.js';
import type { Workspace } from '../schemas/workspace.js';
import type { LexiconFile } from '../schemas/lexicon.js';
import type { RolesFile } from '../schemas/role.js';
import type { IaFileV1 } from '../schemas/ia-v1.js';
import type { IaFileV2 } from '../schemas/ia.js';
import type { ServiceCodeMappingFile } from '../schemas/code-mapping.js';

/**
 * Per-service slice of the Hub: the parts that live under
 * `<workspaceRoot>/.doklo/hub/services/<service_id>/`.
 *
 * `ia` and `codeMapping` are optional because not every service ships them yet
 * (e.g., an auto-extracted hub may only have doks + lexicon + roles).
 *
 * `ia` keeps whichever IA contract is on disk. The hub loader is a read-only
 * consumer: it parses v1 as v1 and v2 as v2 and never migrates, because
 * migration needs the RouteIR only the generate pipeline has. Branch on
 * `ia.version` when a field differs between the contracts.
 */
export interface ServiceHubSlice {
  service_id: string;
  ia?: IaFileV1 | IaFileV2;
  codeMapping?: ServiceCodeMappingFile;
}

/**
 * Result of @doklo-beta/core hub/loader — the entire Hub in memory.
 *
 * Two on-disk layouts are supported:
 * - Per-Dok layout (v5 default): `.doklo/hub/doks/<DOK-ID>.json` per Dok.
 * - Legacy single-array layout: `<root>/doks.json` containing a flat array.
 *   Used by golden fixtures and older workspaces.
 */
export interface HubModel {
  workspace: Workspace;
  doks: Dok[];
  lexicon: LexiconFile;
  roles: RolesFile;
  /** Per-service IA + code-mapping. Empty array when no services/ exists. */
  services: ServiceHubSlice[];
  /**
   * Indicates which layout the loader resolved from.
   * Useful for diagnostics and for writers that need to know the source.
   */
  layout: 'per-dok' | 'legacy';
}
