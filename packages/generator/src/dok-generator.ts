// Per-feature Dok generation.
//
// Two pure helpers (buildDokPrompt, parseDokFromLLMResponse) and one
// async orchestrator (generateDokForFeature) that wraps them around
// callClaude. The prompt is intentionally lean — schema example +
// feature context + file excerpts. Schema is taught via a TypeScript
// shape rather than the raw Zod (LLMs handle TS types well).

import {
  DokSchema,
  type Dok,
  type DokPriorityField,
  type RoleId,
} from '@doklo-beta/core';
import {
  callModel,
  DEFAULT_LLM_CONFIG,
  joinPromptParts,
  type LLMFailureKind,
  type LLMUsage,
  type PromptParts,
  type ProviderKind,
} from './llm-client.js';
import { extractJsonFromResponse } from './validate.js';

/**
 * Caller-built input shape for Dok generation.
 *
 * Decoupled from the legacy ConsolidatedFeature so that the CLI (or any
 * other caller) can mix in source-feature data — file paths, member
 * routes — that doesn't ride along on a ConsolidatedFeature itself.
 */
export interface FeatureForGeneration {
  canonical_id: string;
  label: string;
  dok_id_prefix: string;
  primary_route: string;
  /** Member feature ids that rolled up into this consolidated feature. */
  members: { id: string; label: string; route: string }[];
  /** File paths relevant to this feature (relative to projectRoot). */
  files: string[];
  /**
   * Drift-only file set — a superset of `files` that additionally includes the
   * shared infra this feature reaches. When present, the CLI hashes this (not
   * `files`) into `_meta.logic_hash` and records it as `_meta.logic_files`, so a
   * change to a shared dependency is still caught. Absent for legacy caches, in
   * which case the CLI falls back to hashing `files`. Never sent to the LLM.
   */
  logic_files?: string[];
}

export interface DokGenContext {
  defaultLocale: string;
  knownRoles: RoleId[];
  /** Map of relative path → file content (already read by the CLI). */
  fileContext: Record<string, string>;
  /** dok_id assigned by the caller (semantic id). */
  dokId: string;
  /**
   * Suggested primary actor for this feature, derived by the caller from the
   * representative route path (e.g. /admin/* → ROLE-ADMIN). When set, the
   * prompt nudges the LLM to prefer this role over the ROLE-USER fallback.
   */
  suggestedActorRole?: RoleId;
  /**
   * Canonical domain terms (approved Lexicon entries + pending
   * suggestions). When set, the prompt instructs the model to use these
   * exact wordings — terminology consistency is enforced at write time,
   * not patched afterwards.
   */
  lexiconTerms?: string[];
  /**
   * Priority axes a person has already pinned on this Dok. The prompt states
   * they are settled and tells the model to omit them — not asking is the only
   * reliable way to stop it arguing with a human's call, and it saves tokens.
   *
   * Per-feature, so this lands in the user prompt, never the cached system one.
   */
  lockedPriority?: { field: DokPriorityField; value: string; reason: string }[];
}

export interface GenerateDokOptions {
  model?: string;
  maxTokens?: number;
  timeout?: number;
  apiKey?: string;
  providerKind?: ProviderKind;
  baseURL?: string;
  /** Custom fetch forwarded to the AI SDK provider factory (e.g. for Codex OAuth). */
  fetch?: typeof fetch;
  debugDir?: string;
  /** Exact caller-authorized provider prompt parts. When present, do not rebuild them. */
  preparedPrompt?: PromptParts;
  /** Cancels the in-flight provider call. */
  signal?: AbortSignal;
}

export interface GenerateDokResult {
  success: boolean;
  dok: Dok | null;
  prompt: string;
  rawResponse: string | null;
  usage: LLMUsage | null;
  interrupted?: boolean;
  /** Stable provider failure classification; provider raw detail is debug-only. */
  failureKind?: LLMFailureKind;
  error?: string;
}

