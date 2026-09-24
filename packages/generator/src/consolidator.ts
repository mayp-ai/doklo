// ============================================
// Feature Consolidator - LLM-aided grouping
// ============================================
//
// features.json (구조적 추출 결과)을 받아서 LLM에게 의미적 통합을 의뢰.
// i18n 변형, 실험/테스트 페이지, 역할 분기 등 구조적 룰로는 못 잡는 중복을 정리한다.
//

import fs from 'fs/promises';
import path from 'path';
import {
  callModel,
  joinPromptParts,
  type LLMUsage,
  type PromptParts,
  type ProviderKind,
} from './llm-client.js';
import { extractJsonFromResponse, describeJsonParseFailure } from './validate.js';
import {
  ensureUniquePrefix,
  suggestDokIdPrefix,
  abbrev,
} from './dok-id-prefix.js';
import {
  assertNoUnpinnedIdCapture,
  pinExistingDokIds,
  type ExistingDokIdentity,
} from './id-reconciliation.js';
import { DOK_ID_RE } from '@doklo-beta/core';
import { estimateTokensFromText } from '@doklo-beta/cost';
import type {
  Feature,
  FeatureConfig,
  FeatureGroup,
  FeatureFile,
  ConsolidatedFeatureConfig,
  ConsolidatedFeatureGroup,
  ConsolidatedFeature,
  ExcludedFeature,
  SourceContext,
} from './legacy-types.js';

// 출력 파일명 — features.json과 같은 디렉토리에 저장
const CONSOLIDATED_FILENAME = 'features-consolidated.json';

// LLM 입력에 포함할 대표 컴포넌트 최대 개수 (feature당)
const MAX_KEY_FILES_PER_FEATURE = 8;

export interface ConsolidateOptions {
  /** Anthropic model id. Haiku is enough for this metadata-only task. */
  model: string;
  /** LLM call timeout (ms). */
  timeout: number;
  /** Retry count (kept for v4 callers; unused — Anthropic SDK retries internally). */
  maxRetries: number;
  /** Verbose console output. Use onProgress for structured events. */
  verbose: boolean;
  /** dry-run: build the prompt but skip the LLM call. */
  dryRun: boolean;
  /**
   * Debug directory: every LLM call writes its input/output here.
   * Recommended: '.doklo/debug'.
   */
  debugDir?: string;
  /** Anthropic API key (direct API path). Falls back to ANTHROPIC_API_KEY env. */
  apiKey?: string;
  /** Provider family for the AI SDK path. If unset, derived from backend or model ref. */
  providerKind?: ProviderKind;
  /** Base URL for openai-compatible providers. */
  baseURL?: string;
  /** Custom fetch forwarded to the AI SDK provider factory (e.g. for Codex OAuth). */
  fetch?: typeof fetch;
  /** Exact caller-authorized provider prompt parts. When present, do not rebuild them. */
  preparedPrompt?: PromptParts;
  /**
   * Dok ids already spoken for elsewhere in the workspace — other services'
   * consolidated caches and their existing Doks. Seeds the collision set so a
   * cross-service duplicate fails here instead of at generate time.
   */
  usedPrefixes?: readonly string[];
  /**
   * Doks this service already produced, so a re-run reuses their ids instead of
   * renaming them (see pinExistingDokIds). Empty on a first generation.
   */
  existingIdentities?: readonly ExistingDokIdentity[];
  /** Service being consolidated — the scope `existingIdentities` are matched in. */
  serviceId?: string;
  /**
   * Structured progress callback. Fires at major checkpoints
   * (start, prompt-built, llm-called, parsed, normalized).
   * Prefer this over verbose for non-CLI consumers (Studio, etc.).
   */
  onProgress?: (event: ConsolidateProgressEvent) => void;
}

export type ConsolidateProgressEvent =
  | { stage: 'start'; projectName: string; featureGroupCount: number }
  | { stage: 'prompt-built'; promptChars: number; estimatedInputTokens: number }
  | { stage: 'llm-called'; processingTimeMs: number; success: boolean }
  | { stage: 'parsed'; success: boolean; error?: string }
  // Advisory: a feature took over an existing Dok that carries no provenance to
  // check it against (see assertNoUnpinnedIdCapture). The run continues — the
  // user is the only one who can tell whether it is still the same feature.
  | { stage: 'unverified-id-reuse'; dokId: string; canonicalId: string }
  | { stage: 'normalized'; consolidatedFeatures: number; excludedCount: number };

export const DEFAULT_CONSOLIDATE_OPTIONS: ConsolidateOptions = {
  model: 'claude-haiku-4-5',
  timeout: 180_000,
  maxRetries: 0,
  verbose: false,
  dryRun: false,
};

export interface ConsolidateResult {
  success: boolean;
  config: ConsolidatedFeatureConfig | null;
  /** 실제 LLM에 보낸 프롬프트 (dry-run 시 검토용) */
  prompt: string;
  /** 입력/출력 토큰 추정치 */
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  /** Provider-reported usage for post-response cost accounting. */
  usage?: LLMUsage | null;
  error?: string;
}

