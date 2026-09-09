import type {
  AcceptanceCriterion,
  Actor,
  BusinessRule,
  Dok,
  Translatable,
  UserActionStep,
} from '@doklo-beta/core';
import { audienceText, type AudienceDictionary } from './helpers/audience-text.js';
import { containsSourcePath, replaceApplicationRoutes } from './public-copy-patterns.js';

const RESIDUAL_DEVELOPER_COPY = [
  /\bserver[- ]side\b/iu,
  /서버\s*사이드/iu,
  /\bAPI\b/u,
  /\bReact(?:\.js)?\s+component\b/iu,
  /(?:React|리액트)\s*컴포넌트/iu,
  /\buse[A-Z][A-Za-z0-9]*\s+hook\b/u,
  /\buse[A-Z][A-Za-z0-9]*\s*훅\b/u,
  /\bROLE-[A-Z0-9_-]+\b/u,
  /\[TERM:[^\]]+\]/u,
  /\bbcrypt(?:-hashed)?\b/iu,
  /\b(?:user\s+)?database\b/iu,
  /데이터베이스/iu,
  /\b(?:password\s+hash|hashed\s+password|stored\s+hash)\b/iu,
  /(?:비밀번호\s*(?:해시|해싱)|해시(?:된)?\s*비밀번호)/iu,
  /\b(?:user\s+record|stored\s+user\s+data)\b/iu,
  /사용자\s*(?:레코드|데이터)/iu,
  /\bpending(?:\/loading)?\s+state\b/iu,
  /(?:pending|로딩|대기)\s*(?:\/\s*로딩)?\s*상태/iu,
  /\b(?:request|submission)\s+is\s+pending\b/iu,
  /\bdisabled\s*\(pending\)/iu,
  /\bauthenticated\s+session\s+is\s+established\b/iu,
  /\b(?:without\s+a\s+session|no\s+session\s+is\s+created)\b/iu,
];

export interface StableHelpCopyChange {
  field: string;
  category: 'normalized' | 'omitted';
}

export interface StableHelpStep extends Omit<UserActionStep, 'intent' | 'outcome' | 'preconditions'> {
  source_index: number;
  display_number?: number;
  actor_label?: string;
  intent?: string;
  outcome?: string;
  preconditions: string[];
}

export interface StableHelpRule extends Omit<BusinessRule, 'description'> {
  description: string;
}

export interface StableHelpCriterion extends Omit<AcceptanceCriterion, 'statement'> {
  statement: string;
}

export interface StableHelpCopy {
  workspace_name?: string;
  title: string;
  description?: string;
  actors: Array<{ kind: Actor['kind']; label: string }>;
  steps: StableHelpStep[];
  rules: StableHelpRule[];
  criteria: StableHelpCriterion[];
}