export async function generateDokForFeature(
  feature: FeatureForGeneration,
  ctx: DokGenContext,
  options: GenerateDokOptions = {},
): Promise<GenerateDokResult> {
  const promptParts = options.preparedPrompt ?? buildDokPromptParts(feature, ctx);
  const prompt = joinPromptParts(promptParts);
  const config = {
    ...DEFAULT_LLM_CONFIG,
    model: options.model ?? DEFAULT_LLM_CONFIG.model,
    // Reasoning models count hidden thinking against the output budget, so a
    // 4096 cap can truncate the Dok JSON mid-string. Default to 8192.
    maxTokens: options.maxTokens ?? 8192,
    // 5min default — Claude Code backend's first call routinely takes
    // 60-90s due to ~65K-token system-prompt cache creation; with retry
    // jitter and slow models a 2min budget bites occasionally.
    timeout: options.timeout ?? 300_000,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.providerKind !== undefined ? { providerKind: options.providerKind } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.debugDir !== undefined ? { debugDir: options.debugDir } : {}),
  };

  const llm = await callModel(
    {
      systemPrompt: promptParts.systemPrompt,
      userPrompt: promptParts.userPrompt,
      // The systemPrompt is identical for every dok call in one generate run,
      // so mark it cacheable: Anthropic needs the explicit ephemeral marker,
      // OpenAI caches 1024+-token prefixes automatically, other providers
      // ignore the flag.
      cacheableSystemPrompt: true,
      label: `dok-${ctx.dokId}`,
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    },
    config,
  );

  if (options.signal?.aborted || llm.error?.type === 'aborted') {
    return {
      success: false,
      dok: null,
      prompt,
      rawResponse: null,
      usage: llm.usage,
      interrupted: true,
      error: 'Generation interrupted.',
    };
  }

  if (!llm.success || !llm.content) {
    return {
      success: false,
      dok: null,
      prompt,
      rawResponse: null,
      usage: llm.usage,
      ...(llm.error === null ? {} : { failureKind: llm.error.type }),
      error: llm.error?.message ?? 'LLM call failed',
    };
  }

  const parsed = parseDokFromLLMResponse(llm.content);
  if (!parsed.success || !parsed.dok) {
    // parseDokFromLLMResponse is pure and doesn't know why the model stopped.
    // If it hit the token limit, the JSON is truncated — upgrade the cryptic
    // parse error into an actionable truncation message here, where finishReason
    // is in scope.
    const truncated = llm.finishReason === 'length'
      || hasUnclosedJsonStructure(llm.content);
    const error = truncated
      ? 'LLM output was incomplete or truncated before the JSON completed.'
      : parsed.error ?? 'Failed to parse Dok';
    return {
      success: false,
      dok: null,
      prompt,
      rawResponse: llm.content,
      usage: llm.usage,
      ...(truncated ? { failureKind: 'truncated_response' as const } : {}),
      error,
    };
  }

  return {
    success: true,
    dok: parsed.dok,
    prompt,
    rawResponse: llm.content,
    usage: llm.usage,
  };
}

function hasUnclosedJsonStructure(raw: string): boolean {
  const firstObject = raw.indexOf('{');
  const firstArray = raw.indexOf('[');
  const start = firstObject === -1
    ? firstArray
    : firstArray === -1
      ? firstObject
      : Math.min(firstObject, firstArray);
  if (start === -1) return false;

  const stack: string[] = [];
  let inString = false;
  let escaped = false;
  for (const char of raw.slice(start)) {
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }
    if (char === '"') {
      inString = true;
    } else if (char === '{' || char === '[') {
      stack.push(char);
    } else if (char === '}' || char === ']') {
      const expected = char === '}' ? '{' : '[';
      if (stack.at(-1) !== expected) return false;
      stack.pop();
    }
  }
  return inString || stack.length > 0;
}

// ───────── Pure helpers (testable without an API key) ────────────────

/**
 * Split Dok prompt: the systemPrompt carries only per-run-stable context
 * (instructions, Dok schema, roles, terminology — identical for every dok in
 * one generate run, so the provider can cache it), and the userPrompt carries
 * the per-feature facts (dok_id, actor hint, feature block, file excerpts).
 * Anything interpolated per feature MUST stay out of the systemPrompt or the
 * cache never hits.
 */
