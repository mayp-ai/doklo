// LLM-driven Lexicon term suggestion.
//
// Input: the existing Dok set (their description / step intent / step
// outcome / rule description / acceptance statement). The Doks are the
// canonical statement of what the product does, so their text is the
// most reliable corpus for "what domain terms recur here?".
//
// Output: a curated list of ≤30 candidate terms with category and reason.
// We intentionally cap the count — the Lexicon is a dictionary, not a
// string dump. The LLM is asked to *skip* generic UI words and one-off
// labels and focus on domain-specific nouns + recurring business
// concepts.
//
// This module produces candidates only. Persistence is the CLI's job;
// the candidates land in .doklo/cache/lexicon-suggestions.json and the
// user accepts / rejects them in Studio.

import type { Dok, LexiconCategory } from '@doklo-beta/core';
import {
  callModel,
  DEFAULT_LLM_CONFIG,
  type LLMUsage,
  type ProviderKind,
} from './llm-client.js';
import { extractJsonFromResponse } from './validate.js';

export interface SuggestedTerm {
  /** The exact text the LLM thinks should become a Lexicon term, in the
   *  workspace's default locale. */
  text: string;
  category: LexiconCategory;
  /** Short justification (one sentence) — shown to the user in Studio. */
  reason: string;
  /** Dok IDs where this term meaningfully appears, as cited by the LLM. */
  dok_refs: string[];
}

// The suggester is corpus-agnostic: terms can be nominated from existing Dok
// bodies ('doks') OR — before any Dok exists — from the consolidated feature
// groups + i18n display values produced by the code scan ('code').
export interface CodeCorpusFeature { canonical_id: string; label: string; primary_route: string }
export interface CodeCorpusGroup { label: string; features: CodeCorpusFeature[] }
export type SuggestCorpus =
  | { kind: 'doks'; doks: Dok[] }
  | { kind: 'code'; groups: CodeCorpusGroup[]; i18nValues: string[] };
export interface SuggestLexiconContext {
  defaultLocale: string;
  corpus: SuggestCorpus;          // replaces the former doks: Dok[]
  existingTexts?: string[];
  maxSuggestions?: number;
}

export interface SuggestLexiconOptions {
  model?: string;
  maxTokens?: number;
  timeout?: number;
  apiKey?: string;
  providerKind?: ProviderKind;
  baseURL?: string;
  /** Custom fetch forwarded to the AI SDK provider factory (e.g. for Codex OAuth). */
  fetch?: typeof fetch;
  debugDir?: string;
  /** Exact caller-authorized provider prompt. When present, do not rebuild it. */
  preparedPrompt?: string;
}

export interface SuggestLexiconResult {
  success: boolean;
  suggestions: SuggestedTerm[];
  prompt: string;
  rawResponse: string | null;
  usage: LLMUsage | null;
  error?: string;
}

export const LEXICON_DOK_SNIPPET_MAX_CHARS = 12_000;
export const LEXICON_EXISTING_SNIPPET_MAX_CHARS = 2_000;
export const LEXICON_I18N_SNIPPET_MAX_CHARS = 2_000;
export const LEXICON_CODE_GROUP_MAX_CHARS = 12_000;

/** Strip Translatable to its display text for prompt-building purposes
 *  (TermRef pointers would be unresolved noise to the model). */
function flatText(t: unknown): string {
  if (typeof t === 'string') return t;
  return '';
}

/** Compact a single Dok into the corpus snippet sent to the LLM. */
export function renderLexiconDokSnippet(
  d: Dok,
  maxChars = LEXICON_DOK_SNIPPET_MAX_CHARS,
): string {
  const lines: string[] = [`## ${d.dok_id} — ${flatText(d.name)}`];
  const desc = flatText(d.description);
  if (desc) lines.push(desc);
  const steps = d.user_actions?.steps ?? [];
  for (const s of steps) {
    const intent = flatText(s.intent);
    const outcome = flatText(s.outcome);
    if (intent) lines.push(`  • ${intent}`);
    if (outcome) lines.push(`    → ${outcome}`);
  }
  const rules = d.business_rules?.rules ?? [];
  for (const r of rules) {
    if (r.description) lines.push(`  [rule] ${r.description}`);
  }
  const criteria = d.acceptance_criteria?.criteria ?? [];
  for (const c of criteria) {
    if (c.statement) lines.push(`  [ac]   ${c.statement}`);
  }
  return lines.join('\n').slice(0, maxChars);
}

