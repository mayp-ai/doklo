import { describe, it, expect } from 'vitest';
import {
  IaFileV2Schema,
  collectIaPlacementWarnings,
  parseIaFileAnyVersion,
} from '../src/schemas/ia.js';

// Contract rules R1..R8 of the IA v2 "Product Surface Model" spec are enforced
// by the schema and covered here.
//
// R9 (auto tree canonical id: `${serviceId}-routes`, then
// `${serviceId}-generated-routes`, then fail-closed) is a merge-layer rule: it
// only has meaning when an existing file meets a freshly derived one, so it is
// covered by the generator's ia-merge tests, not by a schema test.

type Json = Record<string, unknown>;

function routeDestination(overrides: Json = {}): Json {
  return {
    path: '/program',
    kind: 'destination',
    label: 'Programs',
    curated_fields: [],
    bindings: [{ dok_ref: 'PROG-LIST', source: 'auto' }],
    evidence: [{ kind: 'route_source', file: 'app/program/page.tsx' }],
    children: [],
    ...overrides,
  };
}

function routeTree(overrides: Json = {}): Json {
  return {
    tree_id: 'web-routes',
    type: 'route_hierarchy',
    source: 'auto',
    producer: 'doklo-route-hierarchy@1',
    platform: 'all',
    nodes: [routeDestination()],
    ...overrides,
  };
}

function curatedTree(overrides: Json = {}): Json {
  return {
    tree_id: 'web-main-navigation',
    type: 'navigation',
    source: 'manual',
    platform: 'all',
    nodes: [
      {
        kind: 'group',
        label: 'Programs',
        children: [{ kind: 'destination', path: '/program', label: 'Browse', children: [] }],
      },
    ],
    ...overrides,
  };
}

function iaFile(trees: Json[], overrides: Json = {}): Json {
  return { service_id: 'web', version: 2, trees, ...overrides };
}

