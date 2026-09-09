/**
 * Validate the Doklo Studio demo workspace against the core v5 schemas.
 *
 * Scans <demoRoot> (default: apps/studio/demo) and parses every hub file
 * with its @doklo-beta/core zod schema:
 *   - workspace.json                 -> WorkspaceSchema
 *   - .doklo/hub/doks/*.json         -> DokSchema
 *   - .doklo/hub/lexicon.json        -> LexiconFileSchema
 *   - .doklo/hub/roles.json          -> RolesFileSchema
 *   - .doklo/hub/services/<id>/ia.json  -> IA v1 or v2, by declared version
 *
 * Then checks cross-file reference integrity so the demo stays coherent:
 *   - a Dok TermRef (name/description/steps/rules/criteria) resolves in the lexicon
 *   - a Dok actor role / rule.applies_to_roles resolves in roles.json
 *   - a role name TermRef resolves in the lexicon
 *   - an IA node dok_ref resolves in doks, and an IA label TermRef in the lexicon
 *
 * `extends` and `related_doks` are intentionally NOT reference-checked: they
 * are soft (RBAC pool / reverse index) in the source model.
 *
 * Prints a per-file report and exits 1 on any schema or reference violation
 * so it can gate CI and manual runs. Exits 0 (green) when everything resolves.
 *
 * Run: pnpm -C apps/studio exec tsx scripts/validate-demo.ts [demoRoot]
 */

import { readdir, readFile, stat } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { ZodType } from 'zod';
import {
  DokSchema,
  LexiconFileSchema,
  RolesFileSchema,
  WorkspaceSchema,
  parseIaFileAnyVersion,
  type Dok,
  type IaNodeV1,
  type IaNodeV2,
  type TermRef,
} from '@doklo-beta/core';

const __dirname = dirname(fileURLToPath(import.meta.url));
const demoRoot = process.argv[2]
  ? resolve(process.argv[2])
  : resolve(__dirname, '../demo');
const hubDir = join(demoRoot, '.doklo', 'hub');

const errors: string[] = [];
const fail = (msg: string): void => {
  errors.push(msg);
};

async function readJson(path: string): Promise<unknown> {
  return JSON.parse(await readFile(path, 'utf8')) as unknown;
}

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

/** Parse `raw` with `schema`; on failure record every issue and return null. */
function parseOrFail<T>(label: string, schema: ZodType<T>, raw: unknown): T | null {
  const result = schema.safeParse(raw);
  if (result.success) {
    console.log(`  ok    ${label}`);
    return result.data;
  }
  console.log(`  FAIL  ${label}`);
  for (const issue of result.error.issues) {
    const path = issue.path.map((p) => String(p)).join('.') || '<root>';
    fail(`[schema] ${label}: ${path} — ${issue.message}`);
  }
  return null;
}

/**
 * Parse an ia.json under whichever contract it declares. Reporting matches
 * `parseOrFail`; the accepted version is printed so a demo that is still v1
 * is visible rather than silently assumed.
 */
function parseIaOrFail(
  label: string,
  raw: unknown,
): ReturnType<typeof parseIaFileAnyVersion> | null {
  try {
    const document = parseIaFileAnyVersion(raw);
    console.log(`  ok    ${label} (v${document.version})`);
    return document;
  } catch (error) {
    console.log(`  FAIL  ${label}`);
    const issues = (error as { issues?: { path?: unknown[]; message: string }[] })
      .issues;
    if (issues) {
      for (const issue of issues) {
        const path = (issue.path ?? []).map((p) => String(p)).join('.') || '<root>';
        fail(`[schema] ${label}: ${path} — ${issue.message}`);
      }
    } else {
      fail(`[schema] ${label}: ${String(error)}`);
    }
    return null;
  }
}

/** Return the referenced term id when `t` is a TermRef, else null. */
function termRefOf(t: string | TermRef | null | undefined): string | null {
  return t && typeof t === 'object' && 'term_ref' in t ? t.term_ref : null;
}

