'use client';

import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LayerRail, type RailActive } from './layer-rail';

// pathname → rail highlight. Server layouts can't call usePathname(), so
// this thin client wrapper lets the (hub) layout mount LayerRail once and
// have it self-highlight based on the active route. When the user lands
// on a non-layer route under (hub) (only /doks today, more in Phase 5+),
// we default to 'doks' so the rail still anchors the user visually.
function pathnameToLayer(pathname: string | null): RailActive {
  if (!pathname) return 'doks';
  if (pathname.startsWith('/lexicon')) return 'lexicon';
  if (pathname.startsWith('/role')) return 'roles';
  if (pathname.startsWith('/ia')) return 'ia';
  if (pathname.startsWith('/livedocs')) return 'livedocs';
  return 'doks';
}

export function LayerRailNav() {
  const pathname = usePathname();
  const [publicationCount, setPublicationCount] = useState<
    number | undefined
  >();

  useEffect(() => {
    const controller = new AbortController();
    fetch('/api/livedocs', { signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) return;
        const body = await response.json() as { publications?: unknown[] };
        if (Array.isArray(body.publications)) {
          setPublicationCount(body.publications.length);
        }
      })
      .catch(() => {});
    return () => controller.abort();
  }, []);

  return (
    <LayerRail
      active={pathnameToLayer(pathname)}
      publicationCount={publicationCount}
    />
  );
}
