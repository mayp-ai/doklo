'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import type {
  Dok,
  LexiconFile,
  LexiconTerm,
  Role,
  RolesFile,
  Workspace,
} from '@doklo-beta/core';
import type { BlastRadius, BusinessImpact } from '@doklo-beta/core/schemas';
import { comparePriority } from '../lib/dok-priority-order';
import { dokDomain } from '../lib/dok-meta';
import { termDisplay, termSupportedLocales } from '../lib/term-display';
import {
  EMPTY_IA_STATS,
  IA_DEPTH_ALL,
  findIaNode,
  iaStats,
  selectDefaultIaTree,
  type IaFilter,
  type IaStats,
} from '../lib/ia-presentation';
import type {
  IaJumpTarget,
  Platform,
  StudioIaNode,
  StudioIaTree,
} from '../lib/ia-route';
import type { DokCatalogData, LoadState } from '../lib/load-state';

// Tagged union of "what the user is currently editing or inspecting".
// SmartSidebar reads this to decide what guide / reference data to show.
//
// Phase 9 introduced the doks-editor variants (name/description/status/…).
// Phase 10 adds lexicon-editor variants (canonical/binding/locale/used_in).
// They share the same field because only one editor is active at a time
// — when both stores held parallel keys earlier it just produced
// "which one wins" confusion with no upside.
export type FocusedField =
  | null
  // Dok editor
  | { kind: 'name' }
  | { kind: 'description' }
  | { kind: 'status' }
  | { kind: 'surfaces' }
  | { kind: 'tags' }
  | { kind: 'step'; order: number }
  | { kind: 'rule'; id: string }
  | { kind: 'criterion'; id: string }
  | { kind: 'meta' }
  // Lexicon editor (Phase 10)
  | { kind: 'canonical' }
  | { kind: 'binding' }
  | { kind: 'locale'; loc: string }
  | { kind: 'used_in' }
  // Role editor (Phase 11)
  | { kind: 'extends' }
  | { kind: 'scope' }
  | { kind: 'code_anchor' }
  | { kind: 'actor_in' }
  // Inline cross-reference inspection in Smart Sidebar
  | { kind: 'inspect-term'; term_id: string }
  | { kind: 'inspect-role'; role_id: string };

export type SaveStatus =
  | { kind: 'idle' }
  | { kind: 'dirty'; path: string }
  | { kind: 'saving'; path: string }
  | { kind: 'saved'; path: string }
  | { kind: 'error'; path: string; message: string; retry: () => Promise<boolean> }
  | { kind: 'conflict'; path: string; message: string; retry: () => Promise<boolean> };

export interface PendingSaveRegistration {
  path: string;
  flush: () => Promise<boolean>;
}

export interface LayerCounts {
  doks: number;
  lexicon: number;
  ia: number;
  roles: number;
}

// ──────────────────────────────────────────────────────────────────────
// Dok slice — catalog state lifted out of the page so SmartSidebar
// (Phase 4) and any future view can subscribe to the same selection.
// ──────────────────────────────────────────────────────────────────────

export type DokFilter = 'all' | 'active' | 'draft' | 'review';
export type DokSort = 'priority' | 'id' | 'recent';

// ──────────────────────────────────────────────────────────────────────
// Lexicon slice — Phase 5. Mirrors the Dok slice shape so Phase 6/7
// (IA, Roles) can layer on top with the same selector pattern.
// ──────────────────────────────────────────────────────────────────────

// ──────────────────────────────────────────────────────────────────────
// IA slice — typed tree catalog + key-based expand/select.
// ──────────────────────────────────────────────────────────────────────

/** Two IA presentations. Overview = big-picture cards (PM scenario).
 *  Tree = precise nested list (dev scenario). Overview is the default.
 *  This is the render mode, not the tree `type` classification. */
export type IaView = 'overview' | 'tree';

/** Depth slider bounds. Values 1–5 are finite; IA_DEPTH_MAX is the
 *  unbounded "all" sentinel shared by both IA presentations. */
export const IA_DEPTH_MIN = 1;
export const IA_DEPTH_MAX = IA_DEPTH_ALL;
export const IA_DEPTH_DEFAULT = 3;

interface StudioState {
  // Editor focus
  focusedField: FocusedField;
  setFocusedField: (f: FocusedField) => void;

  // Save lifecycle
  saveStatus: SaveStatus;
  setSaveStatus: (status: SaveStatus) => void;
  pendingSave: PendingSaveRegistration | null;
  registerPendingSave: (pending: PendingSaveRegistration | null) => void;
  claimPendingSave: (pending: PendingSaveRegistration) => Promise<boolean>;
  replacePendingSave: (
    current: PendingSaveRegistration,
    replacement: PendingSaveRegistration,
  ) => boolean;
  unregisterPendingSave: (pending: PendingSaveRegistration) => void;
  flushPendingSave: () => Promise<boolean>;

  // Canonical lossless layer states from RootLayout. Pages inspect these
  // before resolving IDs so invalid/unreadable never collapses to empty.
  workspaceState: LoadState<Workspace>;
  doksState: LoadState<DokCatalogData>;
  lexiconState: LoadState<LexiconFile>;
  rolesState: LoadState<RolesFile>;

