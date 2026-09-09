import type {
  StudioIaBinding,
  StudioIaEvidence,
  StudioIaNode,
  StudioIaTree,
} from '../../lib/ia-route.js';

interface TreeFixtureOptions {
  key: string;
  serviceId?: string;
  type?: StudioIaTree['type'];
  source?: StudioIaTree['source'];
  path?: string;
  nestedUnmapped?: boolean;
}

function node(
  key: string,
  path: string | undefined,
  title: string,
  dokRef: string | null | undefined,
  children: StudioIaNode[] = [],
): StudioIaNode {
  return {
    key,
    path,
    seg: path?.split('/').filter(Boolean).at(-1) ?? '',
    title,
    ...(dokRef === undefined ? {} : { dok_ref: dokRef }),
    platform: 'both',
    tags: [],
    unmapped: path !== undefined && dokRef === undefined,
    children,
  };
}

export function treeFixture(options: TreeFixtureOptions): StudioIaTree {
  const [keyService, keyTree] = options.key.split('::');
  const serviceId = options.serviceId ?? keyService ?? 'web';
  const treeId = keyTree ?? 'map';
  const child = options.nestedUnmapped
    ? [
        node(
          `${options.key}/child`,
          '/group/unmapped',
          'Unmapped child',
          undefined,
        ),
      ]
    : [];
  return {
    key: options.key,
    serviceId,
    treeId,
    type: options.type ?? 'sitemap',
    source: options.source ?? 'auto',
    platform: 'both',
    nodes: [
      node(
        `${options.key}/root`,
        options.path ?? '/group',
        'Group',
        'AUTH-SIGNIN',
        child,
      ),
    ],
  };
}

// ── v2 fixtures ────────────────────────────────────────────────────────
// v2 nodes carry `kind`; destinations carry bindings (with provenance),
// producer evidence, and the curated-field list. Groups mirror the v1
// container tri-state (`dok_ref: null`) so page counting stays version
// agnostic.

function destination(
  key: string,
  path: string,
  title: string,
  bindings: StudioIaBinding[],
  evidence?: StudioIaEvidence[],
  curatedFields: string[] = [],
): StudioIaNode {
  return {
    key,
    path,
    seg: path.split('/').filter(Boolean).at(-1) ?? '',
    title,
    kind: 'destination',
    bindings,
    ...(evidence === undefined ? {} : { evidence }),
    curatedFields,
    platform: 'both',
    tags: [],
    unmapped: bindings.length === 0,
    children: [],
  };
}

function group(
  key: string,
  path: string | undefined,
  title: string,
  children: StudioIaNode[],
  curatedFields: string[] = [],
): StudioIaNode {
  return {
    key,
    path,
    seg: path?.split('/').filter(Boolean).at(-1) ?? '',
    title,
    kind: 'group',
    dok_ref: null,
    curatedFields,
    platform: 'both',
    tags: [],
    unmapped: false,
    children,
  };
}

/** Producer-owned v2 tree: evidence on every destination, one manual binding. */
export function routeHierarchyTree(): StudioIaTree {
  return {
    key: 'web::web-routes',
    serviceId: 'web',
    treeId: 'web-routes',
    type: 'route_hierarchy',
    source: 'auto',
    platform: 'both',
    nodes: [
      group('web::web-routes/auth', '/auth', 'Auth', [
        destination(
          'web::web-routes/auth/signin',
          '/auth/signin',
          'Sign in',
          [{ dokRef: 'AUTH-SIGNIN', source: 'auto' }],
          [{ file: 'app/auth/signin/page.tsx' }],
        ),
        destination(
          'web::web-routes/auth/reset',
          '/auth/recover-pw/:token',
          '비밀번호 재설정',
          [{ dokRef: 'AUTH-RESET', source: 'manual' }],
          [{ file: 'app/auth/recover-pw/[token]/page.tsx' }],
          ['label'],
        ),
        destination(
          'web::web-routes/auth/unmapped',
          '/auth/unmapped',
          'Unmapped destination',
          [],
          [{ file: 'app/auth/unmapped/page.tsx' }],
        ),
      ]),
      destination(
        'web::web-routes/programs',
        '/programs',
        'Programs',
        [{ dokRef: 'PROG', source: 'auto' }],
        [{ file: 'app/programs/page.tsx' }],
      ),
    ],
  };
}

/**
 * Container ancestry whose only unmapped destinations sit at depth 5, next to
 * a mapped top-level branch. Reproduces the shape where a shallow depth hides
 * every match a filter found.
 */
export function deepUnmappedTree(): StudioIaTree {
  const base = 'web::web-routes/program';
  const projectPath = '/program/:programId/project/:projectId';
  const leaves = ['analysis', 'mentoring', 'milestone'].map((seg) =>
    destination(`${base}/project/${seg}`, `${projectPath}/${seg}`, seg, []),
  );

  return {
    key: 'web::web-routes',
    serviceId: 'web',
    treeId: 'web-routes',
    type: 'route_hierarchy',
    source: 'auto',
    platform: 'both',
    nodes: [
      group(base, '/program', 'Program', [
        group(`${base}/id`, '/program/:programId', 'Program detail', [
          group(`${base}/project`, '/program/:programId/project', 'Project', [
            group(`${base}/project/id`, projectPath, 'Project detail', leaves),
          ]),
        ]),
      ]),
      destination(
        'web::web-routes/settings',
        '/settings',
        'Settings',
        [{ dokRef: 'SETTINGS', source: 'auto' }],
      ),
    ],
  };
}

/** Curated v2 tree: placements re-use a route path and never carry bindings. */
export function manualNavigationTree(): StudioIaTree {
  return {
    key: 'web::web-nav',
    serviceId: 'web',
    treeId: 'web-nav',
    type: 'navigation',
    source: 'manual',
    platform: 'both',
    nodes: [
      group(
        'web::web-nav/primary',
        undefined,
        'Primary menu',
        [
          destination(
            'web::web-nav/primary/signin',
            '/auth/signin',
            'Sign in entry',
            [],
            undefined,
            ['label'],
          ),
        ],
        ['label'],
      ),
    ],
  };
}

export function hierarchicalTree(): StudioIaTree {
  return {
    key: 'web::web-sitemap',
    serviceId: 'web',
    treeId: 'web-sitemap',
    type: 'sitemap',
    source: 'auto',
    platform: 'both',
    nodes: [
      node('web::web-sitemap/auth', '/auth', 'Auth', null, [
        node(
          'web::web-sitemap/auth/reset',
          '/auth/recover-pw/:token',
          '비밀번호 재설정',
          'AUTH-RESET',
        ),
        node(
          'web::web-sitemap/auth/unmapped',
          '/auth/unmapped',
          'Unmapped child',
          undefined,
        ),
      ]),
      node(
        'web::web-sitemap/programs',
        '/programs',
        'Programs',
        'PROG',
      ),
    ],
  };
}
