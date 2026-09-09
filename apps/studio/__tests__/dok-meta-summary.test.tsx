// @vitest-environment jsdom

import { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it } from 'vitest';
import type { Dok } from '@doklo-beta/core';
import { DokEditSidebar } from '../components/smart-sidebar-content/dok-edit-sidebar';
import { StudioProvider, useStudio } from '../components/studio-store';
import authDokJson from '../demo/.doklo/hub/doks/AUTH-SOCIAL.json';

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const roots: Root[] = [];
const logicHash =
  '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef';
const dok = {
  ...authDokJson,
  status: 'draft',
  _meta: {
    ...authDokJson._meta,
    logic_hash: logicHash,
  },
} as Dok;

function SeedSidebar() {
  const { setEditingDok } = useStudio();
  useEffect(() => setEditingDok(dok), [setEditingDok]);
  return <DokEditSidebar />;
}

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
});

describe('Dok Meta summary', () => {
  it('shows one bounded source fingerprint without repeating the full hash', () => {
    const container = document.createElement('div');
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    act(() => {
      root.render(
        <StudioProvider
          layerCounts={{ doks: 1, lexicon: 0, ia: 0, roles: 0 }}
          initialDoks={[dok]}
        >
          <SeedSidebar />
        </StudioProvider>,
      );
    });

    expect(container.textContent).toContain('01234567…cdef');
    expect(container.textContent).not.toContain(logicHash);
    expect(container.querySelector(`[title="${logicHash}"]`)).not.toBeNull();

    const sourceFingerprint = [...container.querySelectorAll('div')].find(
      (candidate) => candidate.textContent?.includes('Source fingerprint'),
    );
    expect(sourceFingerprint?.querySelector('code')).toBeNull();
  });
});
