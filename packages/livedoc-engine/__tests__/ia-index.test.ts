import { describe, expect, it } from 'vitest';
import { buildIaIndex } from '../src/helpers/ia-index.js';
import type { Dok, ServiceHubSlice } from '@doklo-beta/core';

function dok(id: string): Dok {
  return {
    dok_id: id,
    name: `Feature ${id}`,
    status: 'active',
    tags: [],
    surfaces: [],
    description: `Description ${id}`,
    _meta: { version: 1, history: [] },
  } as Dok;
}

const v2Slice: ServiceHubSlice = {
  service_id: 'web',
  ia: {
    service_id: 'web',
    version: 2,
    trees: [
      {
        tree_id: 'web-route-hierarchy',
        type: 'route_hierarchy',
        source: 'auto',
        producer: 'doklo-route-hierarchy@1',
        platform: 'all',
        nodes: [
          {
            path: '/auth',
            kind: 'group',
            label: 'Auth',
            curated_fields: [],
            tags: [],
            children: [
              {
                path: '/auth/signin',
                kind: 'destination',
                label: 'Sign in',
                curated_fields: [],
                bindings: [{ dok_ref: 'AUTH', source: 'auto' }],
                evidence: [
                  {
                    kind: 'route_source',
                    file: 'app/auth/signin/page.tsx',
                  },
                ],
                tags: [],
                children: [],
              },
            ],
          },
          {
            path: '/orphan',
            kind: 'destination',
            label: 'Orphan',
            curated_fields: [],
            bindings: [],
            evidence: [
              { kind: 'route_source', file: 'app/orphan/page.tsx' },
            ],
            tags: [],
            children: [],
          },
        ],
      },
    ],
  } as never,
};

describe('buildIaIndex', () => {
  it('prunes empty branches, attaches selected doks, collects unplaced', () => {
    const doks = [dok('AUTH'), dok('LOOSE')];
    const result = buildIaIndex([v2Slice], doks, '.html');
    expect(result.sections).toHaveLength(1);
    const auth = result.sections[0]!.nodes[0]!;
    expect(auth.label).toBe('Auth');
    expect(auth.children[0]!.doks[0]).toMatchObject({
      dok: { dok_id: 'AUTH' },
      href: './AUTH.html',
    });
    expect(result.sections[0]!.nodes).toHaveLength(1);
    expect(result.unplaced.map((item) => item.dok.dok_id)).toEqual([
      'LOOSE',
    ]);
  });

  it('places each dok at most once (many-to-many bindings dedupe)', () => {
    const twice: ServiceHubSlice = JSON.parse(JSON.stringify(v2Slice));
    (
      twice.ia as never as { trees: Array<{ nodes: unknown[] }> }
    ).trees[0]!.nodes.push({
      path: '/dup',
      kind: 'destination',
      label: 'Dup',
      curated_fields: [],
      bindings: [{ dok_ref: 'AUTH', source: 'auto' }],
      evidence: [{ kind: 'route_source', file: 'app/dup/page.tsx' }],
      tags: [],
      children: [],
    });
    const result = buildIaIndex([twice], [dok('AUTH')], '.md');
    expect(JSON.stringify(result).match(/AUTH\.md/g)).toHaveLength(1);
  });

  it('prefixes article links with link_prefix so an index can live one folder above its articles', () => {
    const result = buildIaIndex([], [dok('AUTH')], '.html', './pages/');
    expect(result.unplaced.map((item) => item.href)).toEqual(['./pages/AUTH.html']);
    const bare = buildIaIndex([], [dok('AUTH')], '.html');
    expect(bare.unplaced.map((item) => item.href)).toEqual(['./AUTH.html']);
  });

  it('returns everything unplaced when no service has IA', () => {
    const result = buildIaIndex(
      [{ service_id: 'web' }],
      [dok('AUTH')],
      '.html',
    );
    expect(result.sections).toEqual([]);
    expect(result.unplaced).toHaveLength(1);
  });
});
