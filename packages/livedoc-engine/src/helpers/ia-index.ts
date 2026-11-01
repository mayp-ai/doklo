import type Handlebars from 'handlebars';
import type { Dok, ServiceHubSlice, Translatable } from '@doklo-beta/core';

export interface IaIndexEntry {
  dok: Dok;
  href: string;
}

export interface IaIndexNode {
  label: Translatable;
  path?: string;
  doks: IaIndexEntry[];
  children: IaIndexNode[];
}

export interface IaIndexResult {
  sections: Array<{ service_id: string; nodes: IaIndexNode[] }>;
  unplaced: IaIndexEntry[];
}

type V2Node = {
  kind: 'destination' | 'group';
  path?: string;
  label: Translatable;
  bindings?: Array<{ dok_ref: string }>;
  children?: V2Node[];
};

type V1Node = {
  path?: string;
  label: Translatable;
  dok_ref?: string | null;
  children?: V1Node[];
};

function entry(dok: Dok, linkExtension: string, linkPrefix: string): IaIndexEntry {
  return { dok, href: `${linkPrefix}${dok.dok_id}${linkExtension}` };
}

/**
 * Project service IA trees onto a selected Dok set. Empty branches are
 * pruned, each Dok's first placement wins, and leftovers remain visible in
 * `unplaced` so the index never silently loses coverage.
 */
export function buildIaIndex(
  services: ServiceHubSlice[],
  doks: Dok[],
  linkExtension: string,
  linkPrefix = './',
): IaIndexResult {
  const extension =
    typeof linkExtension === 'string' && linkExtension.length > 0
      ? linkExtension
      : '.html';
  const prefix =
    typeof linkPrefix === 'string' && linkPrefix.length > 0 ? linkPrefix : './';
  const byId = new Map(doks.map((dok) => [dok.dok_id, dok]));
  const placed = new Set<string>();

  function place(dokId: string | null | undefined): IaIndexEntry[] {
    if (!dokId) return [];
    const dok = byId.get(dokId);
    if (!dok || placed.has(dok.dok_id)) return [];
    placed.add(dok.dok_id);
    return [entry(dok, extension, prefix)];
  }

  function mapV2(node: V2Node): IaIndexNode | null {
    const own =
      node.kind === 'destination'
        ? (node.bindings ?? []).flatMap((binding) => place(binding.dok_ref))
        : [];
    const children = (node.children ?? [])
      .map(mapV2)
      .filter((child): child is IaIndexNode => child !== null);
    if (own.length === 0 && children.length === 0) return null;
    return {
      label: node.label,
      ...(node.path ? { path: node.path } : {}),
      doks: own,
      children,
    };
  }

  function mapV1(node: V1Node): IaIndexNode | null {
    const own = place(node.dok_ref);
    const children = (node.children ?? [])
      .map(mapV1)
      .filter((child): child is IaIndexNode => child !== null);
    if (own.length === 0 && children.length === 0) return null;
    return {
      label: node.label,
      ...(node.path ? { path: node.path } : {}),
      doks: own,
      children,
    };
  }

  const sections: IaIndexResult['sections'] = [];
  for (const slice of services) {
    const ia = slice.ia as
      | {
          version?: number;
          trees?: Array<{ type?: string; nodes?: unknown[] }>;
        }
      | undefined;
    if (!ia || !Array.isArray(ia.trees)) continue;

    const nodes: IaIndexNode[] = [];
    for (const tree of ia.trees) {
      if (ia.version === 2 && tree.type !== 'route_hierarchy') continue;
      const treeNodes = (tree.nodes ?? []) as Array<V2Node & V1Node>;
      for (const node of treeNodes) {
        const mapped = ia.version === 2 ? mapV2(node) : mapV1(node);
        if (mapped) nodes.push(mapped);
      }
    }
    if (nodes.length > 0) {
      sections.push({ service_id: slice.service_id, nodes });
    }
  }

  const unplaced = doks
    .filter((dok) => !placed.has(dok.dok_id))
    .sort((left, right) => left.dok_id.localeCompare(right.dok_id))
    .map((dok) => entry(dok, extension, prefix));

  return { sections, unplaced };
}

export interface HelpCategory {
  service_id: string;
  label: Translatable;
  path?: string;
  /** Every placed Dok under this top-level group, flattened in tree order. */
  articles: IaIndexEntry[];
  count: number;
}

export interface HelpCategoriesResult {
  categories: HelpCategory[];
  unplaced: IaIndexEntry[];
}

function flattenEntries(node: IaIndexNode): IaIndexEntry[] {
  return [...node.doks, ...node.children.flatMap(flattenEntries)];
}

/**
 * Help-center projection of the IA index: each top-level route group becomes
 * one category and everything beneath it is flattened into that category's
 * article list. Leaf routes never become headings of their own — the
 * help-center convention is category cards over article lists, not a
 * sitemap. Order is the IA tree order; labels are the IA labels verbatim
 * (renaming is Studio's job, not the renderer's).
 */
export function buildHelpCategories(
  services: ServiceHubSlice[],
  doks: Dok[],
  linkExtension: string,
  linkPrefix = './',
): HelpCategoriesResult {
  const index = buildIaIndex(services, doks, linkExtension, linkPrefix);
  const categories: HelpCategory[] = [];
  for (const section of index.sections) {
    for (const node of section.nodes) {
      const articles = flattenEntries(node);
      if (articles.length === 0) continue;
      categories.push({
        service_id: section.service_id,
        label: node.label,
        ...(node.path ? { path: node.path } : {}),
        articles,
        count: articles.length,
      });
    }
  }
  return { categories, unplaced: index.unplaced };
}

export function registerIaIndex(hb: typeof Handlebars): void {
  hb.registerHelper(
    'ia_index',
    function (services: unknown, doks: unknown, linkExtension: unknown, linkPrefix: unknown) {
      return buildIaIndex(
        Array.isArray(services) ? (services as ServiceHubSlice[]) : [],
        Array.isArray(doks) ? (doks as Dok[]) : [],
        typeof linkExtension === 'string' ? linkExtension : '.html',
        typeof linkPrefix === 'string' ? linkPrefix : './',
      );
    },
  );
  hb.registerHelper(
    'help_categories',
    function (services: unknown, doks: unknown, linkExtension: unknown, linkPrefix: unknown) {
      return buildHelpCategories(
        Array.isArray(services) ? (services as ServiceHubSlice[]) : [],
        Array.isArray(doks) ? (doks as Dok[]) : [],
        typeof linkExtension === 'string' ? linkExtension : '.html',
        typeof linkPrefix === 'string' ? linkPrefix : './',
      );
    },
  );
}