async function main(): Promise<void> {
  console.log(`Validating demo workspace: ${demoRoot}\n`);

  // ── Schema validation ──────────────────────────────────────────────
  console.log('schemas:');

  const workspace = parseOrFail(
    'workspace.json',
    WorkspaceSchema,
    await readJson(join(demoRoot, 'workspace.json')),
  );

  const doks: Dok[] = [];
  const doksDir = join(hubDir, 'doks');
  const dokFiles = (await readdir(doksDir))
    .filter((f) => f.endsWith('.json'))
    .sort();
  for (const file of dokFiles) {
    const dok = parseOrFail(`doks/${file}`, DokSchema, await readJson(join(doksDir, file)));
    if (dok) doks.push(dok);
  }

  const lexicon = parseOrFail(
    'lexicon.json',
    LexiconFileSchema,
    await readJson(join(hubDir, 'lexicon.json')),
  );

  const roles = parseOrFail(
    'roles.json',
    RolesFileSchema,
    await readJson(join(hubDir, 'roles.json')),
  );

  // IA is per-service and optional; discover via the workspace service list.
  const iaV1Trees: { serviceId: string; nodes: IaNodeV1[] }[] = [];
  const iaV2Trees: { serviceId: string; nodes: IaNodeV2[] }[] = [];
  let iaTreeCount = 0;
  for (const service of workspace?.services ?? []) {
    const file = join(hubDir, 'services', service.service_id, 'ia.json');
    if (!(await exists(file))) continue;
    const ia = parseIaOrFail(
      `services/${service.service_id}/ia.json`,
      await readJson(file),
    );
    if (!ia) continue;
    if (ia.version === 2) {
      for (const tree of ia.file.trees) {
        iaTreeCount += 1;
        iaV2Trees.push({ serviceId: service.service_id, nodes: tree.nodes });
      }
    } else {
      for (const tree of ia.file.trees) {
        iaTreeCount += 1;
        iaV1Trees.push({ serviceId: service.service_id, nodes: tree.nodes });
      }
    }
  }

  // ── Reference integrity ────────────────────────────────────────────
  console.log('\nreferences:');
  const dokIds = new Set(doks.map((d) => d.dok_id));
  const termIds = new Set(lexicon?.terms.map((t) => t.term_id) ?? []);
  const roleIds = new Set(roles?.roles.map((r) => r.role_id) ?? []);

  const before = errors.length;

  for (const dok of doks) {
    const label = `doks/${dok.dok_id}`;
    const checkTerm = (t: string | TermRef | undefined, where: string): void => {
      const ref = termRefOf(t);
      if (ref && !termIds.has(ref)) {
        fail(`[refs] ${label}: TermRef ${ref} (${where}) not in lexicon`);
      }
    };
    checkTerm(dok.name, 'name');
    checkTerm(dok.description, 'description');
    for (const step of dok.user_actions?.steps ?? []) {
      checkTerm(step.intent, `step ${step.order} intent`);
      checkTerm(step.outcome, `step ${step.order} outcome`);
      if (step.actor.kind === 'role' && !roleIds.has(step.actor.role_ref)) {
        fail(`[refs] ${label}: actor role ${step.actor.role_ref} (step ${step.order}) not in roles`);
      }
      for (const variant of step.variants) {
        checkTerm(variant.target, `step ${step.order} variant target`);
        checkTerm(variant.outcome_override, `step ${step.order} variant outcome`);
      }
    }
    for (const rule of dok.business_rules?.rules ?? []) {
      checkTerm(rule.description, `rule ${rule.id}`);
      for (const role of rule.applies_to_roles ?? []) {
        if (!roleIds.has(role)) {
          fail(`[refs] ${label}: rule ${rule.id} applies_to_role ${role} not in roles`);
        }
      }
    }
    for (const criterion of dok.acceptance_criteria?.criteria ?? []) {
      checkTerm(criterion.statement, `criterion ${criterion.id}`);
    }
  }

  for (const role of roles?.roles ?? []) {
    const ref = termRefOf(role.name);
    if (ref && !termIds.has(ref)) {
      fail(`[refs] roles/${role.role_id}: name TermRef ${ref} not in lexicon`);
    }
  }

  const walkIaV1 = (nodes: IaNodeV1[], service: string): void => {
    for (const node of nodes) {
      const at = node.path ?? '(no path)';
      const ref = termRefOf(node.label);
      if (ref && !termIds.has(ref)) {
        fail(`[refs] ia/${service}: label TermRef ${ref} (${at}) not in lexicon`);
      }
      if (typeof node.dok_ref === 'string' && !dokIds.has(node.dok_ref)) {
        fail(`[refs] ia/${service}: dok_ref ${node.dok_ref} (${at}) not in doks`);
      }
      walkIaV1(node.children, service);
    }
  };
  const walkIaV2 = (nodes: IaNodeV2[], service: string): void => {
    for (const node of nodes) {
      const at = node.path ?? '(no path)';
      const ref = termRefOf(node.label);
      if (ref && !termIds.has(ref)) {
        fail(`[refs] ia/${service}: label TermRef ${ref} (${at}) not in lexicon`);
      }
      if (node.kind === 'destination') {
        for (const binding of node.bindings) {
          if (!dokIds.has(binding.dok_ref)) {
            fail(
              `[refs] ia/${service}: dok_ref ${binding.dok_ref} (${at}) not in doks`,
            );
          }
        }
      }
      walkIaV2(node.children, service);
    }
  };
  for (const { serviceId, nodes } of iaV1Trees) walkIaV1(nodes, serviceId);
  for (const { serviceId, nodes } of iaV2Trees) walkIaV2(nodes, serviceId);

  console.log(
    errors.length === before
      ? '  ok    all TermRefs, actor roles, and IA dok_refs resolve'
      : '  FAIL  see reference errors below',
  );

  // ── Result ─────────────────────────────────────────────────────────
  if (errors.length) {
    console.error(`\nFAIL — ${errors.length} problem(s):`);
    for (const e of errors) console.error(`  ${e}`);
    process.exit(1);
  }
  console.log(
    `\nPASS — ${doks.length} doks, ${termIds.size} terms, ${roleIds.size} roles, ` +
      `${iaTreeCount} IA tree(s): all schemas and references valid.`,
  );
  process.exit(0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