/**
 * features.json을 LLM 통합 분석에 태우는 메인 진입점
 */
export async function consolidateFeatures(
  features: FeatureConfig,
  options: Partial<ConsolidateOptions> = {}
): Promise<ConsolidateResult> {
  const opts = { ...DEFAULT_CONSOLIDATE_OPTIONS, ...options };
  const emit = opts.onProgress ?? (() => {});

  emit({
    stage: 'start',
    projectName: features.projectName,
    featureGroupCount: features.featureGroups.length,
  });

  // 1. LLM 입력용 요약 생성
  const promptParts = opts.preparedPrompt
    ?? buildConsolidationPromptParts(features, opts.existingIdentities);
  const prompt = joinPromptParts(promptParts);

  const estimatedInputTokens = Buffer.byteLength(prompt, 'utf8');
  const estimatedOutputTokens = 32_768;

  emit({
    stage: 'prompt-built',
    promptChars: prompt.length,
    estimatedInputTokens,
  });

  if (opts.verbose) {
    console.log(`   📝 Prompt size: ${prompt.length} chars (~${estimatedInputTokens} tokens)`);
  }

  if (opts.dryRun) {
    return {
      success: true,
      config: null,
      prompt,
      estimatedInputTokens,
      estimatedOutputTokens,
      usage: null,
    };
  }

  // 2. LLM 호출
  const llmResult = await callModel(
    {
      systemPrompt: promptParts.systemPrompt,
      userPrompt: promptParts.userPrompt,
      // The instruction block is static across projects and services, so mark
      // it cacheable. Note: the default consolidate model (haiku-4-5) needs a
      // 4096-token prefix before Anthropic caches it — the marker is harmless
      // below that; sonnet-class models cache from 1024 tokens.
      cacheableSystemPrompt: true,
      label: `consolidate-${features.projectName}`,
    },
    {
      model: opts.model,
      // Reasoning models count hidden thinking against the output budget.
      // Measured on a 350-file project: sonnet-5 spent ~8-9k on hidden thinking
      // plus ~8-10k of visible JSON for 30+ groups — 16k still truncated.
      maxTokens: 32768,
      timeout: opts.timeout,
      ...(opts.apiKey !== undefined ? { apiKey: opts.apiKey } : {}),
      ...(opts.providerKind !== undefined ? { providerKind: opts.providerKind } : {}),
      ...(opts.baseURL !== undefined ? { baseURL: opts.baseURL } : {}),
      ...(opts.fetch !== undefined ? { fetch: opts.fetch } : {}),
      ...(opts.debugDir !== undefined ? { debugDir: opts.debugDir } : {}),
    },
  );

  emit({
    stage: 'llm-called',
    processingTimeMs: llmResult.processingTime,
    success: llmResult.success,
  });

  if (!llmResult.success || !llmResult.content) {
    return {
      success: false,
      config: null,
      prompt,
      estimatedInputTokens,
      estimatedOutputTokens,
      usage: llmResult.usage,
      error: llmResult.error?.message || 'LLM call failed',
    };
  }

  // 3. JSON 파싱
  const jsonStr = extractJsonFromResponse(llmResult.content) ?? llmResult.content;
  let llmGroups: LLMConsolidationOutput;
  try {
    llmGroups = JSON.parse(jsonStr) as LLMConsolidationOutput;
    emit({ stage: 'parsed', success: true });
  } catch (e) {
    const error = describeJsonParseFailure((e as Error).message, llmResult.finishReason);
    emit({ stage: 'parsed', success: false, error });
    return {
      success: false,
      config: null,
      prompt,
      estimatedInputTokens,
      estimatedOutputTokens,
      usage: llmResult.usage,
      error,
    };
  }

  // 4. Validate + normalize. Seeding the ids already taken elsewhere in the
  //    workspace makes a cross-service duplicate fail here, not at write time.
  const normalized = normalizeConsolidationOutput(
    llmGroups,
    features,
    opts.model,
    opts.usedPrefixes,
  );

  // 4.4 Reconcile ids — a feature that matches an existing Dok keeps that Dok's
  //     id instead of the model's proposal, so a re-run cannot rename the file
  //     out from under the documentation that already points at it.
  const { config, pinned } = pinExistingDokIds(
    normalized,
    opts.existingIdentities ?? [],
    opts.serviceId ?? '',
  );

  // 4.45 An existing id may still have landed on a feature the ladder could not
  //     match — the prompt advertises those ids. Unproven reuse is a conflict
  //     the user has to settle, never something to resolve by guessing. The one
  //     case that passes — a Dok with no provenance to check against — is
  //     announced rather than swallowed, so a file changing hands is visible.
  const unverifiedReuse = assertNoUnpinnedIdCapture(
    config,
    opts.existingIdentities ?? [],
    opts.serviceId ?? '',
    pinned,
  );
  for (const reuse of unverifiedReuse) {
    emit({
      stage: 'unverified-id-reuse',
      dokId: reuse.dok_id,
      canonicalId: reuse.canonical_id,
    });
  }

  // 4.5 결정적 출처 운반 — 각 consolidated feature에 member 파일 합집합 첨부.
  //     LLM 결정(members)은 파일 정보를 버리므로, 코드에서 다시 이어붙인다.
  attachSourceFiles(config, features);

  emit({
    stage: 'normalized',
    consolidatedFeatures: config.stats.consolidatedFeatures,
    excludedCount: config.stats.excluded,
  });

  return {
    success: true,
    config,
    prompt,
    estimatedInputTokens,
    estimatedOutputTokens,
    usage: llmResult.usage,
  };
}

