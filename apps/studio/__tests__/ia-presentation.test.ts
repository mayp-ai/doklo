import { describe, expect, it } from 'vitest';
import {
  buildSitemapCards,
  iaMatchesBelowDepth,
  visibleIaNodes,
} from '../lib/ia-presentation.js';
import { deepUnmappedTree, hierarchicalTree } from './helpers/ia-fixture.js';
import type { StudioIaNode, StudioIaTree } from '../lib/ia-route.js';

function deepTree(depth: number): StudioIaTree {
  let children: StudioIaNode[] = [];
  for (let level = depth; level >= 1; level -= 1) {
    children = [{
      key: `web::deep/level-${level}`,
      path: `/level-${level}`,
      seg: `level-${level}`,
      title: `Level ${level}`,
      platform: 'both',
      tags: [],
      unmapped: true,
      children,
    }];
  }
  return {
    key: 'web::deep',
    serviceId: 'web',
    treeId: 'deep',
    type: 'sitemap',
    source: 'manual',
    platform: 'both',
    nodes: children,
  };
}

describe('IA presentation projections', () => {
  it('creates one sitemap card per matching top-level container', () => {
    const tree = hierarchicalTree();
    const cards = buildSitemapCards(tree, 3, 'all');

    expect(cards.map((card) => card.node.title)).toEqual([
      'Auth',
      'Programs',
    ]);
    expect(cards[0]?.listings.map((item) => item.node.title)).toContain(
      '비밀번호 재설정',
    );
  });

  it('uses real hierarchy for depth and keeps filtered ancestor context', () => {
    const tree = hierarchicalTree();

    expect(
      visibleIaNodes(tree, 1, 'all').map((row) => row.node.title),
    ).toEqual(['Auth', 'Programs']);
    expect(
      visibleIaNodes(tree, 3, 'unmapped').map((row) => row.node.title),
    ).toEqual(['Auth', 'Unmapped child']);
  });

  it('treats depth 6 as an unbounded all sentinel for both projections', () => {
    const tree = deepTree(9);

    expect(visibleIaNodes(tree, 6, 'all')).toHaveLength(9);
    expect(buildSitemapCards(tree, 6, 'all')[0]?.listings).toHaveLength(8);
    expect(
      buildSitemapCards(tree, 6, 'all')[0]?.listings.at(-1)?.node.title,
    ).toBe('Level 9');
  });
});

describe('IA matches hidden below the depth cutoff', () => {
  const branchKey = 'web::web-routes/program';

  it('counts the matches a shallow depth cuts off, per top-level branch', () => {
    const tree = deepUnmappedTree();
    const counts = iaMatchesBelowDepth(tree, 3, 'unmapped');

    // The branch renders only container context at depth 3; all three
    // unmapped destinations sit at depth 5.
    expect(buildSitemapCards(tree, 3, 'unmapped')[0]?.listings.every(
      (listing) => !listing.node.unmapped,
    )).toBe(true);
    expect(counts.get(branchKey)).toBe(3);
    expect([...counts.keys()]).toEqual([branchKey]);
  });

  it('reports nothing once the depth reaches the matching nodes', () => {
    const tree = deepUnmappedTree();

    expect(iaMatchesBelowDepth(tree, 5, 'unmapped').get(branchKey)).toBe(
      undefined,
    );
    expect(iaMatchesBelowDepth(tree, 6, 'unmapped').size).toBe(0);
  });

  it('reports nothing while the default filter keeps every node in view', () => {
    expect(iaMatchesBelowDepth(deepUnmappedTree(), 1, 'all').size).toBe(0);
  });

  it('counts only filter matches, never the ancestor context rows', () => {
    const tree = hierarchicalTree();
    const counts = iaMatchesBelowDepth(tree, 1, 'unmapped');

    // Auth is kept as context by the filter but is not itself a match, so
    // only its single unmapped child is counted below depth 1.
    expect(counts.get('web::web-sitemap/auth')).toBe(1);
    expect(counts.has('web::web-sitemap/programs')).toBe(false);
  });

  it('reports nothing when the active filter hides no match by depth', () => {
    const tree = deepUnmappedTree();

    // Nothing matches at all.
    expect(iaMatchesBelowDepth(tree, 3, 'mobile').size).toBe(0);
    // The only mapped node is a top-level branch, always in view.
    expect(iaMatchesBelowDepth(tree, 3, 'mapped').size).toBe(0);
  });
});
