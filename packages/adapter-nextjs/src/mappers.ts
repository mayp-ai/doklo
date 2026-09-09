// Map vendored legacy parser output to the framework-agnostic IR.
// One file per concern would be over-organization for ~150 lines.

import type {
  RouteIR,
  ComponentIR,
  StoreIR,
  ParamIR,
} from '@doklo-beta/core';
import type {
  RouteInfo,
  ComponentInfo,
  FunctionInfo,
  ClassInfo,
  ParamInfo,
} from './legacy-types.js';
import type { AppRoute } from './routing.js';
import type { StoreInfo, ContextInfo, ActionInfo } from './state.js';
import { buildLayoutChains } from './layout-chain.js';

// ───────── Routes ──────────────────────────────────────────────────

// AppRoute.type → RouteIR.kind. 'loading'/'error'/'not-found'/'template'
// are route decorators rather than routes themselves; we drop them here
// (they remain available via framework_specific if a consumer needs them).
const APP_ROUTE_KIND_MAP: Partial<Record<AppRoute['type'], RouteIR['kind']>> = {
  page: 'page',
  layout: 'layout',
  route: 'api',
};

export function mapAppRoutes(appRoutes: AppRoute[]): RouteIR[] {
  const layoutChains = buildLayoutChains(appRoutes);
  const out: RouteIR[] = [];
  for (const r of appRoutes) {
    const kind = APP_ROUTE_KIND_MAP[r.type];
    if (!kind) continue;
    out.push({
      path: r.path,
      kind,
      file: r.filePath,
      dynamic_params: r.params,
      layout_chain: kind === 'page'
        ? [...(layoutChains.get(r.filePath.replaceAll('\\', '/').replace(/^\.\//, '')) ?? [])]
        : [],
      framework_specific: {
        app_route_type: r.type,
        is_dynamic: r.isDynamic,
        is_parallel: r.isParallel,
        is_intercepting: r.isIntercepting,
      },
    });
  }
  return out;
}

export function mapApiRoutes(routes: RouteInfo[]): RouteIR[] {
  return routes.map((r) => ({
    path: r.path,
    kind: 'api' as const,
    http_method: r.method,
    file: r.filePath,
    dynamic_params: extractDynamicParams(r.path),
    layout_chain: [],
    framework_specific: r.handlers.length > 0 ? { handlers: r.handlers } : undefined,
  }));
}

// Dedupe routes that came from both the AST scan and the App Router scan
// (a route.ts file is picked up by both). We key on file + http_method.
export function dedupeRoutes(routes: RouteIR[]): RouteIR[] {
  const seen = new Set<string>();
  const out: RouteIR[] = [];
  for (const r of routes) {
    const key = `${r.file}|${r.http_method ?? ''}|${r.kind}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(r);
  }
  return out;
}

function extractDynamicParams(path: string): string[] {
  const matches = path.match(/\[([^\]]+)\]/g) ?? [];
  return matches.map((m) => m.slice(1, -1));
}

// ───────── Components / Functions / Classes ────────────────────────

const HOOK_NAME_RE = /^use[A-Z]/;

export function mapComponents(components: ComponentInfo[]): ComponentIR[] {
  return components.map((c) => ({
    name: c.name,
    file: c.filePath,
    start_line: c.startLine,
    end_line: c.endLine,
    kind: 'component' as const,
    is_exported: true, // legacy parser only emits exported components
    inputs: c.props.map(propToParam),
    hooks_used: c.hooks,
    framework_specific: { is_default_export: c.isDefaultExport },
  }));
}

export function mapFunctions(functions: FunctionInfo[]): ComponentIR[] {
  return functions.map((f) => ({
    name: f.name,
    file: f.filePath,
    start_line: f.startLine,
    end_line: f.endLine,
    kind: HOOK_NAME_RE.test(f.name) ? ('hook' as const) : ('function' as const),
    is_exported: f.isExported,
    is_async: f.isAsync,
    inputs: f.params.map(paramToParam),
    returns: f.returnType ?? undefined,
    jsdoc: f.jsDoc ?? undefined,
  }));
}

export function mapClasses(classes: ClassInfo[]): ComponentIR[] {
  return classes.map((c) => ({
    name: c.name,
    file: c.filePath,
    start_line: c.startLine,
    end_line: c.endLine,
    kind: 'class' as const,
    is_exported: c.isExported,
    inputs: [],
    framework_specific: {
      methods: c.methods,
      properties: c.properties,
    },
  }));
}

function propToParam(p: { name: string; type: string | null; isOptional: boolean }): ParamIR {
  const out: ParamIR = { name: p.name, is_optional: p.isOptional };
  if (p.type !== null) out.type = p.type;
  return out;
}

function paramToParam(p: ParamInfo): ParamIR {
  const out: ParamIR = { name: p.name, is_optional: p.isOptional };
  if (p.type !== null) out.type = p.type;
  return out;
}

// ───────── Stores / Contexts ───────────────────────────────────────

export function mapStores(stores: StoreInfo[]): StoreIR[] {
  return stores.map((s) => ({
    name: s.name,
    file: s.filePath,
    kind: s.type,
    state_fields: s.state.map((f) => {
      const out: StoreIR['state_fields'][number] = { name: f.name };
      if (f.type !== null) out.type = f.type;
      if (f.defaultValue !== null) out.initial_value = f.defaultValue;
      return out;
    }),
    actions: s.actions.map(actionToIR),
    selectors: s.selectors.map((sel) => {
      const out: StoreIR['selectors'][number] = { name: sel.name };
      if (sel.returnType !== null) out.returns = sel.returnType;
      return out;
    }),
    framework_specific: s.middleware.length > 0 ? { middleware: s.middleware } : undefined,
  }));
}

export function mapContexts(contexts: ContextInfo[]): StoreIR[] {
  return contexts.map((c) => ({
    name: c.name,
    file: c.filePath,
    kind: 'context' as const,
    state_fields: c.valueType
      ? [{ name: 'value', type: c.valueType }]
      : [],
    actions: [],
    selectors: c.hookName ? [{ name: c.hookName }] : [],
    framework_specific: { provider_name: c.providerName },
  }));
}

function actionToIR(a: ActionInfo): StoreIR['actions'][number] {
  return {
    name: a.name,
    is_async: a.isAsync,
    // Legacy ActionInfo has params as plain string[] (names only) — wrap.
    params: a.params.map((name) => ({ name, is_optional: false })),
  };
}