/**
 * features.json을 LLM 입력용으로 압축 — 코드 본문 X, 메타데이터만
 */
interface FeatureSummary {
  group_id: string;
  group_label: string;
  features: {
    id: string;
    label: string;
    routePath: string;
    fileCount: number;
    keyFiles: string[];
    candidateKind?: string;
    enabled: boolean;
  }[];
}

function summarizeFeatures(config: FeatureConfig): FeatureSummary[] {
  return config.featureGroups.map((g) => ({
    group_id: g.id,
    group_label: g.label,
    features: g.features.map((f) => ({
      id: f.id,
      label: f.label,
      routePath: f.routePath,
      fileCount: f.files.length,
      keyFiles: pickKeyFiles(f),
      candidateKind: f.candidate_kind,
      enabled: f.enabled,
    })),
  }));
}

/**
 * 한 Feature의 대표 파일 추출 — 의미 판단에 도움되는 컴포넌트 위주
 */
function pickKeyFiles(feature: Feature): string[] {
  if (feature.routePath === '') {
    return [...new Set([feature.entryPoint, ...feature.files.map(file => file.path)])].slice(0, MAX_KEY_FILES_PER_FEATURE);
  }
  // page.tsx 자기 자신은 너무 generic하므로 컴포넌트 위주로 픽
  // shared가 아니고, depth가 낮은 (entry에 가까운) 컴포넌트가 의미 판단에 유용
  const candidates = feature.files
    .filter((f) => !f.isShared)
    .filter((f) => /\.(tsx|jsx)$/.test(f.path))
    .filter((f) => !f.path.endsWith('page.tsx') && !f.path.endsWith('layout.tsx'))
    .sort((a, b) => a.depth - b.depth);

  // entry point도 항상 포함 (page.tsx)
  const result: string[] = [feature.entryPoint];
  for (const f of candidates) {
    if (result.length >= MAX_KEY_FILES_PER_FEATURE) break;
    // 파일명만 (디렉토리 제거)
    const basename = path.basename(f.path);
    if (!result.includes(basename)) {
      result.push(basename);
    }
  }
  return result;
}

/**
 * LLM 프롬프트 구성 — systemPrompt는 프로젝트와 무관한 정적 지시문(캐시 대상),
 * userPrompt는 프로젝트명 + feature 그룹 데이터. 프로젝트별 값이 systemPrompt에
 * 섞이면 프로바이더 캐시가 절대 히트하지 않는다.
 */