  // Layer rail counts (sourced from RootLayout)
  layerCounts: LayerCounts;

  // Dok catalog
  doks: Dok[];
  selectedDokId: string | null;
  setSelectedDok: (id: string | null) => void;
  filter: DokFilter;
  setFilter: (f: DokFilter) => void;
  // Axis filters are separate state, not extra DokFilter members: they are
  // orthogonal to status, and folding them in would make "draft AND revenue"
  // unexpressible.
  impactFilter: BusinessImpact | 'all';
  setImpactFilter: (f: BusinessImpact | 'all') => void;
  blastFilter: BlastRadius | 'all';
  setBlastFilter: (f: BlastRadius | 'all') => void;
  sort: DokSort;
  setSort: (s: DokSort) => void;

  // Lexicon catalog
  lexicon: LexiconTerm[];
  projectLocales: readonly string[];
  selectedTermId: string | null;
  setSelectedTerm: (id: string | null) => void;
  activeLocales: string[];
  toggleLocale: (loc: string) => void;
  missingOnly: boolean;
  setMissingOnly: (b: boolean) => void;

  // IA catalog
  iaTrees: StudioIaTree[];
  selectedIaTreeKey: string | null;
  setSelectedIaTreeKey: (key: string | null) => void;
  selectedIaNodeKey: string | null;
  setSelectedIaNodeKey: (key: string | null) => void;
  expandedIaNodeKeys: Set<string>;
  toggleIaNodeExpanded: (key: string) => void;
  routeFilter: IaFilter;
  setRouteFilter: (f: IaFilter) => void;
  /** Which IA view is active. Overview is the default — the PM/designer
   *  entry scenario (PRODUCT.md). Tree is the precise-edit view. */
  iaView: IaView;
  setIaView: (v: IaView) => void;
  /** Maximum depth rendered by the active IA view. 1 = roots only,
   *  IA_DEPTH_MAX = render the whole subtree. Shared between Overview
   *  and Tree so switching views keeps the same focus level. */
  iaDepth: number;
  setIaDepth: (n: number) => void;

  // Roles catalog (real workspace roles.json)
  roles: Role[];
  selectedRoleId: string | null;
  setSelectedRoleId: (id: string | null) => void;

  // Phase 8 — Command palette + cross-layer history
  paletteOpen: boolean;
  paletteCrossLayer: boolean;
  paletteQuery: string;
  setPaletteQuery: (q: string) => void;
  openPalette: (opts?: { crossLayer?: boolean; initialQuery?: string }) => void;
  closePalette: () => void;
  /** Recent cross-layer jumps, newest first, capped at 10. Lets the
   *  palette empty state suggest the last few places the user landed. */
  recentJumps: RecentJump[];
  pushRecentJump: (j: RecentJump) => void;

  // Phase 9 — Dok editor (single-item deep edit)
  /** The Dok currently being edited at /doks/[id]. null when the user
   *  is anywhere outside the editor. The doks-editor page sets this on
   *  mount and clears it on unmount. dok-edit-sidebar reads it to
   *  surface field-specific guidance without prop drilling. */
  editingDok: Dok | null;
  setEditingDok: (dok: Dok | null) => void;
  /** Local draft update for the editing Dok. The editor separately queues
   *  the authorized narrow patch through the durable save coordinator. */
  updateEditingDok: (patch: Partial<Dok>) => void;
  /** Meta block expand state (one boolean per editor — folded by default
   *  per design brief §5). Shared by dok-editor and lexicon-editor since
   *  only one editor is mounted at a time. */
  metaExpanded: boolean;
  setMetaExpanded: (v: boolean) => void;

  // Phase 10 — Lexicon editor (single-term deep edit). Mirrors
  // editingDok shape; lives in the same store so dynamic SmartSidebar
  // can subscribe without caring which editor is active.
  editingTerm: LexiconTerm | null;
  setEditingTerm: (term: LexiconTerm | null) => void;
  updateEditingTerm: (patch: Partial<LexiconTerm>) => void;

  // Phase 11 — Role editor (single-role deep edit). Mirrors editingDok /
  // editingTerm — seeded on mount from the workspace roles.json entry.
  editingRole: Role | null;
  setEditingRole: (role: Role | null) => void;
  updateEditingRole: (patch: Partial<Role>) => void;
}

/** A single cross-layer jump remembered for the palette's "recent" list. */
export interface RecentJump {
  kind: 'dok' | 'term' | 'route' | 'role';
  id: string;
  label?: string;
  iaTarget?: IaJumpTarget;
  at: number;
}

const PALETTE_RECENT_MAX = 10;

interface IaCatalogSelection {
  treeKey: string | null;
  nodeKey: string | null;
  expandedKeys: Set<string>;
}

function iaNodeKeys(nodes: readonly StudioIaNode[]): Set<string> {
  const keys = new Set<string>();
  const visit = (node: StudioIaNode) => {
    keys.add(node.key);
    node.children.forEach(visit);
  };
  nodes.forEach(visit);
  return keys;
}