describe('IA v2 contract rules', () => {
  it('R1 rejects the retired v1 tree types', () => {
    for (const type of ['sitemap', 'feature_group']) {
      const result = IaFileV2Schema.safeParse(iaFile([routeTree({ type })]));
      expect(result.success, `type ${type} must be rejected`).toBe(false);
    }
  });

  it('R1 accepts route_hierarchy, organization and navigation trees', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree(),
        curatedTree({ tree_id: 'web-areas', type: 'organization' }),
        curatedTree(),
      ]),
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.trees.map((tree) => tree.type)).toEqual([
      'route_hierarchy',
      'organization',
      'navigation',
    ]);
  });

  it('R2 rejects a destination without a path', () => {
    const pathless = routeDestination();
    delete pathless.path;

    const result = IaFileV2Schema.safeParse(iaFile([routeTree({ nodes: [pathless] })]));

    expect(result.success).toBe(false);
  });

  it('R2 rejects a group that carries bindings', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            {
              kind: 'group',
              path: '/program',
              label: 'Programs',
              bindings: [{ dok_ref: 'PROG-LIST', source: 'auto' }],
              children: [],
            },
          ],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('R2 rejects a group that carries evidence', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            {
              kind: 'group',
              path: '/program',
              label: 'Programs',
              evidence: [{ kind: 'route_source', file: 'app/program/layout.tsx' }],
              children: [routeDestination()],
            },
          ],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('R2 accepts a pathless group wrapping a path-carrying destination', () => {
    const result = IaFileV2Schema.safeParse(iaFile([routeTree(), curatedTree()]));

    expect(result.success).toBe(true);
    const group = result.success ? result.data.trees[1]?.nodes[0] : undefined;
    expect(group?.kind).toBe('group');
    expect(group && 'path' in group ? group.path : undefined).toBeUndefined();
    expect(group?.children[0]).toMatchObject({ kind: 'destination', path: '/program' });
  });

  it('R3 rejects non-empty bindings outside an auto route_hierarchy tree', () => {
    const withBinding = curatedTree({
      nodes: [
        {
          kind: 'destination',
          path: '/program',
          label: 'Browse',
          bindings: [{ dok_ref: 'PROG-LIST', source: 'manual' }],
          children: [],
        },
      ],
    });

    expect(IaFileV2Schema.safeParse(iaFile([routeTree(), withBinding])).success).toBe(false);

    // A manual route_hierarchy tree is not a surface definition point either.
    const manualRoutes = routeTree({ source: 'manual', tree_id: 'web-manual-routes' });
    expect(IaFileV2Schema.safeParse(iaFile([manualRoutes])).success).toBe(false);
  });

  it('R3 accepts bindings on an auto route_hierarchy destination and empty bindings elsewhere', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree(),
        curatedTree({
          nodes: [
            { kind: 'destination', path: '/program', label: 'Browse', bindings: [], children: [] },
          ],
        }),
      ]),
    );

    expect(result.success).toBe(true);
    const destination = result.success ? result.data.trees[0]?.nodes[0] : undefined;
    expect(destination && 'bindings' in destination ? destination.bindings : []).toEqual([
      { dok_ref: 'PROG-LIST', source: 'auto' },
    ]);
  });

  it('R3 reports an unplaced placement path as a warning, not a schema error', () => {
    const payload = iaFile([
      routeTree(),
      curatedTree({
        nodes: [{ kind: 'destination', path: '/ghost', label: 'Ghost', children: [] }],
      }),
    ]);

    const result = IaFileV2Schema.safeParse(payload);
    expect(result.success).toBe(true);
    expect(result.success ? collectIaPlacementWarnings(result.data) : []).toHaveLength(1);
  });

  it('R4 rejects a duplicate dok_ref inside one destination', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            routeDestination({
              bindings: [
                { dok_ref: 'PROG-LIST', source: 'auto' },
                { dok_ref: 'PROG-LIST', source: 'manual' },
              ],
            }),
          ],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('R4 rejects a binding without an explicit source', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [routeDestination({ bindings: [{ dok_ref: 'PROG-LIST' }] })],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('R4 accepts distinct dok_refs with explicit auto and manual provenance', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            routeDestination({
              bindings: [
                { dok_ref: 'PROG-LIST', source: 'auto' },
                { dok_ref: 'SAVE-BOOKMARK', source: 'manual' },
              ],
            }),
          ],
        }),
      ]),
    );

    expect(result.success).toBe(true);
  });

  it('R5 rejects an auto route_hierarchy destination without evidence', () => {
    const missing = routeDestination();
    delete missing.evidence;
    expect(IaFileV2Schema.safeParse(iaFile([routeTree({ nodes: [missing] })])).success).toBe(false);

    const empty = routeDestination({ evidence: [] });
    expect(IaFileV2Schema.safeParse(iaFile([routeTree({ nodes: [empty] })])).success).toBe(false);
  });

  it('R5 rejects evidence whose file is not a POSIX relative path', () => {
    const bad = ['/app/program/page.tsx', 'app\\program\\page.tsx', '../outside/page.tsx'];

    for (const file of bad) {
      const result = IaFileV2Schema.safeParse(
        iaFile([
          routeTree({
            nodes: [routeDestination({ evidence: [{ kind: 'route_source', file }] })],
          }),
        ]),
      );
      expect(result.success, `${file} must be rejected`).toBe(false);
    }
  });

  it('R5 rejects evidence carrying a kind other than route_source', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            routeDestination({
              evidence: [{ kind: 'screenshot', file: 'app/program/page.tsx' }],
            }),
          ],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('R5 rejects evidence on a manual tree destination', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree(),
        curatedTree({
          nodes: [
            {
              kind: 'destination',
              path: '/program',
              label: 'Browse',
              evidence: [{ kind: 'route_source', file: 'app/program/page.tsx' }],
              children: [],
            },
          ],
        }),
      ]),
    );

    expect(result.success).toBe(false);
  });

  it('R5 accepts POSIX relative route_source evidence', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            routeDestination({
              evidence: [{ kind: 'route_source', file: 'app/program/page.tsx' }],
            }),
          ],
        }),
      ]),
    );

    expect(result.success).toBe(true);
    const destination = result.success ? result.data.trees[0]?.nodes[0] : undefined;
    expect(destination && 'evidence' in destination ? destination.evidence : undefined).toEqual([
      { kind: 'route_source', file: 'app/program/page.tsx' },
    ]);
  });

  it('R6 rejects a curated field outside label|tags|platform', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([routeTree({ nodes: [routeDestination({ curated_fields: ['evidence'] })] })]),
    );

    expect(result.success).toBe(false);
  });

  it('R6 accepts curated_fields and materializes an empty array by default', () => {
    const declared = routeDestination({
      curated_fields: ['label', 'tags', 'platform'],
      tags: ['v2.0'],
      platform: 'desktop',
    });
    const implicit = routeDestination({ path: '/program/[id]' });
    delete implicit.curated_fields;

    const result = IaFileV2Schema.safeParse(
      iaFile([routeTree({ nodes: [declared, implicit] })]),
    );

    expect(result.success).toBe(true);
    expect(result.success ? result.data.trees[0]?.nodes[0]?.curated_fields : []).toEqual([
      'label',
      'tags',
      'platform',
    ]);
    expect(result.success ? result.data.trees[0]?.nodes[1]?.curated_fields : undefined).toEqual([]);
  });

  it('R7 rejects an auto navigation or organization tree', () => {
    for (const type of ['navigation', 'organization']) {
      const result = IaFileV2Schema.safeParse(
        iaFile([curatedTree({ type, source: 'auto', producer: 'doklo-route-hierarchy@1' })]),
      );
      expect(result.success, `auto ${type} must be rejected`).toBe(false);
    }
  });

  it('R7 rejects an auto tree without a producer', () => {
    const anonymous = routeTree();
    delete anonymous.producer;
    expect(IaFileV2Schema.safeParse(iaFile([anonymous])).success).toBe(false);

    expect(IaFileV2Schema.safeParse(iaFile([routeTree({ producer: '' })])).success).toBe(false);
  });

  it('R7 accepts an auto route_hierarchy tree with a producer and manual curated trees', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([routeTree(), curatedTree(), curatedTree({ tree_id: 'web-areas', type: 'organization' })]),
    );

    expect(result.success).toBe(true);
    expect(result.success && result.data.trees.map((tree) => tree.source)).toEqual([
      'auto',
      'manual',
      'manual',
    ]);
  });

  it('R8 rejects a file that still carries edges', () => {
    const result = IaFileV2Schema.safeParse(iaFile([routeTree()], { edges: [] }));

    expect(result.success).toBe(false);
  });

  it('R8 rejects retired v1 node and tree fields', () => {
    const withDokRef = IaFileV2Schema.safeParse(
      iaFile([routeTree({ nodes: [routeDestination({ dok_ref: 'PROG-LIST' })] })]),
    );
    expect(withDokRef.success).toBe(false);

    const withUnknownTreeKey = IaFileV2Schema.safeParse(
      iaFile([routeTree({ shape: 'flat' })]),
    );
    expect(withUnknownTreeKey.success).toBe(false);
  });

  it('R8 accepts a v2 file that carries only contract fields', () => {
    const result = IaFileV2Schema.safeParse(
      iaFile([routeTree(), curatedTree()], { updated_at: '2026-07-27T00:00:00.000Z' }),
    );

    expect(result.success).toBe(true);
    expect(result.success ? Object.keys(result.data).sort() : []).toEqual([
      'service_id',
      'trees',
      'updated_at',
      'version',
    ]);
  });
});