function buildConsolidationPrompt(
  summary: FeatureSummary[],
  projectName: string,
  existing: readonly ExistingDokIdentity[] = [],
): PromptParts {
  const systemPrompt = `# Feature Consolidation Task

You are analyzing code-derived candidates from a software project. Route-based candidates come from an optional framework parser. Generic file-based candidates group source files for analysis and are not confirmed business features. Some candidates may be semantic duplicates that should be consolidated before generating documentation (Doks).

For file-based candidates with an empty routePath, preserve an empty primary_route. Never invent an HTTP route or assume a frontend. Use the source filenames and labels as evidence, keep uncertain candidates for code review, and do not apply page-wrapper or route-variant exclusion rules to them.

## Your Task

For each feature group below, decide for each Feature:
- **\`merge\`**: Combine 2+ features that represent the same business capability (e.g., i18n variants, A/B variants).
- **\`keep\`**: Standalone feature, no merging needed.
- **\`exclude\`**: Skip from documentation entirely (e.g., trivial wrapper page, dead test page, generic catch-all).

## Heuristics to apply

1. **i18n variants** — \`/foo\`, \`/foo/en\`, \`/foo/jp\` with similar fileCount and overlapping keyFiles → merge as i18n.
2. **Experiment/test variants** — \`*-test\`, \`*-v2\`, \`*2\`, \`*-exp\` next to a base feature → usually exclude or note as experiment.
3. **Trivial entry pages** — fileCount ≤ 2 and no clear business meaning (e.g., a page that only renders a child route) → exclude.
4. **Role splits** — \`/admin/foo\`, \`/user/foo\` with same data domain → consider keeping separate but mark relationship.
5. **Conservative bias** — when unsure, \`keep\`. Don't merge things that share components but have genuinely different routes/labels (e.g., list vs detail).

## Output format

Output ONLY a JSON object matching this schema:

\`\`\`json
{
  "groups": [
    {
      "group_id": "string (must match input group_id)",
      "group_label": "string",
      "decisions": [
        {
          "canonical_id": "string (use one of the member ids, prefer the shortest/canonical route)",
          "label": "string (human-readable, Korean if input is Korean)",
          "decision": "merge | keep | exclude",
          "members": ["feature_id_1", "feature_id_2"],
          "primary_route": "/some/route",
          "reason": "1-2 sentences in Korean explaining the decision",
          "dok_id_prefix": "UPPERCASE-SEMANTIC-NAME (see rules below)",
          "metadata": {
            "locales": ["ko", "en", "jp"],
            "variant_type": "i18n | experiment | ab_test | role_split | other",
            "note": "optional, only if useful"
          }
        }
      ]
    }
  ]
}

\`\`\`

### dok_id_prefix Rules (REQUIRED for keep/merge, omit for exclude)

In this schema, the prefix IS the final dok_id — no numeric suffix is ever appended.

- **Regex**: \`${DOK_ID_RE.source}\` (1-3 UPPERCASE segments, each 2-10 chars, digits allowed after the first letter of a segment)
- **Reserved**: must not start with BR or AC as the first segment (exact match, not merely a prefix — e.g. \`BRAND\` is fine); those two are reserved for this Dok's own rule/criterion ids, e.g. \`BR-AUTH-SIGNIN-01\`
- **Readable over cryptic**: prefer full words across up to 3 segments (\`AUTH-PASSWORD-RESET\`) over vowel-stripped abbreviations (\`AUTH-PWRST\`). Only abbreviate when a word exceeds 10 chars.
- **Two/three segment pattern** for sub-flows: \`{GROUP}-{SUBFLOW}\` or \`{GROUP}-{SUBFLOW}-{DETAIL}\` (e.g., \`AUTH-SIGNIN\`, \`ADMIN-USER-BAN\`)
- **One segment** for the main feature of a group (e.g., \`HOME\`, \`SEARCH\`)
- **Unique** within the project — no two consolidated features may share a prefix

**Conversion examples (apply this style):**
- group "auth", feature "auth-signin" → \`AUTH-SIGNIN\` (or \`AUTH\` if it's the main flow)
- group "admin", feature "admin-banner" → \`ADMIN-BANNER\`
- group "program", feature "program-milestone" → \`PROGRAM-MILESTONE\`
- group "admin", feature "admin-mentor-list" → \`ADMIN-MENTOR-LIST\` (3 segments — group + 2 differentiating words)
- group "catalog", feature "catalog-detail" → \`CATALOG\` (main page of the group; "detail" is generic, drop it)
- group "order", feature "order-detail-refund" → \`ORDER-REFUND\`
- group "checkout", feature "checkout-payment" → \`CHECKOUT-PAYMENT\`

**❌ Avoid:**
- \`Auth-Signin\` (mixed case)
- \`auth-signin\` (lowercase — must be UPPERCASE)
- \`AUTH_SIGNIN\` (underscore not allowed — use a hyphen)
- \`AUTH-SIGNIN-PASSWORD-RESET\` (4+ segments — max 3)

Rules:
- Every input feature MUST appear in exactly one decision (merge/keep) OR in the excluded list of its group.
- For \`exclude\`, set \`members\` to a single id and put it in \`decisions\` with \`decision: "exclude"\`.
- For \`keep\`, \`members\` has exactly 1 id.
- For \`merge\`, \`members\` has 2 or more ids.
- Output JSON only — no explanation prose around it.`;

  const sections: string[] = [];
  sections.push(`## Project: ${projectName}

## Feature groups to analyze
`);

  // 그룹별로 features 나열
  for (const group of summary) {
    sections.push(`\n### Group: ${group.group_label} (\`${group.group_id}\`)\n`);
    sections.push(`Features (${group.features.length}):\n`);
    for (const f of group.features) {
      sections.push(`- **${f.id}** — ${f.label}`);
      sections.push(`  - route: \`${f.routePath}\``);
      sections.push(`  - files: ${f.fileCount}`);
      if (f.candidateKind) sections.push(`  - source classification: ${f.candidateKind}; enabled: ${f.enabled}`);
      sections.push(`  - key files: ${f.keyFiles.slice(0, 5).map((k) => `\`${k}\``).join(', ')}`);
    }
  }

  const existingSection = renderExistingDokSection(existing);
  if (existingSection) sections.push(existingSection);

  sections.push(`\n## Now produce the JSON output\n`);

  return { systemPrompt, userPrompt: sections.join('\n') };
}

/** Split provider prompt — shared static instructions vs per-project data. */
export function buildConsolidationPromptParts(
  features: FeatureConfig,
  existing: readonly ExistingDokIdentity[] = [],
): PromptParts {
  return buildConsolidationPrompt(summarizeFeatures(features), features.projectName, existing);
}

/**
 * Ids this workspace already documents. Renaming one orphans its Dok file and
 * every reference to it, so the model is told to reuse them verbatim whenever a
 * feature is the same capability.
 */
function renderExistingDokSection(existing: readonly ExistingDokIdentity[]): string | null {
  const lines: string[] = [];
  const seen = new Set<string>();
  for (const identity of existing) {
    if (seen.has(identity.dok_id)) continue;
    seen.add(identity.dok_id);
    const facts = [
      identity.canonical_feature_id ? `feature \`${identity.canonical_feature_id}\`` : null,
      identity.primary_route ? `route \`${identity.primary_route}\`` : null,
    ].filter((fact): fact is string => fact !== null);
    lines.push(`- \`${identity.dok_id}\`${facts.length > 0 ? ` — ${facts.join(', ')}` : ''}`);
  }
  if (lines.length === 0) return null;

  return `\n## Existing Doks (reuse these ids when the feature matches)

These ids are already documented in this workspace. When a feature below is the
same capability as one of these, set its \`dok_id_prefix\` to that id verbatim —
a renamed id orphans the existing Dok. Ids no feature matches stay unused.

${lines.join('\n')}
`;
}

/** Exact provider prompt used for conservative pre-call reservation. */
export function buildConsolidationPromptForFeatures(
  features: FeatureConfig,
  existing: readonly ExistingDokIdentity[] = [],
): string {
  return joinPromptParts(buildConsolidationPromptParts(features, existing));
}

// ============================================
// LLM 응답 파싱 / 정규화
// ============================================

interface LLMConsolidationOutput {
  groups: {
    group_id: string;
    group_label?: string;
    decisions: {
      canonical_id: string;
      label: string;
      decision: 'merge' | 'keep' | 'exclude';
      members: string[];
      primary_route: string;
      reason: string;
      dok_id_prefix?: string;
      metadata?: ConsolidatedFeature['metadata'];
    }[];
  }[];
}

// dok-id prefix helpers (suggestDokIdPrefix / ensureUniquePrefix / abbrev)
// live in ./dok-id-prefix.js — vendored in batch C-1. DOK_ID_RE itself is the
// shared Dok ID grammar and comes straight from @doklo-beta/core (its
// `.source` is interpolated into the Rules section above, so the prompt can
// never drift from the actual validation regex).
// Imported at top of file.

function normalizeConsolidationOutput(
  llmOutput: LLMConsolidationOutput,
  source: FeatureConfig,
  model: string,
  seedPrefixes: readonly string[] = [],
): ConsolidatedFeatureConfig {
  // 원본 그룹 인덱스
  const sourceGroups = new Map<string, FeatureGroup>(
    source.featureGroups.map((g) => [g.id, g])
  );

  const groups: ConsolidatedFeatureGroup[] = [];
  let originalCount = 0;
  let consolidatedCount = 0;
  let mergeCount = 0;
  let excludeCount = 0;

  // 프로젝트 전역에서 prefix 충돌 회피
  // Ids other services already hold arrive as a seed; copied so the caller's
  // list is never mutated.
  const usedPrefixes = new Set<string>(seedPrefixes);

  for (const llmGroup of llmOutput.groups) {
    const sourceGroup = sourceGroups.get(llmGroup.group_id);
    if (!sourceGroup) {
      console.warn(`  ⚠️  LLM returned unknown group_id: ${llmGroup.group_id}`);
      continue;
    }

    originalCount += sourceGroup.features.length;

    // members 검증 — 모든 id가 원본에 존재하는지
    const validFeatureIds = new Set(sourceGroup.features.map((f) => f.id));

    const features: ConsolidatedFeature[] = [];
    const excluded: ExcludedFeature[] = [];

    for (const d of llmGroup.decisions) {
      const validMembers = d.members.filter((id) => validFeatureIds.has(id));
      if (validMembers.length === 0) {
        console.warn(`  ⚠️  Decision ${d.canonical_id} has no valid members, skipping`);
        continue;
      }

      if (d.decision === 'exclude') {
        for (const id of validMembers) {
          const candidate = sourceGroup.features.find(feature => feature.id === id)!;
          // Consolidation sees filenames, not source. It cannot decide generic
          // application code has no business behavior. Leave it unhandled so
          // the deterministic keep below sends it to the source-reading phase.
          const metadataOnly = candidate.files.every(file =>
            /(?:^|\/)(?:package\.json|pom\.xml|requirements\.txt|pyproject\.toml|go\.mod|Cargo\.toml|composer\.json|Gemfile)$/.test(file.path));
          if (candidate.routePath === '' && !metadataOnly) continue;
          excluded.push({ id, reason: d.reason });
          excludeCount += 1;
        }
      } else {
        // dok_id_prefix 정규화 + 충돌 회피
        const prefix = ensureUniquePrefix(
          d.dok_id_prefix,
          d.canonical_id,
          sourceGroup.id,
          usedPrefixes
        );
        usedPrefixes.add(prefix);

        features.push({
          canonical_id: d.canonical_id,
          label: d.label,
          decision: d.decision,
          members: validMembers,
          primary_route: d.primary_route,
          reason: d.reason,
          user_reviewed: false,
          dok_id_prefix: prefix,
          metadata: d.metadata,
        });
        consolidatedCount += 1;
        if (d.decision === 'merge') mergeCount += 1;
      }
    }

    // 누락된 feature 자동 keep — LLM이 빠뜨렸을 경우 보호장치
    const handledIds = new Set([
      ...features.flatMap((f) => f.members),
      ...excluded.map((e) => e.id),
    ]);
    const orphans = sourceGroup.features.filter((f) => !handledIds.has(f.id));
    for (const orphan of orphans) {
      const prefix = ensureUniquePrefix(undefined, orphan.id, sourceGroup.id, usedPrefixes);
      usedPrefixes.add(prefix);
      features.push({
        canonical_id: orphan.id,
        label: orphan.label,
        decision: 'keep',
        members: [orphan.id],
        primary_route: orphan.routePath,
        reason: '(자동 keep — 소스 검토 필요 또는 LLM 응답 누락)',
        user_reviewed: false,
        dok_id_prefix: prefix,
      });
      consolidatedCount += 1;
    }

    groups.push({
      group_id: sourceGroup.id,
      label: sourceGroup.label,
      features,
      excluded,
    });
  }

  // LLM이 누락한 그룹 보호
  for (const sourceGroup of source.featureGroups) {
    if (!groups.find((g) => g.group_id === sourceGroup.id)) {
      console.warn(`  ⚠️  LLM omitted group ${sourceGroup.id}, auto-keeping all features`);
      const features: ConsolidatedFeature[] = sourceGroup.features.map((f) => {
        const prefix = ensureUniquePrefix(undefined, f.id, sourceGroup.id, usedPrefixes);
        usedPrefixes.add(prefix);
        return {
          canonical_id: f.id,
          label: f.label,
          decision: 'keep',
          members: [f.id],
          primary_route: f.routePath,
          reason: '(자동 keep — LLM 응답에 그룹 누락)',
          user_reviewed: false,
          dok_id_prefix: prefix,
        };
      });
      originalCount += sourceGroup.features.length;
      consolidatedCount += features.length;
      groups.push({
        group_id: sourceGroup.id,
        label: sourceGroup.label,
        features,
        excluded: [],
      });
    }
  }

  // Discovery policy is deterministic: filenames alone cannot prove an
  // unconnected source is a reachable customer feature, even if the model keeps it.
  const reviewRequired = new Set(source.featureGroups.flatMap(group => group.features)
    .filter(feature => feature.candidate_kind === 'unconnected-source' && !feature.enabled).map(feature => feature.id));
  for (const group of groups) {
    for (const feature of group.features) feature.members = feature.members.filter(id => !reviewRequired.has(id));
    group.features = group.features.filter(feature => feature.members.length > 0);
    group.excluded = group.excluded.filter(feature => !reviewRequired.has(feature.id));
    for (const feature of sourceGroups.get(group.group_id)?.features ?? []) {
      if (reviewRequired.has(feature.id)) group.excluded.push({ id: feature.id, reason: 'UNCONNECTED_SOURCE_REQUIRES_REVIEW' });
    }
  }
  consolidatedCount = groups.reduce((sum, group) => sum + group.features.length, 0);
  excludeCount = groups.reduce((sum, group) => sum + group.excluded.length, 0);
  mergeCount = groups.flatMap(group => group.features).filter(feature => feature.decision === 'merge').length;

  return {
    projectName: source.projectName,
    basedOnFeaturesAt: source.generatedAt,
    generatedAt: new Date().toISOString(),
    model,
    groups,
    originalFeatureIds: source.featureGroups.flatMap((group) => group.features.map((feature) => feature.id)),
    userReviewed: false,
    stats: {
      originalFeatures: originalCount,
      consolidatedFeatures: consolidatedCount,
      merges: mergeCount,
      excluded: excludeCount,
    },
  };
}

// ============================================
// 결정적 출처 운반 (source provenance carry)
// ============================================

/**
 * Attach each consolidated feature's source files — the deduped union of its
 * member features' file paths — pulled from the source FeatureConfig.
 *
 * The LLM consolidation decision (`ConsolidatedFeature`) only carries
 * `members[]` + `primary_route`; it drops the rich per-feature file
 * attribution that `irToFeatures` computed (entry page + reachable
 * components/hooks/stores, shared infra already excluded). This re-attaches
 * that attribution deterministically so it survives the cache and reaches
 * `generate`, which injects it into `Dok._meta.source_anchors`.
 *
 * Also attaches `logic_files` — the drift closure (the full reachable set incl.
 * shared infra) — from each member's `logic_files`. That set (not the display
 * `source_files`) is what drift hashes, so a change to a shared dependency is
 * still caught. See ConsolidatedFeature.logic_files.
 *
 * Mutates `config` in place (and returns it). Members with no matching source
 * feature are skipped; a feature whose members are all unknown gets `[]`.
 */
export function attachSourceFiles(
  config: ConsolidatedFeatureConfig,
  source: FeatureConfig,
): ConsolidatedFeatureConfig {
  const filesById = new Map<string, string[]>();
  const contextById = new Map<string, SourceContext[]>();
  // Drift closure per source feature: its `logic_files` (full reachable set,
  // shared infra included) when present, else its display files — so caches
  // written before `logic_files` existed hash the same set as before (drift set
  // == display set there, keeping the hash regression-safe).
  const logicById = new Map<string, string[]>();
  for (const group of source.featureGroups) {
    for (const f of group.features) {
      filesById.set(f.id, f.files.map((ff) => ff.path));
      if (f.source_context) contextById.set(f.id, f.source_context);
      logicById.set(f.id, f.logic_files ?? f.files.map((ff) => ff.path));
    }
  }

  for (const group of config.groups) {
    for (const feature of group.features) {
      const seen = new Set<string>();
      const union: string[] = [];
      for (const memberId of feature.members) {
        const paths = filesById.get(memberId);
        if (!paths) continue;
        for (const p of paths) {
          if (!seen.has(p)) {
            seen.add(p);
            union.push(p);
          }
        }
      }
      feature.source_files = union;
      if (feature.members.every(id => contextById.has(id))) {
        const contextUnion = new Map<string, SourceContext>();
        for (const memberId of feature.members) {
          for (const context of contextById.get(memberId) ?? []) {
            const existing = contextUnion.get(context.file);
            if (!existing) contextUnion.set(context.file, { ...context, ranges: context.ranges.map(range => ({ ...range })), symbols: [...context.symbols] });
            else {
              if (existing.content_hash !== context.content_hash) throw new Error(`SOURCE_CONTEXT_HASH_MISMATCH: ${context.file}`);
              existing.ranges.push(...context.ranges.map(range => ({ ...range })));
              existing.symbols = [...new Set([...existing.symbols, ...context.symbols])].sort();
              if (context.kind === 'entry' || existing.kind === 'entry') existing.kind = 'entry';
              else if (context.kind === 'module') existing.kind = 'module';
            }
          }
        }
        feature.source_context = [...contextUnion.values()].map(context => {
          const ranges: SourceContext['ranges'] = [];
          for (const range of context.ranges.sort((a, b) => a.start - b.start || (a.startColumn ?? 1) - (b.startColumn ?? 1))) {
            const last = ranges.at(-1);
            const touches = last && (range.start < last.end ||
              (range.start === last.end && (range.startColumn ?? 1) <= (last.endColumn ?? Infinity)) ||
              (range.start === last.end + 1 && last.endColumn === undefined && range.startColumn === undefined));
            if (last && touches) {
              if (range.end > last.end || (range.end === last.end && (range.endColumn ?? Infinity) > (last.endColumn ?? Infinity))) {
                last.end = range.end;
                if (range.endColumn === undefined) delete last.endColumn;
                else last.endColumn = range.endColumn;
              }
            } else ranges.push({ ...range });
          }
          return { ...context, ranges };
        });
      } else {
        delete feature.source_context;
      }

      // Parallel drift-closure union across the same members. Kept as its own
      // block so the display `source_files` attribution above stays unchanged.
      const logicSeen = new Set<string>();
      const logicUnion: string[] = [];
      for (const memberId of feature.members) {
        const paths = logicById.get(memberId);
        if (!paths) continue;
        for (const p of paths) {
          if (!logicSeen.has(p)) {
            logicSeen.add(p);
            logicUnion.push(p);
          }
        }
      }
      feature.logic_files = logicUnion;
    }
  }

  return config;
}

// ============================================
// 영속화 + 출력
// ============================================

export async function saveConsolidatedConfig(
  config: ConsolidatedFeatureConfig,
  outputDir: string
): Promise<string> {
  await fs.mkdir(outputDir, { recursive: true });
  const filePath = path.join(outputDir, CONSOLIDATED_FILENAME);
  await fs.writeFile(filePath, JSON.stringify(config, null, 2));
  return filePath;
}

export async function loadConsolidatedConfig(
  outputDir: string
): Promise<ConsolidatedFeatureConfig | null> {
  try {
    const content = await fs.readFile(path.join(outputDir, CONSOLIDATED_FILENAME), 'utf-8');
    return JSON.parse(content) as ConsolidatedFeatureConfig;
  } catch {
    return null;
  }
}

// ============================================
// 통합 결정 적용 — FeatureConfig 변환
// ============================================

export interface ApplyConsolidationStats {
  keptFeatures: number;
  mergedFeatures: number;
  excludedFeatures: number;
  /** 병합으로 사라진 원본 feature 수 */
  collapsedMembers: number;
}

/**
 * features.json + features-consolidated.json → 통합 적용된 새 FeatureConfig
 *
 * - decision=keep: 원본 그대로
 * - decision=merge: 멤버들을 하나의 가상 Feature로 병합 (files/apis/components 합집합)
 * - decision=exclude OR ExcludedFeature: 결과에서 제거
 */
export function applyConsolidation(
  source: FeatureConfig,
  consolidated: ConsolidatedFeatureConfig
): { config: FeatureConfig; stats: ApplyConsolidationStats } {
  const stats: ApplyConsolidationStats = {
    keptFeatures: 0,
    mergedFeatures: 0,
    excludedFeatures: 0,
    collapsedMembers: 0,
  };

  // 원본 그룹/feature 인덱스
  const sourceGroups = new Map<string, FeatureGroup>(
    source.featureGroups.map((g) => [g.id, g])
  );

  const newGroups: FeatureGroup[] = [];

  // prefix 충돌 회피용 — 이미 부여된 prefix 수집
  const usedPrefixes = new Set<string>();
  for (const cGroup of consolidated.groups) {
    for (const cf of cGroup.features) {
      if (cf.dok_id_prefix) usedPrefixes.add(cf.dok_id_prefix);
    }
  }

  for (const cGroup of consolidated.groups) {
    const sourceGroup = sourceGroups.get(cGroup.group_id);
    if (!sourceGroup) continue;

    const sourceFeatureMap = new Map(sourceGroup.features.map((f) => [f.id, f]));

    // 제외 처리
    const excludedIds = new Set(cGroup.excluded.map((e) => e.id));
    stats.excludedFeatures += excludedIds.size;

    const newFeatures: Feature[] = [];

    for (const decision of cGroup.features) {
      // exclude 결정은 features 배열에 들어가있지 않지만 안전장치
      if (decision.decision === 'exclude') {
        stats.excludedFeatures += decision.members.length;
        continue;
      }

      const memberFeatures = decision.members
        .map((id) => sourceFeatureMap.get(id))
        .filter((f): f is Feature => !!f && !excludedIds.has(f.id));

      if (memberFeatures.length === 0) continue;

      // prefix가 비어있으면 자동 생성 (consolidator가 옛 버전이거나 LLM 누락한 경우)
      let prefix = decision.dok_id_prefix;
      if (!prefix) {
        prefix = ensureUniquePrefix(undefined, decision.canonical_id, sourceGroup.id, usedPrefixes);
        usedPrefixes.add(prefix);
      }

      if (decision.decision === 'keep' || memberFeatures.length === 1) {
        // keep: 원본 유지하되 라벨만 통합 결과 반영
        const original = memberFeatures[0];
        newFeatures.push({
          ...original,
          label: decision.label || original.label,
          dok_id_prefix: prefix,
        });
        stats.keptFeatures += 1;
      } else {
        // merge: 멤버 통합
        const merged = mergeMemberFeatures(decision, memberFeatures);
        merged.dok_id_prefix = prefix;
        newFeatures.push(merged);
        stats.mergedFeatures += 1;
        stats.collapsedMembers += memberFeatures.length - 1;
      }
    }

    if (newFeatures.length === 0) continue;

    newGroups.push({
      ...sourceGroup,
      features: newFeatures,
      totalFileCount: countTotalFiles(newFeatures),
    });
  }

  // 원본 unmappedFiles는 그대로 유지
  return {
    config: {
      ...source,
      featureGroups: newGroups,
      generatedAt: new Date().toISOString(),
    },
    stats,
  };
}

/** 여러 Feature를 하나로 병합 — files/apis/components/stores는 합집합 */
function mergeMemberFeatures(
  decision: ConsolidatedFeature,
  members: Feature[]
): Feature {
  // primary_route와 일치하는 멤버를 entry로 우선 (없으면 첫 번째)
  const entryMember =
    members.find((f) => f.routePath === decision.primary_route) || members[0];

  // files 합집합 — path 기준 dedup, depth는 최소값 우선
  const fileMap = new Map<string, FeatureFile>();
  for (const m of members) {
    for (const f of m.files) {
      const existing = fileMap.get(f.path);
      if (!existing || f.depth < existing.depth) {
        fileMap.set(f.path, f);
      }
    }
  }

  const apiRoutes = uniqueStrings(members.flatMap((m) => m.apiRoutes));
  const components = uniqueStrings(members.flatMap((m) => m.components));
  const stores = uniqueStrings(members.flatMap((m) => m.stores));

  return {
    id: decision.canonical_id,
    label: decision.label,
    routePath: decision.primary_route,
    entryPoint: entryMember.entryPoint,
    files: Array.from(fileMap.values()),
    apiRoutes,
    components,
    stores,
    enabled: members.some((m) => m.enabled),
  };
}

function uniqueStrings(arr: string[]): string[] {
  return Array.from(new Set(arr));
}

function countTotalFiles(features: Feature[]): number {
  const all = new Set<string>();
  for (const f of features) {
    for (const file of f.files) all.add(file.path);
  }
  return all.size;
}

/**
 * 콘솔 요약 출력 — 사용자 검토 도움
 */
export function printConsolidationSummary(config: ConsolidatedFeatureConfig): void {
  console.log('\n🧩 Feature Consolidation Result');
  console.log('═'.repeat(60));
  console.log(`Project: ${config.projectName}`);
  console.log(`Model: ${config.model}`);
  console.log(
    `Original features: ${config.stats.originalFeatures} → ` +
    `Consolidated: ${config.stats.consolidatedFeatures} ` +
    `(merges: ${config.stats.merges}, excluded: ${config.stats.excluded})`
  );

  for (const group of config.groups) {
    console.log(`\n📁 ${group.label} (${group.group_id})`);
    for (const f of group.features) {
      const icon = f.decision === 'merge' ? '🔗' : '·';
      const memberStr = f.decision === 'merge' ? ` ← [${f.members.join(', ')}]` : '';
      console.log(`  ${icon} ${f.label} (${f.canonical_id})${memberStr}`);
      if (f.decision === 'merge') {
        console.log(`     ↪ ${f.reason}`);
      }
    }
    for (const e of group.excluded) {
      console.log(`  ❌ ${e.id} — ${e.reason}`);
    }
  }
  console.log('');
}