function iaNodeAncestorKeys(
  nodes: readonly StudioIaNode[],
  key: string,
  ancestors: readonly string[] = [],
): string[] | null {
  for (const node of nodes) {
    if (node.key === key) return [...ancestors];
    const childAncestors = iaNodeAncestorKeys(
      node.children,
      key,
      [...ancestors, node.key],
    );
    if (childAncestors) return childAncestors;
  }
  return null;
}

function rootExpansion(tree: StudioIaTree | null): Set<string> {
  return new Set(tree?.nodes.map((node) => node.key) ?? []);
}

function reconcileIaCatalogSelection(
  current: IaCatalogSelection,
  trees: readonly StudioIaTree[],
): IaCatalogSelection {
  const selected = trees.find((tree) => tree.key === current.treeKey) ?? null;
  if (!selected) {
    const fallback = selectDefaultIaTree(trees);
    const expandedKeys = rootExpansion(fallback);
    if (
      current.treeKey === (fallback?.key ?? null) &&
      current.nodeKey === null &&
      current.expandedKeys.size === expandedKeys.size &&
      [...expandedKeys].every((key) => current.expandedKeys.has(key))
    ) {
      return current;
    }
    return {
      treeKey: fallback?.key ?? null,
      nodeKey: null,
      expandedKeys,
    };
  }

  const validKeys = iaNodeKeys(selected.nodes);
  const nodeKey =
    current.nodeKey !== null && validKeys.has(current.nodeKey)
      ? current.nodeKey
      : null;
  const hasStaleExpansion = [...current.expandedKeys].some(
    (key) => !validKeys.has(key),
  );
  if (nodeKey === current.nodeKey && !hasStaleExpansion) return current;
  return {
    treeKey: current.treeKey,
    nodeKey,
    expandedKeys: hasStaleExpansion
      ? new Set(
          [...current.expandedKeys].filter((key) => validKeys.has(key)),
        )
      : current.expandedKeys,
  };
}

const StudioContext = createContext<StudioState | null>(null);

// Stable empty fallbacks — shared module-level identities so a workspace
// missing a given layer doesn't hand StudioProvider a fresh [] on every
// render (which would bust the context-value memo below). Real data always
// arrives via the initial* props from RootLayout.
const EMPTY_DOKS: Dok[] = [];
const EMPTY_LEXICON: LexiconTerm[] = [];
const EMPTY_ROLES: Role[] = [];
const EMPTY_IA_TREES: StudioIaTree[] = [];
// Schema default for workspace.supported_locales — used when no workspace
// config is present (standalone dev / tests).
const DEFAULT_PROJECT_LOCALES: readonly string[] = ['en', 'ko'];
const DEFAULT_WORKSPACE_STATE: LoadState<Workspace> = {
  kind: 'missing',
  path: 'workspace.json',
};
const DEFAULT_DOKS_STATE: LoadState<DokCatalogData> = {
  kind: 'missing',
  path: '.doklo/hub/doks',
};
const DEFAULT_LEXICON_STATE: LoadState<LexiconFile> = {
  kind: 'missing',
  path: '.doklo/hub/lexicon.json',
};
const DEFAULT_ROLES_STATE: LoadState<RolesFile> = {
  kind: 'missing',
  path: '.doklo/hub/roles.json',
};

/** Resolve the Lexicon catalog source: the real workspace terms when
 *  RootLayout supplies a non-empty list, else an empty catalog (the screen
 *  renders its empty state). Exported so the fallback semantics can be
 *  unit-tested directly — the Studio test env is node-only (no DOM), so
 *  this is the seam that stands in for rendering the provider. */
export function resolveLexicon(initialLexicon?: LexiconTerm[]): LexiconTerm[] {
  return initialLexicon && initialLexicon.length > 0
    ? initialLexicon
    : EMPTY_LEXICON;
}