export function renderLexiconCodeGroup(group: CodeCorpusGroup): string {
  const features = group.features
    .map((feature) => `- ${feature.label} (\`${feature.canonical_id}\`, ${feature.primary_route})`)
    .join('\n');
  return `## ${group.label}\n${features}`;
}

export function renderLexiconI18nLine(value: string): string {
  return `- ${value.slice(0, LEXICON_I18N_SNIPPET_MAX_CHARS)}`;
}

export function renderLexiconExistingLine(value: string): string {
  return `- ${value.slice(0, LEXICON_EXISTING_SNIPPET_MAX_CHARS)}`;
}

/** Render the code-scan corpus: consolidated feature groups (with canonical
 *  ids + routes) plus a sample of i18n display values, as domain-vocabulary
 *  signal for the model. */
function codeCorpusSection(groups: CodeCorpusGroup[], i18nValues: string[]): string {
  const groupLines = groups
    .map((group) => renderLexiconCodeGroup(group))
    .join('\n\n')
    .slice(0, LEXICON_CODE_GROUP_MAX_CHARS);
  const i18nBlock =
    i18nValues.length > 0
      ? `\n\n# i18n 표시 문구 샘플 (${i18nValues.length}개 — 반복되는 도메인 어휘의 신호)\n${i18nValues.map(renderLexiconI18nLine).join('\n')}`
      : '';
  return `# 제품 구조 코퍼스 (코드 스캔·consolidate 결과)\n\n${groupLines}${i18nBlock}`;
}

export function buildSuggestPrompt(ctx: SuggestLexiconContext): string {
  const maxN = ctx.maxSuggestions ?? 30;
  const corpusSection =
    ctx.corpus.kind === 'doks'
      ? `# Dok 본문 코퍼스 (\`${ctx.defaultLocale}\`)\n\n${ctx.corpus.doks.map((dok, index) =>
          renderLexiconDokSnippet(dok, LEXICON_DOK_SNIPPET_MAX_CHARS - (index > 0 ? 2 : 0)))
        .join('\n\n')}`
      : codeCorpusSection(ctx.corpus.groups, ctx.corpus.i18nValues);
  const existing = ctx.existingTexts && ctx.existingTexts.length > 0
    ? ctx.existingTexts.slice(0, 200)
      .map(renderLexiconExistingLine)
      .join('\n')
    : '(none)';

  return `당신은 v5 Doklo Hub의 Lexicon(용어 사전)을 큐레이션하는 전문가입니다.

# 목표
아래 코퍼스를 읽고, 이 프로젝트의 **도메인 핵심 용어**를 최대 ${maxN}개 선별하세요. Lexicon은 사전이지 텍스트 덤프가 아닙니다.

# 포함 기준 (이런 것들을 골라주세요)
1. **도메인 특화 명사** — 이 프로젝트/업종 고유 개념 (예: 정산, 리텐션, 이탈률, 코호트, LTV)
2. **자주 반복되는 비즈니스 용어** — 여러 Dok에서 반복 등장하는 핵심 단어
3. **의미를 통일해야 하는 표현** — "장바구니"와 "카트" 같이 동의어가 혼용될 위험이 있는 경우 표준어 후보
4. 시민(비개발자) 사용자가 "이건 정확히 뭐지?" 물어볼 만한 도메인 어휘

# 제외 기준 (절대 넣지 마세요)
- 일반 UI 단어: 저장, 취소, 확인, 닫기, 다음, 이전, 로그인, 로그아웃, 등록, 수정, 삭제, 검색 등 어느 앱에나 있는 것들
- 단발성 라벨이나 일회성 메시지 ("..로딩 중", "성공했습니다" 등)
- 단순 동사구 / 문장 — 명사구 위주
- 이미 등록된 용어 (아래 목록)

# 이미 등록된 용어 (중복 금지)
${existing}

# 카테고리 가이드
- \`concept\` — 도메인 개념·기능 명칭 (예: 마일스톤, 정산, 사업진단, AI 채팅) — 대부분 여기 해당
- \`role\` — 역할 명칭 (단, roles.json 관리이므로 가급적 새로 추가하지 말 것)

# 출력 형식 (JSON만, 다른 문장 금지)
\`\`\`json
{
  "suggestions": [
    {
      "text": "정산",
      "category": "concept",
      "reason": "판매자 대금 정산 흐름 전반에서 핵심 개념으로 반복 등장",
      "dok_refs": ["SETTLE-PAYOUT", "SELL-PAYOUT"]
    }
  ]
}
\`\`\`
- \`dok_refs\`: Dok 본문 코퍼스일 때만 해당 Dok ID를 인용. 코드 코퍼스에서는 빈 배열 \`[]\`.

${corpusSection}
`;
}

