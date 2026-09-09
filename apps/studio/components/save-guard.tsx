'use client';

import { useEffect } from 'react';
import { useSafeNavigation } from '../lib/hooks/use-safe-navigation';
import { useStudio } from './studio-store';

export function SaveGuard() {
  const { pendingSave } = useStudio();
  const { push } = useSafeNavigation();

  useEffect(() => {
    function handleBeforeUnload(event: BeforeUnloadEvent) {
      if (!pendingSave) return;
      event.preventDefault();
      event.returnValue = '';
    }

    function handleClick(event: MouseEvent) {
      if (
        !pendingSave ||
        event.defaultPrevented ||
        event.button !== 0 ||
        event.metaKey ||
        event.ctrlKey ||
        event.shiftKey ||
        event.altKey ||
        !(event.target instanceof Element)
      ) {
        return;
      }

      const anchor = event.target.closest<HTMLAnchorElement>('a[href]');
      if (
        !anchor ||
        anchor.hasAttribute('download') ||
        (anchor.target && anchor.target !== '_self')
      ) {
        return;
      }

      const destination = new URL(anchor.href, window.location.href);
      if (destination.origin !== window.location.origin) return;

      event.preventDefault();
      const href = `${destination.pathname}${destination.search}${destination.hash}`;
      void push(href);
    }

    window.addEventListener('beforeunload', handleBeforeUnload);
    document.addEventListener('click', handleClick, true);
    return () => {
      window.removeEventListener('beforeunload', handleBeforeUnload);
      document.removeEventListener('click', handleClick, true);
    };
  }, [pendingSave, push]);

  return null;
}