export function prepareStableHelpCopy(args: {
  dok: Dok;
  workspaceName: string;
  resolve: (value: Translatable) => string;
  actorLabel: (actor: Actor) => string;
  audienceDictionary?: AudienceDictionary;
}): { copy: StableHelpCopy; changes: StableHelpCopyChange[]; unsafeTitle: boolean } {
  const changes: StableHelpCopyChange[] = [];
  const publicText = (value: Translatable, field: string): string | undefined => {
    const source = audienceText(args.resolve(value), args.audienceDictionary ?? []);
    const result = normalizePublicCopy(source, 'prose');
    if (result.category) {
      changes.push({ field, category: result.category });
    }
    return result.text;
  };
  const publicLabel = (source: string, field: string): string | undefined => {
    const result = normalizePublicCopy(source, 'label');
    if (result.category) {
      changes.push({ field, category: result.category });
    }
    return result.text;
  };

  const title = publicLabel(
    audienceText(args.resolve(args.dok.name), args.audienceDictionary ?? []),
    'title',
  );
  const workspaceName = publicLabel(
    audienceText(args.workspaceName, args.audienceDictionary ?? []),
    'workspace.name',
  );

  let displayNumber = 0;
  const steps = (args.dok.user_actions?.steps ?? []).flatMap((step, index) => {
    const actor = step.actor.kind === 'system'
      ? undefined
      : normalizePublicCopy(audienceText(
        args.actorLabel(step.actor),
        args.audienceDictionary ?? [],
      ), 'label');
    if (actor?.category) {
      changes.push({ field: `actions.steps[${index}].actor`, category: actor.category });
    }
    const intent = publicText(step.intent, `actions.steps[${index}].intent`);
    const outcome = publicText(step.outcome, `actions.steps[${index}].outcome`);
    const preconditions = (step.preconditions ?? []).flatMap((precondition, preconditionIndex) => {
      const text = publicText(
        precondition,
        `actions.steps[${index}].preconditions[${preconditionIndex}]`,
      );
      return text === undefined ? [] : [text];
    });
    const renderable = step.actor.kind === 'system'
      ? outcome !== undefined
      : intent !== undefined && actor?.text !== undefined;
    if (!renderable) return [];
    const {
      intent: _intent,
      outcome: _outcome,
      preconditions: _preconditions,
      ...publicStep
    } = step;
    return [{
      ...publicStep,
      source_index: index,
      ...(step.actor.kind === 'system' ? {} : { display_number: ++displayNumber }),
      ...(actor?.text === undefined ? {} : { actor_label: actor.text }),
      ...(intent === undefined ? {} : { intent }),
      ...(outcome === undefined ? {} : { outcome }),
      preconditions,
    }];
  });

  const rules = (args.dok.business_rules?.rules ?? []).flatMap((rule, index) => {
    const description = publicText(rule.description, `rules[${index}].description`);
    return description === undefined ? [] : [{ ...rule, description }];
  });

  const criteria = (args.dok.acceptance_criteria?.criteria ?? []).flatMap((criterion, index) => {
    const statement = publicText(criterion.statement, `checks[${index}].statement`);
    return statement === undefined ? [] : [{ ...criterion, statement }];
  });

  const actors: StableHelpCopy['actors'] = [];
  const seenActors = new Set<string>();
  for (const step of steps) {
    if (step.actor.kind === 'system' || !step.actor_label) continue;
    const key = step.actor.kind === 'role'
      ? `role:${step.actor.role_ref}`
      : `external:${step.actor.label}`;
    if (seenActors.has(key)) continue;
    seenActors.add(key);
    actors.push({ kind: step.actor.kind, label: step.actor_label });
  }

  return {
    copy: {
      ...(workspaceName === undefined ? {} : { workspace_name: workspaceName }),
      title: title ?? '',
      description: publicText(args.dok.description, 'description'),
      actors,
      steps,
      rules,
      criteria,
    },
    changes,
    unsafeTitle: title === undefined,
  };
}

function normalizePublicCopy(source: string, mode: 'label' | 'prose'): {
  text?: string;
  category?: StableHelpCopyChange['category'];
} {
  let text = source;
  let changed = false;
  const replace = (pattern: RegExp, replacement: string): void => {
    const next = text.replace(pattern, replacement);
    if (next !== text) changed = true;
    text = next;
  };

  // Reviewed source-preserving rewrites: each one keeps meaning already stated
  // in the input while removing storage or request-state vocabulary.
  replace(/\s+via\s+(?:an?\s+)?server[- ]side\s+authenticated\s+form\b/giu, '');
  replace(/\bForm data is sent to the server[- ]side sign-in action and\s+/giu, '');
  replace(/\b(?:the\s+)?submit button enters a pending\/loading state\b/giu,
    'the submit button shows that processing is in progress');
  replace(/\bwhen the request is pending\b/giu, 'while the request is being processed');
  replace(/\s*\(pending\)/giu, '');
  replace(/\ba user record exists for the given email\b/giu, 'an account exists for the given email');
  replace(
    /\bthe provided password matches the stored bcrypt-hashed password\b/giu,
    'the provided password is correct for that account',
  );
  replace(/\bEmail exists in the user database\b/giu, 'Email belongs to a registered account');
  replace(/\bPassword matches the stored hashed password\b/giu, 'Password is correct for that account');
  replace(/\bAuthenticated session is established and (?:the )?user\b/giu, 'The user');
  replace(/\s+without a session\b/giu, '');
  replace(/\band no session is created\b/giu, 'and the user remains signed out');
  replace(
    /(?<![A-Za-z0-9._:/-])(?:(?:a|an|the)\s+)?\/protected\b(?:\s+route)?/giu,
    'the protected area',
  );
  replace(/\b(?:the\s+)?protected route\b/giu, 'the protected area');
  replace(
    /(?<![A-Za-z0-9._:/-])(?:(?:a|an|the)\s+)?\/register\b(?:\s+page)?/giu,
    'the sign-up page',
  );

  const routeReplacement = /[가-힣]/u.test(text) ? '해당 페이지' : 'the page';
  const withoutApplicationRoutes = replaceApplicationRoutes(text, routeReplacement);
  if (withoutApplicationRoutes !== text) changed = true;
  text = withoutApplicationRoutes;

  // Remove named implementation mechanisms, including Korean particles, but
  // leave the surrounding customer wording intact when it stands on its own.
  if (mode === 'label') {
    replace(/\bReact(?:\.js)?\s+component\b/giu, '');
    replace(/(?:React|리액트)\s*컴포넌트(?:에서|가|를|은|는|으로)?/giu, '');
    replace(/\buse[A-Z][A-Za-z0-9]*\s+hook\b/gu, '');
    replace(/\buse[A-Z][A-Za-z0-9]*\s*훅(?:에서|이|가|을|를|은|는|으로)?/gu, '');
    replace(/\bROLE-[A-Z0-9_-]+\b/gu, '');
    replace(/\[TERM:[^\]]+\]/gu, '');
    replace(/\b(?:through|via|using|from|to)\s+(?:the\s+)?API\b/giu, '');
    replace(/\bAPI(?:에서|가|를|은|는|로|으로)?\b/gu, '');
  }

  text = cleanCopy(text);
  if (hasDeveloperCopy(text)) {
    const safe = retainSafeClauses(text);
    if (safe !== text) changed = true;
    text = safe;
  }
  text = cleanCopy(text);
  if (text.length === 0 || hasDeveloperCopy(text)) {
    return { category: 'omitted' };
  }
  return changed ? { text, category: 'normalized' } : { text };
}