export function StudioProvider({
  children,
  layerCounts,
  initialDoks,
  initialLexicon,
  initialRoles,
  initialIaTrees,
  projectLocales: projectLocalesProp,
  workspaceState = DEFAULT_WORKSPACE_STATE,
  doksState = DEFAULT_DOKS_STATE,
  lexiconState = DEFAULT_LEXICON_STATE,
  rolesState = DEFAULT_ROLES_STATE,
}: {
  children: ReactNode;
  layerCounts: LayerCounts;
  /** Real workspace Doks loaded server-side by RootLayout. When omitted or
   *  empty (standalone dev / tests / a workspace with no doks yet), the
   *  catalog is empty and the screen renders its empty state. */
  initialDoks?: Dok[];
  /** Real workspace Lexicon terms loaded server-side by RootLayout. When
   *  omitted or empty, the lexicon catalog is empty. */
  initialLexicon?: LexiconTerm[];
  /** Real workspace roles.json entries loaded server-side by RootLayout. */
  initialRoles?: Role[];
  /** Typed per-service IA trees loaded and adapted server-side. */
  initialIaTrees?: StudioIaTree[];
  /** workspace.supported_locales — the UI locales the Lexicon tracks.
   *  Falls back to the schema default ['en','ko']. */
  projectLocales?: string[];
  workspaceState?: LoadState<Workspace>;
  doksState?: LoadState<DokCatalogData>;
  lexiconState?: LoadState<LexiconFile>;
  rolesState?: LoadState<RolesFile>;
}) {
  // Catalog sources of truth: real workspace data when provided, else empty.
  // Selectors (useDoks/useDokStats/useRoles/…) read these arrays from the
  // store, so swapping them flows to the whole catalog, header stats, and
  // grouping.
  const doks = doksState.kind === 'ready' || doksState.kind === 'empty'
    ? doksState.data.doks
    : initialDoks ?? EMPTY_DOKS;
  const lexicon = lexiconState.kind === 'ready' || lexiconState.kind === 'empty'
    ? lexiconState.data.terms
    : resolveLexicon(initialLexicon);
  const roles = rolesState.kind === 'ready' || rolesState.kind === 'empty'
    ? rolesState.data.roles
    : initialRoles ?? EMPTY_ROLES;
  const iaTrees = initialIaTrees ?? EMPTY_IA_TREES;
  const defaultIaTree = selectDefaultIaTree(iaTrees);
  const projectLocales =
    workspaceState.kind === 'ready' || workspaceState.kind === 'empty'
      ? workspaceState.data.supported_locales
      : projectLocalesProp ?? DEFAULT_PROJECT_LOCALES;

  const [focusedField, setFocusedField] = useState<FocusedField>(null);
  const [saveStatus, setSaveStatus] = useState<SaveStatus>({ kind: 'idle' });
  const [pendingSave, setPendingSave] =
    useState<PendingSaveRegistration | null>(null);
  const pendingSaveRef = useRef<PendingSaveRegistration | null>(null);
  const pendingOperationActiveRef = useRef(false);
  const pendingOperationQueueRef = useRef<Array<() => void>>([]);
  const pendingClaimVersionRef = useRef(0);

  // Claims and public navigation flushes share one FIFO mutex. Idle work
  // starts synchronously so existing click/keyboard timing stays intact.
  const runPendingSaveOperation = useCallback(
    <T,>(operation: () => Promise<T> | T): Promise<T> =>
      new Promise<T>((resolveOperation, rejectOperation) => {
        const finishOperation = () => {
          const next = pendingOperationQueueRef.current.shift();
          if (next) next();
          else pendingOperationActiveRef.current = false;
        };
        const runOperation = () => {
          pendingOperationActiveRef.current = true;
          let result: Promise<T>;
          try {
            result = Promise.resolve(operation());
          } catch (error) {
            rejectOperation(error);
            finishOperation();
            return;
          }
          void result.then(
            (value) => {
              resolveOperation(value);
              finishOperation();
            },
            (error: unknown) => {
              rejectOperation(error);
              finishOperation();
            },
          );
        };

        if (pendingOperationActiveRef.current) {
          pendingOperationQueueRef.current.push(runOperation);
        } else {
          runOperation();
        }
      }),
    [],
  );

  const registerPendingSave = useCallback(
    (pending: PendingSaveRegistration | null) => {
      pendingSaveRef.current = pending;
      setPendingSave(pending);
    },
    [],
  );
  const claimPendingSave = useCallback(
    async (pending: PendingSaveRegistration): Promise<boolean> => {
      pendingClaimVersionRef.current += 1;
      return runPendingSaveOperation(async () => {
        const current = pendingSaveRef.current;
        if (current === pending) return true;
        if (current) {
          let flushed = false;
          try {
            // We already own the mutex; routing through the public queued
            // flush here would wait on this claim and deadlock.
            flushed = await current.flush();
          } catch {
            return false;
          }
          if (!flushed) return false;
          if (pendingSaveRef.current === current) {
            pendingSaveRef.current = null;
            setPendingSave((owned) => owned === current ? null : owned);
          }
        }

        // A synchronous registration outside the serialized claim path may
        // have appeared while the previous owner was flushing. Never replace it.
        if (pendingSaveRef.current !== null) return false;
        pendingSaveRef.current = pending;
        setPendingSave(pending);
        return true;
      });
    },
    [runPendingSaveOperation],
  );
  const replacePendingSave = useCallback(
    (
      current: PendingSaveRegistration,
      replacement: PendingSaveRegistration,
    ): boolean => {
      if (pendingSaveRef.current !== current) return false;
      pendingSaveRef.current = replacement;
      setPendingSave((owned) => owned === current ? replacement : owned);
      return true;
    },
    [],
  );
  const unregisterPendingSave = useCallback(
    (pending: PendingSaveRegistration) => {
      if (pendingSaveRef.current !== pending) return;
      pendingSaveRef.current = null;
      setPendingSave((current) => current === pending ? null : current);
    },
    [],
  );
  const flushPendingSave = useCallback(async () => {
    while (true) {
      const claimVersion = pendingClaimVersionRef.current;
      const flushed = await runPendingSaveOperation(async () => {
        const pending = pendingSaveRef.current;
        if (!pending) return true;
        try {
          return await pending.flush();
        } catch {
          return false;
        }
      });
      if (!flushed) return false;
      // A claim queued during our flush runs ahead of the next iteration.
      // Repeat so navigation also flushes that newly claimed owner.
      if (pendingClaimVersionRef.current === claimVersion) return true;
    }
  }, [runPendingSaveOperation]);

  // Dok slice — selection defaults to the first catalog Dok.
  const [selectedDokId, setSelectedDok] = useState<string | null>(
    doks[0]?.dok_id ?? null,
  );
  const [filter, setFilter] = useState<DokFilter>('all');
  const [impactFilter, setImpactFilter] = useState<BusinessImpact | 'all'>('all');
  const [blastFilter, setBlastFilter] = useState<BlastRadius | 'all'>('all');
  const [sort, setSort] = useState<DokSort>('priority');

  // Lexicon slice — Phase 5. Default selection = first catalog term.
  const [selectedTermId, setSelectedTerm] = useState<string | null>(
    lexicon[0]?.term_id ?? null,
  );
  const [activeLocales, setActiveLocales] = useState<string[]>([
    ...projectLocales,
  ]);
  const [missingOnly, setMissingOnly] = useState(false);

  // IA slice. Keep the related identity and expansion fields atomic so a
  // changing server catalog cannot expose a stale tree/node combination.
  const [iaSelection, setIaSelection] = useState<IaCatalogSelection>(() => ({
    treeKey: defaultIaTree?.key ?? null,
    nodeKey: null,
    expandedKeys: rootExpansion(defaultIaTree),
  }));
  const selectedIaTreeKey = iaSelection.treeKey;
  const selectedIaNodeKey = iaSelection.nodeKey;
  const expandedIaNodeKeys = iaSelection.expandedKeys;
  const [routeFilter, setRouteFilter] = useState<IaFilter>('all');
  const [iaView, setIaView] = useState<IaView>('overview');
  const [iaDepth, setIaDepthRaw] = useState<number>(IA_DEPTH_DEFAULT);

  useEffect(() => {
    setIaSelection((current) =>
      reconcileIaCatalogSelection(current, iaTrees),
    );
  }, [iaTrees]);

  const setSelectedIaTreeKey = useCallback((key: string | null) => {
    const tree = iaTrees.find((candidate) => candidate.key === key);
    const resolvedKey = tree?.key ?? null;
    setIaSelection((current) => {
      if (current.treeKey === resolvedKey) return current;
      return {
        treeKey: resolvedKey,
        nodeKey: null,
        expandedKeys: rootExpansion(tree ?? null),
      };
    });
  }, [iaTrees]);
  const setSelectedIaNodeKey = useCallback((key: string | null) => {
    setIaSelection((current) => {
      const tree = iaTrees.find(
        (candidate) => candidate.key === current.treeKey,
      );
      const ancestorKeys =
        key !== null && tree
          ? iaNodeAncestorKeys(tree.nodes, key)
          : null;
      const needsExpansion = ancestorKeys?.some(
        (ancestorKey) => !current.expandedKeys.has(ancestorKey),
      ) ?? false;
      if (current.nodeKey === key && !needsExpansion) return current;
      const expandedKeys = needsExpansion
        ? new Set(current.expandedKeys)
        : current.expandedKeys;
      ancestorKeys?.forEach((ancestorKey) => expandedKeys.add(ancestorKey));
      return { ...current, nodeKey: key, expandedKeys };
    });
  }, [iaTrees]);
  const toggleIaNodeExpanded = useCallback((key: string) => {
    setIaSelection((current) => {
      const next = new Set(current.expandedKeys);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return { ...current, expandedKeys: next };
    });
  }, []);
  // Clamp + ignore invalid values — the slider/URL/keyboard all funnel
  // through this setter so clamping in one place is enough.
  const setIaDepth = useCallback((n: number) => {
    if (!Number.isFinite(n)) return;
    const clamped = Math.max(IA_DEPTH_MIN, Math.min(IA_DEPTH_MAX, Math.round(n)));
    setIaDepthRaw(clamped);
  }, []);

  // Roles slice. Selection defaults to the first catalog role (role_id
  // order, matching useRoles()) so the hub lands on a real workspace role.
  const [selectedRoleId, setSelectedRoleId] = useState<string | null>(
    () =>
      [...roles].sort((a, b) => a.role_id.localeCompare(b.role_id))[0]
        ?.role_id ?? null,
  );

  // Palette + cross-layer history (Phase 8).
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [paletteCrossLayer, setPaletteCrossLayer] = useState(false);
  const [paletteQuery, setPaletteQuery] = useState('');
  const [recentJumps, setRecentJumps] = useState<RecentJump[]>([]);

  // Dok editor (Phase 9). editingDok lives at provider scope so the
  // dynamic SmartSidebar can subscribe without prop drilling.
  const [editingDok, setEditingDok] = useState<Dok | null>(null);
  const updateEditingDok = useCallback((patch: Partial<Dok>) => {
    setEditingDok((prev) => (prev ? ({ ...prev, ...patch } as Dok) : prev));
  }, []);
  const [metaExpanded, setMetaExpanded] = useState(false);

  // Lexicon editor (Phase 10). Parallels editingDok exactly — same
  // mount/unmount contract from the /lexicon/[id] page.
  const [editingTerm, setEditingTerm] = useState<LexiconTerm | null>(null);
  const updateEditingTerm = useCallback((patch: Partial<LexiconTerm>) => {
    setEditingTerm((prev) =>
      prev ? ({ ...prev, ...patch } as LexiconTerm) : prev,
    );
  }, []);
  // Role editor (Phase 11). Same mount/unmount contract from /roles/[id].
  const [editingRole, setEditingRole] = useState<Role | null>(null);
  const updateEditingRole = useCallback((patch: Partial<Role>) => {
    setEditingRole((prev) => (prev ? ({ ...prev, ...patch } as Role) : prev));
  }, []);
  const openPalette = useCallback(
    (opts?: { crossLayer?: boolean; initialQuery?: string }) => {
      setPaletteCrossLayer(opts?.crossLayer ?? false);
      setPaletteQuery(opts?.initialQuery ?? '');
      setPaletteOpen(true);
    },
    [],
  );
  const closePalette = useCallback(() => setPaletteOpen(false), []);
  const pushRecentJump = useCallback((j: RecentJump) => {
    setRecentJumps((prev) => {
      // de-dup by kind+id (newest wins), then cap
      const without = prev.filter((p) => !(p.kind === j.kind && p.id === j.id));
      return [j, ...without].slice(0, PALETTE_RECENT_MAX);
    });
  }, []);

  const toggleLocale = useCallback((loc: string) => {
    setActiveLocales((prev) =>
      prev.includes(loc) ? prev.filter((l) => l !== loc) : [...prev, loc],
    );
  }, []);

  // Memoize the context value so consumers whose selectors depend only on
  // a slice of state don't re-render when an unrelated slice changes.
  // Without this, every state update spawns a fresh object identity and
  // breaks every downstream useMemo(..., [studioValue]).
  const value = useMemo<StudioState>(
    () => ({
      focusedField,
      setFocusedField,
      saveStatus,
      setSaveStatus,
      pendingSave,
      registerPendingSave,
      claimPendingSave,
      replacePendingSave,
      unregisterPendingSave,
      flushPendingSave,
      workspaceState,
      doksState,
      lexiconState,
      rolesState,
      layerCounts,
      doks,
      selectedDokId,
      setSelectedDok,
      filter,
      setFilter,
      impactFilter,
      setImpactFilter,
      blastFilter,
      setBlastFilter,
      sort,
      setSort,
      lexicon,
      projectLocales,
      selectedTermId,
      setSelectedTerm,
      activeLocales,
      toggleLocale,
      missingOnly,
      setMissingOnly,
      iaTrees,
      selectedIaTreeKey,
      setSelectedIaTreeKey,
      selectedIaNodeKey,
      setSelectedIaNodeKey,
      expandedIaNodeKeys,
      toggleIaNodeExpanded,
      routeFilter,
      setRouteFilter,
      iaView,
      setIaView,
      iaDepth,
      setIaDepth,
      roles,
      selectedRoleId,
      setSelectedRoleId,
      paletteOpen,
      paletteCrossLayer,
      paletteQuery,
      setPaletteQuery,
      openPalette,
      closePalette,
      recentJumps,
      pushRecentJump,
      editingDok,
      setEditingDok,
      updateEditingDok,
      metaExpanded,
      setMetaExpanded,
      editingTerm,
      setEditingTerm,
      updateEditingTerm,
      editingRole,
      setEditingRole,
      updateEditingRole,
    }),
    [
      focusedField,
      saveStatus,
      pendingSave,
      registerPendingSave,
      claimPendingSave,
      replacePendingSave,
      unregisterPendingSave,
      flushPendingSave,
      workspaceState,
      doksState,
      lexiconState,
      rolesState,
      layerCounts,
      doks,
      lexicon,
      projectLocales,
      selectedDokId,
      filter,
      impactFilter,
      blastFilter,
      sort,
      selectedTermId,
      activeLocales,
      toggleLocale,
      missingOnly,
      iaTrees,
      selectedIaTreeKey,
      setSelectedIaTreeKey,
      selectedIaNodeKey,
      expandedIaNodeKeys,
      toggleIaNodeExpanded,
      routeFilter,
      iaView,
      iaDepth,
      setIaDepth,
      roles,
      selectedRoleId,
      paletteOpen,
      paletteCrossLayer,
      paletteQuery,
      openPalette,
      closePalette,
      recentJumps,
      pushRecentJump,
      editingDok,
      updateEditingDok,
      metaExpanded,
      editingTerm,
      updateEditingTerm,
      editingRole,
      updateEditingRole,
    ],
  );

  return <StudioContext.Provider value={value}>{children}</StudioContext.Provider>;
}

