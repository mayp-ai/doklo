'use client';

import Link from 'next/link';
import type { LexiconTerm, Translatable } from '@doklo-beta/core';
import {
  useSelectedIaNode,
  useSelectedIaTree,
  useStudio,
} from './studio-store';
import { SmartSidebarSection } from './smart-sidebar';
import {
  splitSegment,
  type Platform,
  type StudioIaNode,
  type StudioIaTree,
} from '../lib/ia-route';
import { termDisplay } from '../lib/term-display';

const PLATFORM_LABEL: Record<Platform, string> = {
  both: 'Desktop + Mobile',
  'desktop-only': 'Desktop only',
  'mobile-only': 'Mobile only',
};

const TREE_TYPE_LABEL: Record<StudioIaTree['type'], string> = {
  route_hierarchy: 'Route hierarchy',
  organization: 'Product organization',
  navigation: 'Navigation',
  sitemap: 'Sitemap',
  feature_group: 'Feature group',
};

const SOURCE_LABEL = {
  auto: 'Automatic',
  manual: 'Manual',
  'auto+manual': 'Automatic + manual',
} as const;

const BINDING_SOURCE_LABEL = {
  auto: 'Auto',
  manual: 'Manual',
} as const;

/** Every manual binding in a tree, counted so the two facts — who built the
 *  structure, who claimed the Doks — can be reported separately. */
function countManualBindings(nodes: readonly StudioIaNode[]): number {
  return nodes.reduce(
    (total, node) =>
      total +
      (node.bindings?.filter((binding) => binding.source === 'manual').length ??
        0) +
      countManualBindings(node.children),
    0,
  );
}

/**
 * Structure provenance. An auto route_hierarchy is code-derived even when a
 * person bound Doks inside it, so the manual bindings are reported alongside
 * the structure instead of flipping its source.
 */
function structureSource(tree: StudioIaTree): string {
  if (tree.type !== 'route_hierarchy' || tree.source !== 'auto') {
    return SOURCE_LABEL[tree.source];
  }
  const manual = countManualBindings(tree.nodes);
  if (manual === 0) return 'Code-derived structure';
  return `Code-derived structure · ${manual} manual binding${
    manual === 1 ? '' : 's'
  }`;
}

