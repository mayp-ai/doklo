import { describe, expect, it } from 'vitest';
import type { AppRoute } from '../src/routing.js';
import { buildLayoutChains } from '../src/layout-chain.js';
import { mapAppRoutes } from '../src/mappers.js';

function route(filePath: string, type: AppRoute['type'], path: string): AppRoute {
  return {
    filePath,
    type,
    path,
    isDynamic: false,
    isParallel: false,
    isIntercepting: false,
    params: [],
  };
}

describe('buildLayoutChains', () => {
  it('records root-to-leaf layouts while retaining route-group directories', () => {
    const routes = [
      route('app/layout.tsx', 'layout', '/'),
      route('app/(default)/layout.tsx', 'layout', '/'),
      route('app/(default)/auth/layout.tsx', 'layout', '/auth'),
      route('app/(default)/auth/signin/page.tsx', 'page', '/auth/signin'),
    ];

    expect(buildLayoutChains(routes).get('app/(default)/auth/signin/page.tsx')).toEqual([
      'app/layout.tsx',
      'app/(default)/layout.tsx',
      'app/(default)/auth/layout.tsx',
    ]);
  });

  it('does not include sibling layouts or the page itself', () => {
    const mapped = mapAppRoutes([
      route('src/app/layout.tsx', 'layout', '/'),
      route('src/app/a/layout.tsx', 'layout', '/a'),
      route('src/app/a/page.tsx', 'page', '/a'),
      route('src/app/b/layout.tsx', 'layout', '/b'),
    ]);

    expect(mapped.find((item) => item.file === 'src/app/a/page.tsx')?.layout_chain).toEqual([
      'src/app/layout.tsx',
      'src/app/a/layout.tsx',
    ]);
  });
});