export function useStudio(): StudioState {
  const ctx = useContext(StudioContext);
  if (!ctx) {
    throw new Error('useStudio() must be used inside <StudioProvider>');
  }
  return ctx;
}

// ──────────────────────────────────────────────────────────────────────
// Derived selectors. Each one memoizes on its own inputs so a row-click
// (selectedDokId change) doesn't reshuffle the catalog group computation.
// ──────────────────────────────────────────────────────────────────────

export interface DokStats {
  total: number;
  active: number;
  draft: number;
  review: number;
  domains: number;
  /** Mean of `_meta.generation_confidence` across active doks, or null
   *  if none have a confidence value. */
  avg_confidence: number | null;
}

/** Filter + sort applied. */
export function useDoks(): Dok[] {
  const { doks, filter, sort, impactFilter, blastFilter } = useStudio();
  return useMemo(() => {
    let result = doks;

    if (filter !== 'all') {
      result = result.filter((d) => matchesFilter(d, filter));
    }
    // An unjudged Dok has made no claim on either axis, so an active axis
    // filter excludes it rather than assuming a value on its behalf. (Sorting
    // does give it a mid-pack slot — sorting must place everything, filtering
    // passes only what is actually claimed.)
    if (impactFilter !== 'all') {
      result = result.filter((d) => d.priority?.impact === impactFilter);
    }
    if (blastFilter !== 'all') {
      result = result.filter((d) => d.priority?.blast_radius === blastFilter);
    }

    const sorted = [...result];
    if (sort === 'priority') {
      sorted.sort(comparePriority);
    } else if (sort === 'id') {
      sorted.sort((a, b) => a.dok_id.localeCompare(b.dok_id));
    } else {
      // 'recent' — newest updated_at first; falls back to id when missing
      sorted.sort((a, b) => {
        const ta = a._meta.updated_at ?? '';
        const tb = b._meta.updated_at ?? '';
        if (ta === tb) return a.dok_id.localeCompare(b.dok_id);
        return tb.localeCompare(ta);
      });
    }
    return sorted;
  }, [doks, filter, sort, impactFilter, blastFilter]);
}