export function RoutePreview() {
  const node = useSelectedIaNode();
  const tree = useSelectedIaTree();
  const { doks, lexicon, projectLocales } = useStudio();
  if (!node || !tree) return null;

  const childCount = node.children.length;
  const linkedDok =
    typeof node.dok_ref === 'string'
      ? doks.find((dok) => dok.dok_id === node.dok_ref) ?? null
      : null;
  const dokName = linkedDok
    ? resolveTranslatable(linkedDok.name, lexicon, projectLocales)
    : null;

  return (
    <div>
      <div className="mb-2.5 font-mono text-[10.5px] uppercase tracking-[0.14em] text-ink-muted">
        Selected IA node
      </div>
      <h3 className="mb-1.5 break-words text-lg font-semibold leading-tight tracking-tight text-ink-strong">
        {node.title}
      </h3>
      <div className="mb-3.5 inline-block max-w-full break-all rounded-md border border-accent-soft-strong bg-accent-soft px-3 py-1.5 font-mono text-[13px] font-medium text-accent-ink">
        {node.path !== undefined
          ? <PathDisplay path={node.path} />
          : 'Grouping node'}
      </div>

      <SmartSidebarSection title="Structure">
        <ul className="m-0 list-none p-0">
          <MetaRow k="Service" v={tree.serviceId} />
          <MetaRow k="Tree" v={tree.treeId} />
          <MetaRow k="Type" v={TREE_TYPE_LABEL[tree.type]} />
          <MetaRow k="Source" v={structureSource(tree)} />
          <MetaRow k="Platform" v={PLATFORM_LABEL[node.platform]} />
          <MetaRow
            k="Child nodes"
            v={`${childCount} ${childCount === 1 ? 'node' : 'nodes'}`}
          />
        </ul>
        {node.curatedFields !== undefined ? (
          <p className="mt-2 text-[12px] text-ink-muted">
            {node.curatedFields.length > 0
              ? `Curated: ${node.curatedFields.join(', ')}`
              : 'All fields auto'}
          </p>
        ) : null}
      </SmartSidebarSection>

      {node.bindings !== undefined ? (
        <SmartSidebarSection title="Bindings">
          {node.bindings.length === 0 ? (
            <p className="py-1.5 text-[12.5px] text-ink-muted">
              No bound Dok.
            </p>
          ) : (
            <ul className="m-0 list-none p-0">
              {node.bindings.map((binding) => (
                <li key={binding.dokRef}>
                  <Link
                    href={`/doks/${binding.dokRef}`}
                    className="flex w-full items-center gap-2 rounded-md py-1.5 text-left text-[13px] hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
                  >
                    <span className="shrink-0 rounded-full border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
                      {binding.dokRef}
                    </span>
                    <span
                      data-binding-source={binding.source}
                      className="shrink-0 rounded-full bg-surface-2 px-1.5 py-0.5 text-[10.5px] text-ink-muted"
                    >
                      {BINDING_SOURCE_LABEL[binding.source]}
                    </span>
                    <span className="flex-1 truncate text-ink-secondary">
                      {dokDisplayName(binding.dokRef, doks, lexicon, projectLocales) ?? ''}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          )}
        </SmartSidebarSection>
      ) : null}

      {node.evidence !== undefined && node.evidence.length > 0 ? (
        <SmartSidebarSection title="Code evidence">
          <ul className="m-0 list-none p-0">
            {node.evidence.map((item) => (
              <li
                key={item.file}
                className="break-all py-1 font-mono text-[11.5px] text-ink-secondary"
              >
                {item.file}
              </li>
            ))}
          </ul>
        </SmartSidebarSection>
      ) : null}

      {typeof node.dok_ref === 'string' ? (
        <SmartSidebarSection title="Linked Dok">
          <Link
            href={`/doks/${node.dok_ref}`}
            className="flex w-full items-center gap-2 rounded-md py-1.5 text-left text-[13px] hover:bg-surface-2 active:bg-surface-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent focus-visible:ring-offset-2 focus-visible:ring-offset-canvas"
          >
            <span className="shrink-0 rounded-full border border-accent-soft-strong bg-accent-soft px-1.5 py-0.5 font-mono text-[10.5px] font-medium text-accent-ink">
              {node.dok_ref}
            </span>
            {dokName ? (
              <span className="flex-1 truncate text-ink-secondary">
                {dokName}
              </span>
            ) : null}
          </Link>
        </SmartSidebarSection>
      ) : null}
    </div>
  );
}

/** Display name of a bound Dok, or null when the catalog has no such Dok. */
function dokDisplayName(
  dokRef: string,
  doks: readonly { dok_id: string; name: Translatable }[],
  lexicon: LexiconTerm[],
  locales: readonly string[],
): string | null {
  const dok = doks.find((candidate) => candidate.dok_id === dokRef);
  return dok ? resolveTranslatable(dok.name, lexicon, locales) : null;
}

function resolveTranslatable(
  value: Translatable,
  lexicon: LexiconTerm[],
  locales: readonly string[],
): string | null {
  if (typeof value === 'string') return value;
  const term = lexicon.find((candidate) =>
    candidate.term_id === value.term_ref
  );
  if (!term) return null;
  for (const locale of locales) {
    const text = termDisplay(term, locale);
    if (text != null) return text;
  }
  return null;
}

function MetaRow({ k, v }: { k: string; v: string }) {
  return (
    <li className="flex justify-between gap-2 py-1.5 text-[12.5px] [&:not(:last-child)]:border-b [&:not(:last-child)]:border-dashed [&:not(:last-child)]:border-border">
      <span className="text-ink-muted">{k}</span>
      <span className="truncate text-right font-medium text-ink">{v}</span>
    </li>
  );
}

function PathDisplay({ path }: { path: string }) {
  if (path === '') return <span aria-label="Empty path">{'""'}</span>;
  if (path === '/') return <>/</>;
  const segments = path.split('/').filter(Boolean);

  return (
    <>
      {segments.map((segment, index) => (
        <span key={`${segment}:${index}`}>
          <span className="text-accent-ink">/</span>
          <SegmentPart segment={segment} />
        </span>
      ))}
    </>
  );
}

function SegmentPart({ segment }: { segment: string }) {
  return (
    <>
      {splitSegment(segment).map((part, index) =>
        part.dynamic ? (
          <span key={index}>
            <span className="text-accent-ink">[</span>
            <span className="font-semibold text-status-draft-fg">
              {part.text}
            </span>
            <span className="text-accent-ink">]</span>
          </span>
        ) : (
          <span key={index}>{part.text}</span>
        ),
      )}
    </>
  );
}
