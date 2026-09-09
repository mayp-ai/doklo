'use client';

import { usePathname } from 'next/navigation';
import { DokTree } from './dok-tree';
import { TermTree } from './term-tree';
import { RoleTree } from './role-tree';

/**
 * EditorTreeRail — chooses which 240px left-rail tree to mount based
 * on the active route. Lives outside the (editor) layout because the
 * layout itself is a Server Component and can't read usePathname().
 *
 * Phase 9 only shipped DokTree; Phase 10 added TermTree for the
 * lexicon-editor; Phase 11 adds RoleTree for the role-editor.
 * Defaulting to DokTree keeps any future editor route looking the
 * same until its own tree variant is added.
 */
export function EditorTreeRail() {
  const pathname = usePathname() ?? '';
  if (pathname.startsWith('/lexicon/')) return <TermTree />;
  if (pathname.startsWith('/roles/'))   return <RoleTree />;
  // /doks/* and any future editor route (until its tree is added)
  // fall through to DokTree.
  return <DokTree />;
}