/** Filter + sort applied, then grouped by domain prefix. Group order
 *  preserves first-appearance in the filtered list. */
export function useDoksByDomain(): [string, Dok[]][] {
  const doks = useDoks();
  return useMemo(() => {
    const map = new Map<string, Dok[]>();
    for (const d of doks) {
      const key = dokDomain(d.dok_id);
      const bucket = map.get(key);
      if (bucket) bucket.push(d);
      else map.set(key, [d]);
    }
    return Array.from(map.entries());
  }, [doks]);
}

export function useSelectedDok(): Dok | null {
  const { doks, selectedDokId } = useStudio();
  return useMemo(
    () => doks.find((d) => d.dok_id === selectedDokId) ?? null,
    [doks, selectedDokId],
  );
}

export function useDokStats(): DokStats {
  const { doks } = useStudio();
  return useMemo(() => {
    const total = doks.length;
    const active = doks.filter((d) => d.status === 'active').length;
    const draft = doks.filter((d) => d.status === 'draft').length;
    const review = doks.filter((d) => d.status === 'review').length;

    const domains = new Set(doks.map((d) => dokDomain(d.dok_id))).size;

    const confidences = doks
      .filter((d) => d.status === 'active')
      .map((d) => d._meta.generation_confidence)
      .filter((c): c is number => typeof c === 'number');
    const avg_confidence =
      confidences.length === 0
        ? null
        : confidences.reduce((s, c) => s + c, 0) / confidences.length;

    return { total, active, draft, review, domains, avg_confidence };
  }, [doks]);
}