export function buildDokPromptParts(
  feature: FeatureForGeneration,
  ctx: DokGenContext,
): PromptParts {
  const language = ctx.defaultLocale === 'ko' ? 'Korean (한국어)' : 'English';
  const fileBlocks = Object.entries(ctx.fileContext)
    .map(
      ([path, content]) =>
        `### ${path}\n\n\`\`\`tsx\n${truncate(content, 2_000)}\n\`\`\``,
    )
    .join('\n\n');
  const rolesList = renderDokRolesBlock(ctx.knownRoles);

  const actorHint = ctx.suggestedActorRole
    ? `\n\n# Suggested primary actor

This feature's representative route is \`${feature.primary_route}\`. By
convention that route prefix maps to **${ctx.suggestedActorRole}**. Prefer
\`{kind:'role', role_ref:'${ctx.suggestedActorRole}'}\` for steps the human
operator performs in this feature, unless step semantics clearly indicate
a different role (for example, a sign-in flow always involves ROLE-USER
even when the page lives under an admin namespace).

Use \`{kind:'system'}\` for automated steps regardless.`
    : '';

  const terminologySection =
    ctx.lexiconTerms && ctx.lexiconTerms.length > 0
      ? `\n\n# Terminology (canonical domain terms)

When any text field (name, description, intent, outcome, business-rule
or acceptance-criterion statements) refers to one of these concepts or
features, use the exact wording below — never a synonym or paraphrase:

${ctx.lexiconTerms.map((t) => `  - ${t}`).join('\n')}`
      : '';

  const systemPrompt = `You are an expert technical writer extracting one business feature
("Dok") from a Next.js codebase.

# Output language

Respond strictly in **${language}**. The fields \`name\`, \`description\`, every
\`intent\` and \`outcome\`, and every business-rule / acceptance-criterion
\`statement\` must be in ${language}. Identifiers (dok_id, role_ref, ids) stay
ASCII.${ctx.defaultLocale === 'ko' ? `

# Korean style (customer-facing help copy)

- End every sentence in the formal polite register (합쇼체: ~합니다, ~됩니다,
  ~할 수 있습니다). Never use the plain register (~한다, ~된다, ~이다).
- Describe what the actor does and what appears on screen. Do not write
  intention formulas such as "~하고자 한다" or "~하려고 한다".
- Do not put a comma after a connective ending (write "누르면 목록이 열립니다",
  not "누르면, 목록이 열립니다"). Avoid "~을 통해"; name the action directly.
- Write the product's own words, not code names: no identifiers, function
  names, or English technical verbs inside Korean sentences.` : ''}

# Output format

Respond with **one JSON object** matching the Dok type below. No prose, no
markdown fences — JSON only.

\`\`\`ts
type Dok = {
  dok_id: string;          // MUST be exactly the dok_id given in the task
  name: string;            // short business name (≤ 8 words)
  tags: string[];          // 2-6 lowercase keywords
  surfaces: ('web'|'mobile'|'admin'|'api')[];
  priority: {              // two independent axes — see constraint 7
    impact: 'revenue'|'core_value'|'compliance'|'enabling'|'supporting';
    blast_radius: 'blocking'|'degrading'|'cosmetic';
  };
  description: string;     // 1-3 sentences in ${language}
  user_actions: {
    steps: Array<{
      order: number;       // starts at 1, sequential
      actor:
        | { kind: 'role'; role_ref: string }   // pick from known roles
        | { kind: 'system' }                    // automated
        | { kind: 'external'; label: string };  // 3rd-party / human-outside-system
      intent: string;      // platform-agnostic invariant: what the actor wants
      outcome: string;     // observable result of the intent
      variants: Array<{
        platform: 'desktop'|'mobile'|'tablet'|'tv'|'cli'|'voice'|'all';
        interaction: 'click'|'tap'|'swipe-left'|'swipe-right'|'swipe-up'|
                     'swipe-down'|'long-press'|'hover'|'keyboard'|'voice'|
                     'drag'|'scroll'|'input'|'submit'|'navigate'|'auto';
      }>;                  // at least one — use {platform:'all', interaction:'auto'} as fallback
      preconditions?: string[];
    }>;
  };
  business_rules: {
    rules: Array<{
      id: string;          // BR-{DOK_ID}-NN, e.g., BR-AUTH-01 when the dok_id is AUTH
      description: string;
      type: 'restriction'|'policy'|'validation'|'calculation'|'permission';
      applies_to_roles?: string[];
    }>;
  };
  acceptance_criteria: {
    criteria: Array<{
      id: string;          // AC-{DOK_ID}-NN, e.g., AC-AUTH-01 when the dok_id is AUTH
      statement: string;
      related_rules: string[]; // ids of BRs this AC verifies (may be [])
    }>;
  };
};
\`\`\`

# Known roles (use these for actor.role_ref)

${rolesList}${terminologySection}

# Constraints

1. \`dok_id\` MUST equal the dok_id given in the task, exactly.
2. Produce 3–7 \`user_actions.steps\` covering happy path + at least one
   non-trivial branch. Use \`order\` 1..N consecutively.
3. Produce 1–4 \`business_rules.rules\`. If you cannot infer any from the
   code, return an empty array (do not invent rules). Rule ids MUST
   follow exactly: \`BR-{DOK_ID}-NN\` where {DOK_ID} is the dok_id given
   in the task and NN is a zero-padded two-digit serial starting at 01
   (so the first rule for dok_id AUTH is \`BR-AUTH-01\`).
4. Produce 2–6 \`acceptance_criteria.criteria\`. Each id MUST follow
   \`AC-{DOK_ID}-NN\` (same NN convention as rule ids). Each
   \`related_rules\` entry must be an existing rule id from the same
   Dok.
5. Each step's \`actor\` MUST be one of the discriminated-union shapes
   shown above — do not return raw strings like "user" or "admin".
6. Every \`variants\` array must have at least one entry; if you have no
   platform-specific UI to model, use
   \`[{"platform":"all","interaction":"auto"}]\`.
7. Judge \`priority\` on two independent axes. Never rank the Dok overall —
   the two axes are combined downstream, and collapsing them yourself
   destroys the distinction the axes exist to make.

   \`impact\` — what the business loses if this breaks:
     - \`revenue\`      money actually moves, or a balance is credited or
                      debited (checkout, credits, settlement, refunds).
                      Includes the steps the money flow cannot complete
                      without, even administrative ones such as confirming a
                      received bank transfer.
                      Reading or DISPLAYING a price, plan, or balance is not
                      \`revenue\` — a pricing page sells nothing by itself and
                      is \`enabling\`. Code near this feature may reference
                      money-typed models for display alone; that proves money
                      is nearby, not that it moves here.
     - \`core_value\`   the feature that PRODUCES the output the product exists
                      for, or the controls that govern that output's quality.
                      Listing, browsing, or administering the entities the
                      output involves — projects, plans, members, accounts —
                      is \`enabling\`, not \`core_value\`. Ask: does the output
                      come into being here, or is this a way to get to it?
     - \`compliance\`   a legal or contractual obligation. You MUST name the
                      obligation in the \`description\` if you choose this
                      (for example: a deletion right, a consent basis, a
                      disclosure duty). If you cannot name one, it is not
                      \`compliance\`.
     - \`enabling\`     produces no value by itself, but the three above are
                      unreachable without it (sign-in, upload, permissions).
     - \`supporting\`   the three above stay reachable without it.

   \`blast_radius\` — how many users are stopped if this breaks:
     - \`blocking\`     every user is stopped, with no way around it.
     - \`degrading\`    some features, or some users.
     - \`cosmetic\`     inconvenient, but the user can still finish.

   Judge each axis on its own. A sign-in screen is \`enabling\` and
   \`blocking\` at once — that combination is expected, not a contradiction.
   Do NOT infer impact from the route path: an \`/admin\` screen is regularly
   the highest-impact Dok in a product, because approval and configuration
   steps often gate the money flow or the output quality.`;

  // Per-feature, so it belongs here and never in the cached system prompt.
  // Stating a pinned axis as settled — rather than filtering the answer after
  // the fact — means the model has no opening to overwrite a human's call.
  const lockedSection =
    ctx.lockedPriority !== undefined && ctx.lockedPriority.length > 0
      ? `\n\n# Priority axes already decided

A person has settled these axes for this Dok. Omit them from your \`priority\`
object entirely — do not restate, confirm, or revise them. Their reasoning is
given because it is domain knowledge the code does not contain; use it to
inform the axes you DO judge.

${ctx.lockedPriority.map((l) => `  - \`${l.field}\` = \`${l.value}\` — ${l.reason}`).join('\n')}`
      : '';

  const userPrompt = `# Task