const VALID_CATEGORIES: readonly LexiconCategory[] = ['concept', 'role'];

export function parseSuggestions(raw: string): SuggestedTerm[] {
  const json = extractJsonFromResponse(raw);
  if (!json) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    !('suggestions' in parsed) ||
    !Array.isArray((parsed as { suggestions: unknown }).suggestions)
  ) {
    return [];
  }
  const arr = (parsed as { suggestions: unknown[] }).suggestions;
  const out: SuggestedTerm[] = [];
  for (const item of arr) {
    if (typeof item !== 'object' || item === null) continue;
    const obj = item as Record<string, unknown>;
    const text = typeof obj.text === 'string' ? obj.text.trim() : '';
    const category =
      typeof obj.category === 'string' &&
      (VALID_CATEGORIES as readonly string[]).includes(obj.category)
        ? (obj.category as LexiconCategory)
        : 'concept';
    const reason = typeof obj.reason === 'string' ? obj.reason.trim() : '';
    const dok_refs = Array.isArray(obj.dok_refs)
      ? obj.dok_refs.filter((x): x is string => typeof x === 'string')
      : [];
    if (text.length === 0) continue;
    out.push({ text, category, reason, dok_refs });
  }
  return out;
}

export async function suggestLexiconTerms(
  ctx: SuggestLexiconContext,
  options: SuggestLexiconOptions = {},
): Promise<SuggestLexiconResult> {
  const prompt = options.preparedPrompt ?? buildSuggestPrompt(ctx);
  const config = {
    ...DEFAULT_LLM_CONFIG,
    model: options.model ?? DEFAULT_LLM_CONFIG.model,
    maxTokens: options.maxTokens ?? 4096,
    timeout: options.timeout ?? 300_000,
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.providerKind !== undefined ? { providerKind: options.providerKind } : {}),
    ...(options.baseURL !== undefined ? { baseURL: options.baseURL } : {}),
    ...(options.fetch !== undefined ? { fetch: options.fetch } : {}),
    ...(options.debugDir !== undefined ? { debugDir: options.debugDir } : {}),
  };

  const callResult = await callModel(
    {
      userPrompt: prompt,
      label: 'lexicon-suggest',
    },
    config,
  );

  if (!callResult.success || !callResult.content) {
    return {
      success: false,
      suggestions: [],
      prompt,
      rawResponse: callResult.content,
      usage: callResult.usage,
      error: callResult.error?.message ?? 'LLM call failed',
    };
  }

  const suggestions = parseSuggestions(callResult.content);
  return {
    success: true,
    suggestions,
    prompt,
    rawResponse: callResult.content,
    usage: callResult.usage,
  };
}
