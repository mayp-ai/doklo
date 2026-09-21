import type {
  AcceptanceCriterion,
  Actor,
  CodeAnchor,
  Dok,
  Translatable,
  Workspace,
} from '@doklo-beta/core';

export interface DetailEvidence {
  file: string | null;
  startLine: number | null;
  endLine: number | null;
  label: string | null;
}

export interface DetailStep {
  order: number;
  actorKind: Actor['kind'];
  actor: string;
  intent: string;
  outcome: string;
  preconditions: string[];
  variants: string[];
  evidence: DetailEvidence[];
}

export interface DetailRule {
  id: string;
  shortId: string;
  description: string;
  type: string;
  relatedCriteria: string[];
  appliesToRoles: string[];
  evidence: DetailEvidence | null;
}

export interface DetailCriterion {
  id: string;
  shortId: string;
  statement: string;
  relatedRules: string[];
  given: string | null;
  when: string | null;
  then: string | null;
}

export interface DetailAnchor {
  file: string;
  startLine: number | null;
  endLine: number | null;
  symbol: string | null;
}

export interface DokDetailProjection {
  name: string;
  description: string;
  steps: DetailStep[];
  rules: DetailRule[];
  criteria: DetailCriterion[];
  anchors: DetailAnchor[];
}

export function translatableText(value: Translatable): string {
  return typeof value === 'string' ? value : `{${value.term_ref}}`;
}

function actorText(actor: Actor): string {
  if (actor.kind === 'role') return actor.role_ref.replace(/^ROLE-/, '').toLowerCase();
  if (actor.kind === 'external') return actor.label;
  return 'system';
}

function shortId(id: string, dokId: string): string {
  return id.replace(`${dokId}-`, '');
}

function cleanSegmentedPath(value: string): string | null {
  const path = value.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!path || path.startsWith('/') || path.includes('://') || path.split('/').includes('..')) {
    return null;
  }
  return path.split('/').filter((segment) => segment && segment !== '.').join('/');
}

function withCodeRoot(file: string, serviceId: string | undefined, workspace: Workspace): string | null {
  const safeFile = cleanSegmentedPath(file);
  if (safeFile === null) return null;
  const root = workspace.services.find((service) => service.service_id === serviceId)?.code_root;
  if (!root || root === '.') return safeFile;
  const safeRoot = cleanSegmentedPath(root);
  return safeRoot === null ? safeFile : `${safeRoot}/${safeFile}`;
}

function parseCodeFile(raw: string): { file: string; startLine: number | null; endLine: number | null } {
  const match = /^(.*?)(?:#L(\d+)(?:[-:]L?(\d+))?)?$/.exec(raw);
  return {
    file: match?.[1] ?? raw,
    startLine: match?.[2] ? Number(match[2]) : null,
    endLine: match?.[3] ? Number(match[3]) : match?.[2] ? Number(match[2]) : null,
  };
}

function evidenceFromAnchor(
  anchor: CodeAnchor | undefined,
  serviceId: string | undefined,
  workspace: Workspace,
): DetailEvidence | null {
  if (!anchor) return null;
  const labels = [anchor.function, anchor.component, anchor.api, anchor.validation,
    anchor.constant, anchor.db_constraint, anchor.db_field].filter((value): value is string => Boolean(value));
  if (!anchor.file) {
    return labels.length === 0 ? null : { file: null, startLine: null, endLine: null, label: labels.join(' · ') };
  }
  const parsed = parseCodeFile(anchor.file);
  const file = withCodeRoot(parsed.file, serviceId, workspace);
  if (file === null && labels.length === 0) return null;
  return { file, startLine: parsed.startLine, endLine: parsed.endLine, label: labels.length === 0 ? null : labels.join(' · ') };
}

function criterionView(criterion: AcceptanceCriterion, dokId: string): DetailCriterion {
  return {
    id: criterion.id,
    shortId: shortId(criterion.id, dokId),
    statement: translatableText(criterion.statement),
    relatedRules: criterion.related_rules,
    given: criterion.given ?? null,
    when: criterion.when ?? null,
    then: criterion.then ?? null,
  };
}

export function projectDokDetail(dok: Dok, workspace: Workspace): DokDetailProjection {
  const serviceId = dok._meta.anchor_service_id ?? dok.surfaces[0]
    ?? (workspace.services.length === 1 ? workspace.services[0]?.service_id : undefined);
  const criteria = (dok.acceptance_criteria?.criteria ?? []).map((criterion) =>
    criterionView(criterion, dok.dok_id));

  return {
    name: translatableText(dok.name),
    description: translatableText(dok.description),
    steps: (dok.user_actions?.steps ?? []).map((step) => ({
      order: step.order,
      actorKind: step.actor.kind,
      actor: actorText(step.actor),
      intent: translatableText(step.intent),
      outcome: translatableText(step.outcome),
      preconditions: step.preconditions ?? [],
      variants: step.variants.map((variant) =>
        [variant.platform, variant.interaction, variant.target && translatableText(variant.target), variant.outcome_override && `outcome: ${translatableText(variant.outcome_override)}`]
          .filter(Boolean).join(' · ')),
      evidence: step.variants.flatMap((variant) => {
        const evidence = evidenceFromAnchor(variant.code_anchor, serviceId, workspace);
        return evidence === null ? [] : [evidence];
      }),
    })),
    rules: (dok.business_rules?.rules ?? []).map((rule) => ({
      id: rule.id,
      shortId: shortId(rule.id, dok.dok_id),
      description: translatableText(rule.description),
      type: rule.type,
      relatedCriteria: criteria
        .filter((criterion) => criterion.relatedRules.includes(rule.id))
        .map((criterion) => criterion.id),
      appliesToRoles: rule.applies_to_roles ?? [],
      evidence: evidenceFromAnchor(rule.code_anchor, serviceId, workspace),
    })),
    criteria,
    anchors: (dok._meta.source_anchors ?? []).flatMap((anchor) => {
      const anchorService = anchor.service_id ?? serviceId;
      const file = withCodeRoot(anchor.file, anchorService, workspace);
      return file === null ? [] : [{
        file,
        startLine: anchor.start_line ?? null,
        endLine: anchor.end_line ?? anchor.start_line ?? null,
        symbol: anchor.symbol ?? null,
      }];
    }),
  };
}