function hasDeveloperCopy(value: string): boolean {
  return containsSourcePath(value)
    || RESIDUAL_DEVELOPER_COPY.some((pattern) => pattern.test(value));
}

function retainSafeClauses(value: string): string {
  const sentences = value.match(/.+?(?:[!?。！？]|\.(?=\s|$)|$)/gu) ?? [value];
  const retained: string[] = [];
  for (const sentence of sentences) {
    const candidate = sentence.trim();
    if (!candidate) continue;
    if (!hasDeveloperCopy(candidate)) {
      retained.push(candidate);
      continue;
    }
    const punctuation = /[.!?。！？]$/u.exec(candidate)?.[0] ?? '';
    const body = punctuation ? candidate.slice(0, -1) : candidate;
    const clauses = body.split(
      /(?:\s*;\s*|,\s*(?:and|but)\s+|\s+(?:and|but)\s+|\s+그리고\s+|하고\s+|하며\s+)/iu,
    ).map(cleanCopy).filter(Boolean);
    const safe = /[가-힣]/u.test(body)
      ? retainCompleteKoreanClauses(clauses)
      : clauses.filter((clause) => !hasDeveloperCopy(clause));
    if (safe.length > 0) retained.push(`${safe.join('. ')}${punctuation}`);
  }
  return retained.join(' ');
}

function retainCompleteKoreanClauses(clauses: string[]): string[] {
  const classified = clauses.map((clause) => ({
    clause,
    unsafe: hasDeveloperCopy(clause),
    complete: isCompleteKoreanClause(clause),
  }));
  const hasBrokenSafePrefix = classified.some((item, index) => (
    !item.unsafe
    && !item.complete
    && classified.slice(index + 1).some((later) => later.unsafe)
  ));
  if (hasBrokenSafePrefix) return [];
  return classified
    .filter((item) => !item.unsafe && item.complete)
    .map((item) => item.clause);
}

function isCompleteKoreanClause(value: string): boolean {
  return /[가-힣](?:습니다|ㅂ니다|니다|다|요|세요)$/u.test(value);
}

function cleanCopy(value: string): string {
  const cleaned = value
    .replace(/\s+/gu, ' ')
    .replace(/\s+([,.;!?。！？])/gu, '$1')
    .replace(/^(?:,|;|and\b|but\b|그리고\b)\s*/iu, '')
    .replace(/\s+(?:and|but|그리고)$/iu, '')
    .trim();
  return /^[a-z]/u.test(cleaned)
    ? `${cleaned[0]!.toUpperCase()}${cleaned.slice(1)}`
    : cleaned;
}