Extract the Dok for the feature below. \`dok_id\` MUST be exactly
\`"${ctx.dokId}"\` — so the first business rule id is \`BR-${ctx.dokId}-01\`
and the first acceptance criterion id is \`AC-${ctx.dokId}-01\`.${actorHint}${lockedSection}

# Feature

\`\`\`json
${renderDokFeatureBlock(feature)}
\`\`\`

# File excerpts

${fileBlocks || '(no file context provided)'}

Now output the JSON object.`;

  return { systemPrompt, userPrompt };
}

/** Canonical single-string form of the split prompt — what the trust gate
 * digests and the user approves. See joinPromptParts. */
export function buildDokPrompt(
  feature: FeatureForGeneration,
  ctx: DokGenContext,
): string {
  return joinPromptParts(buildDokPromptParts(feature, ctx));
}

/** Exact role fragment inserted into `buildDokPrompt`. */
export function renderDokRolesBlock(roles: readonly string[]): string {
  return roles.length > 0
    ? roles.map((role) => `  - ${role}`).join('\n')
    : '  (none defined yet — use ROLE-USER as a sensible default)';
}

/** Keep the role block within a source-transmission cap without cutting a line. */
export function capDokRolesForPrompt(
  roles: readonly string[],
  maxChars = 12_000,
): string[] {
  const kept: string[] = [];
  for (const role of roles) {
    const candidate = [...kept, role];
    if (renderDokRolesBlock(candidate).length > maxChars) break;
    kept.push(role);
  }
  return kept;
}

