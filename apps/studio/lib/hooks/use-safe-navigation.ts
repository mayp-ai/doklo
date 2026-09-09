'use client';

import { useCallback } from 'react';
import { useRouter } from 'next/navigation';
import { useStudio } from '../../components/studio-store';

// Every caller in a Studio tab shares this lock. Without a shared lock,
// a keyboard shortcut and a button owned by separate hook instances could
// both flush and then race two route pushes.
let activeNavigation: Promise<boolean> | null = null;

export function useSafeNavigation(): {
  push: (href: string) => Promise<boolean>;
  pushResolved: (
    resolveHrefAfterFlush: () => string | null,
  ) => Promise<boolean>;
} {
  const router = useRouter();
  const { flushPendingSave } = useStudio();

  const pushResolved = useCallback(
    (
      resolveHrefAfterFlush: () => string | null,
    ): Promise<boolean> => {
      if (activeNavigation) {
        return activeNavigation.then(
          () => false,
          () => false,
        );
      }

      const navigation = (async () => {
        try {
          if (!(await flushPendingSave())) return false;
          const href = resolveHrefAfterFlush();
          if (href === null) return false;
          router.push(href);
          return true;
        } catch {
          return false;
        }
      })();
      activeNavigation = navigation;
      void navigation.then(
        () => {
          if (activeNavigation === navigation) activeNavigation = null;
        },
        () => {
          if (activeNavigation === navigation) activeNavigation = null;
        },
      );
      return navigation;
    },
    [flushPendingSave, router],
  );

  const push = useCallback(
    (href: string): Promise<boolean> =>
      pushResolved(() => href),
    [pushResolved],
  );

  return { push, pushResolved };
}