function matchesFilter(dok: Dok, filter: Exclude<DokFilter, 'all'>): boolean {
  return dok.status === filter;
}

// ──────────────────────────────────────────────────────────────────────
// Lexicon selectors
// ──────────────────────────────────────────────────────────────────────

export interface LexiconStats {
  total: number;
  i18n: number;
  constant: number;
  owned: number;
  /** Count of (term, project-locale) pairs where the locale has no text. */
  missing: number;
}

/** Filter applied (missingOnly only). Order follows the store's term
 *  order (workspace file / fixture order) — the catalog renders a flat
 *  list, so category grouping is gone. */
export function useFilteredTerms(): LexiconTerm[] {
  const { lexicon, missingOnly, projectLocales } = useStudio();
  return useMemo(() => {
    let r = lexicon;
    if (missingOnly) {
      r = r.filter((t) => hasMissingLocale(t, projectLocales));
    }
    return r;
  }, [lexicon, missingOnly, projectLocales]);
}

export function useSelectedTerm(): LexiconTerm | null {
  const { lexicon, selectedTermId } = useStudio();
  return useMemo(
    () => lexicon.find((t) => t.term_id === selectedTermId) ?? null,
    [lexicon, selectedTermId],
  );
}

/** Pure Lexicon stats. Extracted from the hook so the missing-locale
 *  aggregation is unit-testable without rendering the provider (the Studio
 *  test env is node-only). i18n-bound terms are skipped in the missing
 *  count — their display text lives in workspace i18n files Studio has no
 *  reader for yet, so it can't judge them missing. */
export function lexiconStatsOf(
  terms: LexiconTerm[],
  projectLocales: readonly string[],
): LexiconStats {
  const total = terms.length;
  let i18n = 0;
  let constant = 0;
  let owned = 0;
  let missing = 0;
  for (const t of terms) {
    if (t.binding.type === 'i18n') {
      i18n++;
      continue; // Studio can't resolve i18n text → never counts as missing
    }
    if (t.binding.type === 'constant') constant++;
    else owned++;
    for (const loc of projectLocales) {
      if (termDisplay(t, loc) == null) missing++;
    }
  }
  return { total, i18n, constant, owned, missing };
}