/** Exact consolidated-feature fragment inserted into `buildDokPrompt`. */
export function renderDokFeatureBlock(
  feature: FeatureForGeneration,
  maxChars = 12_000,
): string {
  type PromptFeature = Pick<
    FeatureForGeneration,
    'canonical_id' | 'label' | 'primary_route' | 'members' | 'files'
  >;
  const render = (value: PromptFeature) => JSON.stringify(value, null, 2);
  const initial: PromptFeature = {
    canonical_id: feature.canonical_id,
    label: feature.label,
    primary_route: feature.primary_route,
    members: feature.members,
    files: feature.files.slice(0, 8),
  };
  const rendered = render(initial);
  if (rendered.length <= maxChars) return rendered;

  const capped: PromptFeature = {
    canonical_id: feature.canonical_id.slice(0, 512),
    label: feature.label.slice(0, 2_000),
    primary_route: feature.primary_route.slice(0, 2_000),
    members: [],
    files: [],
  };
  for (const member of feature.members) {
    const next = {
      id: member.id.slice(0, 512),
      label: member.label.slice(0, 1_000),
      route: member.route.slice(0, 1_000),
    };
    if (render({ ...capped, members: [...capped.members, next] }).length > maxChars) break;
    capped.members.push(next);
  }
  for (const file of feature.files.slice(0, 8)) {
    const next = file.slice(0, 2_000);
    if (render({ ...capped, files: [...capped.files, next] }).length > maxChars) break;
    capped.files.push(next);
  }
  return render(capped);
}

export interface ParseResult {
  success: boolean;
  dok: Dok | null;
  error?: string;
}

export function parseDokFromLLMResponse(raw: string): ParseResult {
  // Keep syntax errors anchored to the JSON body instead of reparsing fences.
  const trimmed = raw.trim();
  const fencedBody = trimmed.match(/^```(?:json)?[ \t]*\r?\n([\s\S]*?)(?:\r?\n```\s*$|$)/)?.[1];
  const jsonStr = extractJsonFromResponse(raw) ?? fencedBody?.trim() ?? trimmed;
  let json: unknown;
  try {
    json = JSON.parse(jsonStr);
  } catch (err) {
    return {
      success: false,
      dok: null,
      error: `JSON parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const parsed = DokSchema.safeParse(json);
  if (!parsed.success) {
    return { success: false, dok: null, error: parsed.error.message };
  }
  // Review state is owned by a human, never by model output. Even if a model
  // supplies a schema-valid status, every newly generated Dok enters the Hub
  // as a draft until Studio (or an explicit human edit) promotes it.
  return { success: true, dok: { ...parsed.data, status: 'draft' } };
}

function truncate(s: string, max: number): string {
  if (s.length <= max) return s;
  return s.slice(0, max) + `\n... [truncated ${s.length - max} chars]`;
}