describe('IA v2 file invariants', () => {
  it('rejects a file whose version is not literally 2', () => {
    expect(IaFileV2Schema.safeParse(iaFile([routeTree()], { version: 1 })).success).toBe(false);
    expect(IaFileV2Schema.safeParse(iaFile([routeTree()], { version: 3 })).success).toBe(false);

    const versionless = iaFile([routeTree()]);
    delete versionless.version;
    expect(IaFileV2Schema.safeParse(versionless).success).toBe(false);
  });

  it('rejects duplicate tree_id within one file', () => {
    const result = IaFileV2Schema.safeParse(iaFile([routeTree(), routeTree()]));

    expect(result.success).toBe(false);
  });

  it('rejects a duplicate path within one tree, counting group paths', () => {
    const nested = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [routeDestination({ children: [routeDestination()] })],
        }),
      ]),
    );
    expect(nested.success).toBe(false);

    const groupCollision = IaFileV2Schema.safeParse(
      iaFile([
        routeTree({
          nodes: [
            { kind: 'group', path: '/program', label: 'Programs', children: [routeDestination()] },
          ],
        }),
      ]),
    );
    expect(groupCollision.success).toBe(false);
  });

  it('keeps duplicate paths legal across different trees', () => {
    const result = IaFileV2Schema.safeParse(iaFile([routeTree(), curatedTree()]));

    expect(result.success).toBe(true);
  });
});

describe('collectIaPlacementWarnings', () => {
  it('warns when a placement path has no auto route destination', () => {
    const file = IaFileV2Schema.parse(
      iaFile([
        routeTree(),
        curatedTree({
          nodes: [
            {
              kind: 'group',
              label: 'Programs',
              children: [{ kind: 'destination', path: '/ghost', label: 'Ghost', children: [] }],
            },
          ],
        }),
      ]),
    );

    const warnings = collectIaPlacementWarnings(file);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('/ghost');
    expect(warnings[0]).toContain('web-main-navigation');
  });

  it('stays silent when every placement matches a route destination', () => {
    const file = IaFileV2Schema.parse(iaFile([routeTree(), curatedTree()]));

    expect(collectIaPlacementWarnings(file)).toEqual([]);
  });

  it('ignores destinations inside the auto route_hierarchy tree itself', () => {
    const file = IaFileV2Schema.parse(iaFile([routeTree()]));

    expect(collectIaPlacementWarnings(file)).toEqual([]);
  });
});