export function useLexiconStats(): LexiconStats {
  const { lexicon, projectLocales } = useStudio();
  return useMemo(
    () => lexiconStatsOf(lexicon, projectLocales),
    [lexicon, projectLocales],
  );
}

function hasMissingLocale(
  term: LexiconTerm,
  projectLocales: readonly string[],
): boolean {
  // i18n-bound terms have no Studio-resolvable text → never "missing".
  if (term.binding.type === 'i18n') return false;
  return projectLocales.some((loc) => termDisplay(term, loc) == null);
}

// ──────────────────────────────────────────────────────────────────────
// IA selectors
// ──────────────────────────────────────────────────────────────────────

export function useSelectedIaTree(): StudioIaTree | null {
  const { iaTrees, selectedIaTreeKey } = useStudio();
  return useMemo(
    () => iaTrees.find((tree) => tree.key === selectedIaTreeKey) ?? null,
    [iaTrees, selectedIaTreeKey],
  );
}

export function useSelectedIaNode(): StudioIaNode | null {
  const tree = useSelectedIaTree();
  const { selectedIaNodeKey } = useStudio();
  return useMemo(
    () =>
      tree && selectedIaNodeKey
        ? findIaNode(tree.nodes, selectedIaNodeKey)
        : null,
    [tree, selectedIaNodeKey],
  );
}

export function useIaStats(): IaStats {
  const tree = useSelectedIaTree();
  return useMemo(
    () => tree ? iaStats(tree) : EMPTY_IA_STATS,
    [tree],
  );
}

// ──────────────────────────────────────────────────────────────────────
// Roles selectors
// ──────────────────────────────────────────────────────────────────────

/** The real workspace roles.json catalog, sorted by role_id. */
export function useRoles(): Role[] {
  const { roles } = useStudio();
  return useMemo(
    () => [...roles].sort((a, b) => a.role_id.localeCompare(b.role_id)),
    [roles],
  );
}

/** Doks whose user_actions name this role as an actor — i.e. some step has
 *  `actor = { kind: 'role', role_ref: roleId }`. Powers the role editor's
 *  "referenced by" reverse lookup. Empty for a null id. */
export function useRoleActorDoks(roleId: string | null): Dok[] {
  const { doks } = useStudio();
  return useMemo(() => {
    if (!roleId) return [];
    return doks.filter((d) =>
      d.user_actions?.steps.some(
        (s) => s.actor.kind === 'role' && s.actor.role_ref === roleId,
      ),
    );
  }, [doks, roleId]);
}

/** Kind and scope distributions + code-anchor coverage across the roles catalog.
 *  All counts derive from the real roles.json — there is no permission or
 *  usage data in the v5 Role schema to aggregate. */
export interface RoleStats {
  total: number;
  access: number;
  actorType: number;
  global: number;
  tenant: number;
  resource: number;
  withAnchor: number;
}

/** The currently selected workspace role, or null when nothing matches
 *  (e.g. an empty catalog, or a stale selection after a workspace swap). */
export function useSelectedRole(): Role | null {
  const { roles, selectedRoleId } = useStudio();
  return useMemo(
    () => roles.find((r) => r.role_id === selectedRoleId) ?? null,
    [roles, selectedRoleId],
  );
}

export function useRoleStats(): RoleStats {
  const { roles } = useStudio();
  return useMemo(() => {
    let access = 0;
    let actorType = 0;
    let global = 0;
    let tenant = 0;
    let resource = 0;
    let withAnchor = 0;
    for (const r of roles) {
      if (r.kind === 'access') access++;
      else if (r.kind === 'actor_type') actorType++;
      if (r.scope === 'global') global++;
      else if (r.scope === 'tenant') tenant++;
      else if (r.scope === 'resource') resource++;
      if (r.code_anchor) withAnchor++;
    }
    return {
      total: roles.length,
      access,
      actorType,
      global,
      tenant,
      resource,
      withAnchor,
    };
  }, [roles]);
}

/** Resolve a role's display name. Inline strings render verbatim; a
 *  TermRef is resolved through the Lexicon (first non-null across the
 *  given locales) and falls back to the role_id when the term — or its
 *  text — is missing. Client-side mirror of lib/data.ts#roleDisplayName
 *  (that one is server-only); kept here rather than in lib/term-display.ts
 *  so the shared term util stays role-agnostic. */
export function resolveRoleName(
  role: Role,
  lexicon: LexiconTerm[],
  locales: readonly string[],
): string {
  const { name } = role;
  if (typeof name === 'string') return name;
  const term = lexicon.find((t) => t.term_id === name.term_ref);
  if (!term) return role.role_id;
  for (const loc of locales) {
    const text = termDisplay(term, loc);
    if (text != null) return text;
  }
  return role.role_id;
}

// Re-export for convenience so pages can import everything from the store
export { termDisplay, termSupportedLocales };
export type {
  IaFilter,
  IaJumpTarget,
  IaStats,
  Platform,
  StudioIaNode,
  StudioIaTree,
};