describe('parseIaFileAnyVersion', () => {
  it('reads a v2 payload as version 2', () => {
    const result = parseIaFileAnyVersion(iaFile([routeTree()]));

    expect(result.version).toBe(2);
    expect(result.file.trees[0]?.tree_id).toBe('web-routes');
    expect(result.version === 2 && result.file.version).toBe(2);
  });

  it('reads a v1 payload as version 1', () => {
    const legacy = {
      service_id: 'web',
      trees: [
        {
          tree_id: 'web-nav',
          type: 'sitemap',
          nodes: [{ path: '/program', label: 'Programs', dok_ref: 'PROG-LIST' }],
        },
      ],
    };

    const result = parseIaFileAnyVersion(legacy);

    expect(result.version).toBe(1);
    expect(result.version === 1 && result.file.version).toBe(1);
    expect(result.version === 1 && result.file.edges).toEqual([]);
    expect(result.file.trees[0]?.nodes[0]?.path).toBe('/program');
  });

  it('reads an explicitly stamped v1 payload as version 1', () => {
    const result = parseIaFileAnyVersion({ service_id: 'web', version: 1, trees: [], edges: [] });

    expect(result.version).toBe(1);
  });

  it('throws on a payload that is neither v1 nor v2', () => {
    expect(() => parseIaFileAnyVersion('not an IA file')).toThrow();
    expect(() => parseIaFileAnyVersion(null)).toThrow();
    expect(() => parseIaFileAnyVersion({ trees: [] })).toThrow();
    expect(() => parseIaFileAnyVersion({ service_id: 'web', version: 2, trees: [{}] })).toThrow();
  });
});

describe('spec 6.1 contract file', () => {
  // Verbatim contract JSON from the design spec — the shape every producer,
  // migrator and reader must agree on.
  const contract = {
    service_id: 'web',
    version: 2,
    trees: [
      {
        tree_id: 'web-routes',
        type: 'route_hierarchy',
        source: 'auto',
        producer: 'doklo-route-hierarchy@1',
        platform: 'all',
        nodes: [
          {
            path: '/program',
            kind: 'destination',
            label: '프로그램 목록',
            curated_fields: [],
            bindings: [{ dok_ref: 'PROG-LIST', source: 'auto' }],
            evidence: [{ kind: 'route_source', file: 'app/program/page.tsx' }],
            children: [
              {
                path: '/program/[id]',
                kind: 'destination',
                label: '프로그램 상세',
                curated_fields: ['label'],
                bindings: [
                  { dok_ref: 'PROG-DETAIL', source: 'auto' },
                  { dok_ref: 'SAVE-BOOKMARK', source: 'manual' },
                ],
                evidence: [{ kind: 'route_source', file: 'app/program/[id]/page.tsx' }],
                children: [],
              },
            ],
          },
        ],
      },
      {
        tree_id: 'web-main-navigation',
        type: 'navigation',
        source: 'manual',
        platform: 'all',
        nodes: [
          {
            kind: 'group',
            label: '프로그램',
            children: [
              { kind: 'destination', path: '/program', label: '탐색', children: [] },
            ],
          },
        ],
      },
    ],
  };

  it('parses both trees of the contract file', () => {
    const file = IaFileV2Schema.parse(contract);

    expect(file.trees).toHaveLength(2);
    const detail = file.trees[0]?.nodes[0]?.children[0];
    expect(detail).toMatchObject({ kind: 'destination', path: '/program/[id]' });
    expect(detail && 'bindings' in detail ? detail.bindings : []).toEqual([
      { dok_ref: 'PROG-DETAIL', source: 'auto' },
      { dok_ref: 'SAVE-BOOKMARK', source: 'manual' },
    ]);
    expect(detail?.curated_fields).toEqual(['label']);
  });

  it('materializes defaults on the manual tree nodes', () => {
    const file = IaFileV2Schema.parse(contract);
    const group = file.trees[1]?.nodes[0];
    const placement = group?.children[0];

    expect(group).toMatchObject({ kind: 'group', curated_fields: [], tags: [] });
    expect(placement).toMatchObject({ kind: 'destination', curated_fields: [], tags: [] });
    expect(placement && 'bindings' in placement ? placement.bindings : undefined).toEqual([]);
    // evidence has no default: it must stay absent outside the producer's tree.
    expect(placement !== undefined && 'evidence' in placement).toBe(false);
    expect(file.trees[1]?.platform).toBe('all');
  });

  it('produces no placement warning for the contract file', () => {
    expect(collectIaPlacementWarnings(IaFileV2Schema.parse(contract))).toEqual([]);
  });
});
