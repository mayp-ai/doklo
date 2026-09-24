import { isSensitiveSourcePath } from '@doklo-beta/core';
import { createHash, randomUUID } from 'node:crypto';
import { realpath } from 'node:fs/promises';
import type { LLMUsage, ProviderKind } from '@doklo-beta/generator';
import { CommandContractError } from './command-result.js';
import {
  estimateConservativeLlmCallTokens,
  resolveLlmTokenLimits,
  reconcileRegisteredLlmCall,
  registerLlmRun,
  reserveRegisteredLlmCall,
  type LlmCallReservation,
  type RegisteredLlmRun,
} from './llm-cost-cap.js';

export const RUNTIME_TRUST_MODEL = 'anthropic/claude-sonnet-5' as const;
export const OPENAI_CODEX_RUNTIME_MODEL = 'openai/gpt-5.6-terra' as const;
export const OPENAI_CODEX_BASE_URL = 'https://chatgpt.com/backend-api/codex' as const;
export type RuntimeTrustModel =
  | typeof RUNTIME_TRUST_MODEL
  | typeof OPENAI_CODEX_RUNTIME_MODEL;


export type LlmRuntimeRoute =
  | 'anthropic-default'
  | 'claude-code-local'
  | 'openai-codex-oauth';

export type LlmAuthSource =
  | 'keychain'
  | 'environment'
  | 'oauth'
  | 'claude-code';

export type LlmPhase = 'consolidate' | 'lexicon' | 'generate' | 'judge';

export interface LlmTransmission {
  readonly phase: LlmPhase;
  /** Service whose LLM work item consumes this source. */
  readonly serviceId: string;
  /** Service that owns a cross-service source, when different provenance matters. */
  readonly originServiceId?: string;
  /** Workspace-relative code root of the originating service. */
  readonly codeRoot?: string;
  readonly file: string;
  readonly maxChars: number;
  /** Per-call binding for phases with multiple same-service work items. */
  readonly workItemId?: string;
}

export interface LlmRunPlan {
  readonly schema_version: 1;
  readonly providerKind: string;
  readonly route: LlmRuntimeRoute;
  readonly model: RuntimeTrustModel;
  readonly authSource: LlmAuthSource;
  readonly calls: Readonly<{
    consolidate: number;
    lexicon: number;
    generateMax: number;
    judgeMax: number;
    totalMax: number;
  }>;
  readonly tokenEstimate: {
    readonly inputTokens: number;
    readonly outputTokens: null;
    readonly maxOutputTokens: number;
    readonly inputMethod: 'utf8-bytes/4';
    readonly outputMethod: 'unknown';
    readonly cache: 'unknown-no-discount';
    readonly scope: 'all-prepared-calls-including-retries';
  };
  readonly reservedTokensMax: number;
  readonly maxTokensPerRun: number;
  readonly maxTokensTotal: number;
  readonly transmissions: readonly LlmTransmission[];
  readonly workItems: readonly LlmWorkItem[];
  readonly preparedCalls: readonly LlmPlannedCall[];
  readonly debugDir: string;
  readonly digest: string;
}

export interface LlmConsentReceipt {
  readonly schema_version: 1;
  readonly receiptId: string;
  readonly planDigest: string;
  readonly mode: 'prompt' | 'yes';
  readonly approvedAt: string;
}

export interface ConsolidationPreview {
  readonly serviceId: string;
  readonly sourceFeatureCount: number;
  readonly transmittedFiles: readonly string[];
  readonly estimatedInputTokens: number;
  readonly estimatedOutputTokens: number | null;
  readonly maxOutputTokens?: number;
  /** Exact immutable provider prompt prepared during the read-only preview. */
  readonly prompt?: string;
}

export interface LlmCandidateFile {
  phase: LlmPhase;
  serviceId: string;
  originServiceId?: string;
  codeRoot?: string;
  file: string;
  maxChars: number;
  /** Internal preview correlation only; omitted from the public consent plan. */
  dokId?: string;
}

export interface LlmWorkItem {
  readonly phase: LlmPhase;
  readonly serviceId: string;
  readonly id: string;
}

export interface LlmPreparedCall {
  readonly phase: LlmPhase;
  readonly workItem: LlmWorkItem;
  readonly prompt: string;
  readonly maxOutputTokens: number;
}

export interface LlmPlannedCall {
  readonly phase: LlmPhase;
  readonly workItem: LlmWorkItem;
  readonly promptBytes: number;
  readonly promptDigest: string;
  readonly maxOutputTokens: number;
  readonly reservedTokens: number;
}

export interface LlmPlanInput {
  llm: {
    providerKind: ProviderKind | string;
    model: string;
    authSource: LlmAuthSource;
    apiKey?: string;
    baseURL?: string;
    fetch?: typeof fetch;
  };
  previews?: readonly ConsolidationPreview[];
  candidateFiles: readonly (string | LlmCandidateFile)[];
  workItems?: readonly LlmWorkItem[];
  calls?: Partial<{
    consolidate: number;
    lexicon: number;
    generateMax: number;
    judgeMax: number;
  }>;
  reservedTokensMax?: number;
  preparedCalls?: readonly LlmPreparedCall[];
  debugDir: string;
  maxTokensPerRun?: number;
  maxTokensTotal?: number;
}

declare const authorizedLlmRunBrand: unique symbol;
export interface AuthorizedLlmRun {
  readonly [authorizedLlmRunBrand]: true;
}

interface AuthorizedRunState {
  canonicalRoot: string;
  plan: LlmRunPlan;
  registered: RegisteredLlmRun;
  llm: AuthorizedRuntimeLlm;
  prompts: ReadonlyMap<string, string>;
  usedWorkItems: Set<string>;
}

class AuthorizedRunCapability implements AuthorizedLlmRun {
  declare readonly [authorizedLlmRunBrand]: true;
}

const authorizedRuns = new WeakMap<object, AuthorizedRunState>();
const preparedPlanPrompts = new WeakMap<LlmRunPlan, ReadonlyMap<string, string>>();

type AuthorizedRuntimeLlm = Readonly<
  | {
      providerKind: 'anthropic';
      model: typeof RUNTIME_TRUST_MODEL;
      apiKey: string;
      baseURL?: undefined;
      fetch?: undefined;
    }
  | {
      providerKind: 'claude-code';
      model: typeof RUNTIME_TRUST_MODEL;
      apiKey?: undefined;
      baseURL?: undefined;
      fetch?: undefined;
    }
  | {
      providerKind: 'openai';
      model: typeof OPENAI_CODEX_RUNTIME_MODEL;
      baseURL: typeof OPENAI_CODEX_BASE_URL;
      fetch: typeof fetch;
      apiKey?: undefined;
    }
>;

export type AuthorizedLlmCall = AuthorizedRuntimeLlm & {
  readonly prompt: string;
  readonly reservation: LlmCallReservation;
};

export interface ApprovalInput {
  yes: boolean;
  isTTY: boolean;
  now?: () => string;
  confirm?: (input: { message: string }) => Promise<boolean | symbol>;
  isCancel?: (value: unknown) => boolean;
}

export interface LlmActualTransmission extends Omit<LlmTransmission, 'maxChars'> {
  readonly actualChars: number;
}

export function buildLlmRunPlan(input: LlmPlanInput): LlmRunPlan {
  assertRuntimeTrustModel(input.llm.model);
  const route = runtimeTrustRoute(input.llm);
  const limits = resolveLlmTokenLimits(input);

  const previews = input.previews ?? [];
  const rawPreparedCalls = input.preparedCalls ?? previews.flatMap((preview) =>
    preview.prompt === undefined
      ? []
      : [{
          phase: 'consolidate' as const,
          workItem: {
            phase: 'consolidate' as const,
            serviceId: preview.serviceId,
            id: preview.serviceId,
          },
          prompt: preview.prompt,
          maxOutputTokens: preview.maxOutputTokens ?? preview.estimatedOutputTokens ?? 32_768,
        }]);
  const prepared = normalizePreparedCalls(rawPreparedCalls);
  const preparedCounts = countPreparedCalls(prepared.descriptors);
  const calls = {
    consolidate: checkedCount(
      input.calls?.consolidate ?? (prepared.descriptors.length > 0
        ? preparedCounts.consolidate
        : previews.length),
      'consolidate',
    ),
    lexicon: checkedCount(
      input.calls?.lexicon ?? (prepared.descriptors.length > 0 ? preparedCounts.lexicon : 0),
      'lexicon',
    ),
    generateMax: checkedCount(
      input.calls?.generateMax
        ?? (prepared.descriptors.length > 0
          ? preparedCounts.generate
          : previews.reduce((sum, preview) => sum + preview.sourceFeatureCount, 0)),
      'generateMax',
    ),
    judgeMax: checkedCount(
      input.calls?.judgeMax ?? (prepared.descriptors.length > 0 ? preparedCounts.judge : 0),
      'judgeMax',
    ),
  };
  const withTotal = {
    ...calls,
    totalMax: calls.consolidate + calls.lexicon + calls.generateMax + calls.judgeMax,
  };
  if (prepared.descriptors.length > 0 && (
    calls.consolidate !== preparedCounts.consolidate
    || calls.lexicon !== preparedCounts.lexicon
    || calls.generateMax !== preparedCounts.generate
    || calls.judgeMax !== preparedCounts.judge
  )) {
    throw contractFailure('LLM_PLAN_INVALID', 'Prepared provider calls do not match call maxima.');
  }
  const reservedTokensMax = prepared.descriptors.length > 0
    ? prepared.descriptors.reduce((sum, call) => sum + call.reservedTokens, 0)
    : (input.reservedTokensMax ?? 0);
  if (!Number.isSafeInteger(reservedTokensMax) || reservedTokensMax < 0) {
    throw contractFailure('LLM_PLAN_INVALID', 'reservedTokensMax must be a non-negative safe integer.');
  }
  if (reservedTokensMax > limits.maxTokensPerRun) {
    throw contractFailure(
      'LLM_RUN_TOKEN_CAP',
      `Prepared LLM calls exceed the ${limits.maxTokensPerRun} token run cap.`,
    );
  }

  const transmissions = dedupeAndSortTransmissions([
    ...previews.flatMap((preview) =>
      preview.transmittedFiles.map((file): LlmTransmission => ({
        phase: 'consolidate',
        serviceId: preview.serviceId,
        file,
        maxChars: 0,
      }))),
    ...input.candidateFiles.map((candidate): LlmTransmission =>
      typeof candidate === 'string'
        ? { phase: 'generate', serviceId: 'workspace', file: candidate, maxChars: 2_000 }
        : {
            phase: candidate.phase,
            serviceId: candidate.serviceId,
            ...(candidate.originServiceId === undefined
              ? {}
              : { originServiceId: candidate.originServiceId }),
            ...(candidate.codeRoot === undefined ? {} : { codeRoot: candidate.codeRoot }),
            file: candidate.file,
            maxChars: candidate.maxChars,
            ...(candidate.dokId === undefined ? {} : { workItemId: candidate.dokId }),
          }),
  ].filter((item) => !isSensitiveLlmPath(item.file)));
  const workItems = dedupeAndSortWorkItems([
    ...(input.workItems ?? []),
    ...prepared.descriptors.map((call) => call.workItem),
  ]);

  const unsigned = {
    schema_version: 1 as const,
    providerKind: input.llm.providerKind,
    route,
    model: input.llm.model,
    authSource: input.llm.authSource,
    calls: withTotal,
    reservedTokensMax,
    tokenEstimate: {
      inputTokens: prepared.descriptors.reduce((sum, call) => sum + Math.ceil(call.promptBytes / 4), 0),
      outputTokens: null,
      maxOutputTokens: prepared.descriptors.reduce((sum, call) => sum + call.maxOutputTokens, 0),
      inputMethod: 'utf8-bytes/4' as const,
      outputMethod: 'unknown' as const,
      cache: 'unknown-no-discount' as const,
      scope: 'all-prepared-calls-including-retries' as const,
    },
    maxTokensPerRun: limits.maxTokensPerRun,
    maxTokensTotal: limits.maxTokensTotal,
    transmissions,
    workItems,
    preparedCalls: prepared.descriptors,
    debugDir: input.debugDir,
  };
  const digest = digestUnsignedPlan(unsigned);
  const plan = deepFreeze({ ...unsigned, digest });
  preparedPlanPrompts.set(plan, prepared.prompts);
  return plan;
}

export async function approveLlmRunPlan(
  plan: LlmRunPlan,
  input: ApprovalInput,
): Promise<LlmConsentReceipt> {
  let mode: LlmConsentReceipt['mode'];
  if (input.yes) {
    mode = 'yes';
  } else {
    if (!input.isTTY) {
      throw contractFailure(
        'LLM_CONSENT_REQUIRED',
        'LLM consent requires --yes when stdin is not a TTY.',
      );
    }
    let confirm = input.confirm;
    let isCancel = input.isCancel;
    if (!confirm) {
      const prompts = await import('@clack/prompts');
      confirm = prompts.confirm;
      isCancel = prompts.isCancel;
    }
    const approved = await confirm({
      message: `Approve capped LLM plan ${plan.digest.slice(0, 12)}?`,
    });
    if ((isCancel?.(approved) ?? typeof approved === 'symbol') || approved !== true) {
      throw contractFailure('LLM_CONSENT_DECLINED', 'LLM run was not approved.');
    }
    mode = 'prompt';
  }

  return deepFreeze({
    schema_version: 1 as const,
    receiptId: randomUUID(),
    planDigest: plan.digest,
    mode,
    approvedAt: (input.now ?? (() => new Date().toISOString()))(),
  });
}

export async function authorizeLlmRun(
  root: string,
  plan: LlmRunPlan,
  llm: {
    providerKind: ProviderKind | string;
    model: string;
    authSource?: LlmAuthSource;
    apiKey?: string;
    baseURL?: string;
    fetch?: typeof fetch;
  },
  approval: ApprovalInput,
): Promise<AuthorizedLlmRun> {
  assertRuntimeTrustModel(llm.model);
  const route = runtimeTrustRoute(llm);
  assertRuntimeTrustCredential(llm);
  if (
    plan.providerKind !== llm.providerKind
    || plan.route !== route
    || plan.model !== llm.model
    || plan.calls.totalMax <= 0
    || plan.workItems.length === 0
    || plan.preparedCalls.length !== plan.calls.totalMax
  ) {
    throw contractFailure('LLM_PLAN_INVALID', 'The exact prepared provider call list is incomplete.');
  }
  const prompts = preparedPlanPrompts.get(plan);
  if (!prompts || prompts.size !== plan.preparedCalls.length) {
    throw contractFailure('LLM_PLAN_INVALID', 'Exact prepared provider prompts are unavailable.');
  }
  const canonicalRoot = await realpath(root);
  const receipt = await approveLlmRunPlan(plan, approval);
  assertLlmConsent(plan, receipt);
  const registered = await registerLlmRun(canonicalRoot, {
    receiptId: receipt.receiptId,
    planDigest: plan.digest,
    maxCalls: plan.calls.totalMax,
    maxTokensPerRun: plan.maxTokensPerRun,
    maxTokensTotal: plan.maxTokensTotal,
  });
  let authorizedLlm: AuthorizedRuntimeLlm;
  if (route === 'claude-code-local') {
    authorizedLlm = Object.freeze({
      providerKind: 'claude-code' as const,
      model: RUNTIME_TRUST_MODEL,
    });
  } else if (route === 'openai-codex-oauth') {
    authorizedLlm = Object.freeze({
      providerKind: 'openai' as const,
      model: OPENAI_CODEX_RUNTIME_MODEL,
      baseURL: OPENAI_CODEX_BASE_URL,
      fetch: llm.fetch!,
    });
  } else {
    authorizedLlm = Object.freeze({
      providerKind: 'anthropic' as const,
      model: RUNTIME_TRUST_MODEL,
      apiKey: llm.apiKey!,
    });
  }
  const capability = new AuthorizedRunCapability();
  authorizedRuns.set(capability, {
    canonicalRoot,
    plan,
    registered,
    llm: authorizedLlm,
    prompts,
    usedWorkItems: new Set(),
  });
  return Object.freeze(capability);
}

export async function requireAuthorizedLlmRun(
  run: AuthorizedLlmRun | undefined,
  root: string,
): Promise<void> {
  await authorizedRunState(run, root);
}

/** Return the exact approved plan digest bound to an authorized capability. */
export async function getAuthorizedLlmRunPlanDigest(
  run: AuthorizedLlmRun | undefined,
  root: string,
): Promise<string> {
  return (await authorizedRunState(run, root)).plan.digest;
}

/** Return the exact runtime model bound to an authorized capability. */
export async function getAuthorizedLlmRunModel(
  run: AuthorizedLlmRun | undefined,
  root: string,
): Promise<RuntimeTrustModel> {
  return (await authorizedRunState(run, root)).plan.model;
}

export async function beginAuthorizedLlmCall(
  run: AuthorizedLlmRun | undefined,
  root: string,
  actual: {
    phase: LlmPhase;
    workItem: LlmWorkItem;
    debugDir: string;
    transmissions: readonly LlmActualTransmission[];
    prompt: string;
  },
): Promise<AuthorizedLlmCall> {
  const state = await authorizedRunState(run, root);
  assertPlanIntegrity(state.plan);
  const key = workItemKey(actual.workItem);
  const descriptor = state.plan.preparedCalls.find((call) =>
    workItemKey(call.workItem) === key);
  const expectedPrompt = state.prompts.get(key);
  const promptMatches = descriptor !== undefined
    && expectedPrompt !== undefined
    && actual.phase === descriptor.phase
    && actual.workItem.phase === actual.phase
    && actual.prompt === expectedPrompt
    && Buffer.byteLength(actual.prompt, 'utf8') === descriptor.promptBytes
    && createHash('sha256').update(actual.prompt, 'utf8').digest('hex') === descriptor.promptDigest;
  const expectedSources = new Map<string, LlmTransmission>();
  let ambiguousExpectedSource = false;
  for (const allowed of state.plan.transmissions) {
    if (
      allowed.phase !== actual.phase
      || allowed.serviceId !== actual.workItem.serviceId
      || (allowed.workItemId !== undefined && allowed.workItemId !== actual.workItem.id)
    ) continue;
    const sourceKey = transmissionKey(allowed);
    if (expectedSources.has(sourceKey)) ambiguousExpectedSource = true;
    expectedSources.set(sourceKey, allowed);
  }
  const actualSources = new Map<string, number>();
  let duplicateActualSource = false;
  let invalidActualSource = false;
  for (const sent of actual.transmissions) {
    if (
      sent.phase !== actual.phase
      || sent.serviceId !== actual.workItem.serviceId
      || !Number.isInteger(sent.actualChars)
      || sent.actualChars < 0
    ) {
      invalidActualSource = true;
      continue;
    }
    const sourceKey = transmissionKey(sent);
    if (actualSources.has(sourceKey)) duplicateActualSource = true;
    actualSources.set(sourceKey, (actualSources.get(sourceKey) ?? 0) + sent.actualChars);
  }
  const transmissionsMatch = !ambiguousExpectedSource
    && !duplicateActualSource
    && !invalidActualSource
    && actualSources.size === expectedSources.size
    && [...expectedSources].every(([sourceKey, allowed]) => {
      const actualChars = actualSources.get(sourceKey);
      return actualChars !== undefined && actualChars <= allowed.maxChars;
    });
  if (
    !promptMatches
    || state.usedWorkItems.has(key)
    || actual.debugDir !== state.plan.debugDir
    || !transmissionsMatch
  ) {
    throw contractFailure(
      'LLM_OPERATION_NOT_AUTHORIZED',
      'The provider call is not authorized by this exact prepared run.',
    );
  }
  const reservation = await reserveRegisteredLlmCall(state.registered, {
    callKey: callKey(actual.workItem),
    reservedTokens: descriptor.reservedTokens,
  });
  state.usedWorkItems.add(key);
  return Object.freeze({
    ...state.llm,
    prompt: expectedPrompt,
    reservation,
  });
}

export async function completeAuthorizedLlmCall(
  run: AuthorizedLlmRun | undefined,
  root: string,
  call: AuthorizedLlmCall,
  usage: LLMUsage | null | undefined,
): Promise<number> {
  const state = await authorizedRunState(run, root);
  return reconcileRegisteredLlmCall(state.registered, call.reservation, usage);
}

async function authorizedRunState(
  run: AuthorizedLlmRun | undefined,
  root: string,
): Promise<AuthorizedRunState> {
  if (run === undefined) {
    throw contractFailure('LLM_CONSENT_REQUIRED', 'LLM work requires an authorized run.');
  }
  const state = authorizedRuns.get(run as object);
  if (!state) {
    throw contractFailure('LLM_AUTHORIZED_RUN_INVALID', 'The authorized LLM run is invalid or forged.');
  }
  const canonicalRoot = await realpath(root);
  if (canonicalRoot !== state.canonicalRoot) {
    throw contractFailure(
      'LLM_AUTHORIZED_RUN_ROOT_MISMATCH',
      'The authorized LLM run belongs to another workspace root.',
    );
  }
  return state;
}

function assertPlanIntegrity(plan: LlmRunPlan): void {
  const { digest: _digest, ...unsigned } = plan;
  if (digestUnsignedPlan(unsigned) !== plan.digest) {
    throw contractFailure('CONSENT_PLAN_CHANGED', 'LLM plan changed after approval.');
  }
}

function callKey(workItem: LlmWorkItem): string {
  return `${workItem.phase}/${workItem.serviceId}/${workItem.id}`;
}

export function assertLlmConsent(
  plan: LlmRunPlan | undefined,
  receipt: LlmConsentReceipt | undefined,
): asserts plan is LlmRunPlan {
  if (!plan || !receipt) {
    throw contractFailure(
      'LLM_CONSENT_REQUIRED',
      'LLM work requires an immutable plan and matching consent receipt.',
    );
  }
  const { digest: _digest, ...unsigned } = plan;
  const currentDigest = digestUnsignedPlan(unsigned);
  if (
    currentDigest !== plan.digest
    || receipt.planDigest !== plan.digest
    || receipt.schema_version !== 1
    || typeof receipt.receiptId !== 'string'
    || receipt.receiptId.length === 0
    || (receipt.mode !== 'prompt' && receipt.mode !== 'yes')
    || typeof receipt.approvedAt !== 'string'
    || receipt.approvedAt.length === 0
  ) {
    throw contractFailure(
      'CONSENT_PLAN_CHANGED',
      'LLM plan changed after approval.',
    );
  }
}

export function assertRuntimeTrustModel(model: string): asserts model is RuntimeTrustModel {
  if (model !== RUNTIME_TRUST_MODEL && model !== OPENAI_CODEX_RUNTIME_MODEL) {
    throw contractFailure(
      'RUNTIME_TRUST_MODEL_REQUIRED',
      `Runtime trust requires model "${RUNTIME_TRUST_MODEL}" or "${OPENAI_CODEX_RUNTIME_MODEL}"; resolved "${model}".`,
    );
  }
}

export function assertRuntimeTrustRoute(llm: {
  providerKind: string;
  model: string;
  authSource?: LlmAuthSource;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): void {
  runtimeTrustRoute(llm);
}

export function assertRuntimeTrustCredential(llm: {
  providerKind: string;
  model: string;
  authSource?: LlmAuthSource;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): void {
  const route = runtimeTrustRoute(llm);
  if (route === 'claude-code-local' || route === 'openai-codex-oauth') return;
  if (llm.apiKey === undefined || llm.apiKey.length === 0) {
    throw contractFailure(
      'RUNTIME_TRUST_CREDENTIAL_REQUIRED',
      'Runtime trust requires an Anthropic API credential from the keychain or environment.',
    );
  }
}

function runtimeTrustRoute(llm: {
  providerKind: string;
  model: string;
  authSource?: LlmAuthSource;
  apiKey?: string;
  baseURL?: string;
  fetch?: typeof fetch;
}): LlmRuntimeRoute {
  const defaultTransport = llm.baseURL === undefined && llm.fetch === undefined;
  if (
    llm.providerKind === 'anthropic'
    && llm.model === RUNTIME_TRUST_MODEL
    && defaultTransport
    && (
      llm.authSource === undefined
      || llm.authSource === 'keychain'
      || llm.authSource === 'environment'
    )
  ) {
    return 'anthropic-default';
  }
  if (
    llm.providerKind === 'claude-code'
    && llm.model === RUNTIME_TRUST_MODEL
    && defaultTransport
    && llm.apiKey === undefined
    && (llm.authSource === undefined || llm.authSource === 'claude-code')
  ) {
    return 'claude-code-local';
  }
  if (
    llm.providerKind === 'openai'
    && llm.model === OPENAI_CODEX_RUNTIME_MODEL
    && llm.authSource === 'oauth'
    && llm.apiKey === undefined
    && llm.baseURL === OPENAI_CODEX_BASE_URL
    && typeof llm.fetch === 'function'
  ) {
    return 'openai-codex-oauth';
  }
  throw contractFailure(
    'RUNTIME_TRUST_ROUTE_REQUIRED',
    'Runtime trust requires direct Anthropic, credential-free local Claude Code, or exact OpenAI Codex OAuth.',
  );
}

export function isSensitiveLlmPath(file: string): boolean {
  if (isSensitiveSourcePath(file)) return true;
  const normalized = file.replaceAll('\\', '/').replace(/^\.\//, '');
  const lower = normalized.toLowerCase();
  const parts = lower.split('/').filter(Boolean);
  const base = parts.at(-1) ?? '';

  if (base === '.env' || base.startsWith('.env.')) return true;
  if (/\.(?:pem|key|crt|cer|p12|pfx|jks|keystore)$/.test(base)) return true;
  if (/^(?:id_rsa|id_dsa|id_ecdsa|id_ed25519|credentials|secrets?)(?:\.|$)/.test(base)) return true;
  if (/\.(?:test|spec)\.[^.]+$/.test(base) || /\.d\.ts$/.test(base)) return true;
  if (/\.generated\.[^.]+$/.test(base)) return true;
  const excludedDirs = new Set([
    'node_modules', 'vendor', '.next', 'dist', 'build', 'out', 'coverage',
    '__tests__', '__mocks__', 'test', 'tests', 'spec', 'specs', 'generated',
    'cert', 'certs', 'certificate', 'certificates', 'keys', 'secrets',
  ]);
  return parts.slice(0, -1).some((part) => excludedDirs.has(part));
}

export interface LlmBudgetSnapshot { chargedTokens: number; legacyLedgerPresent: boolean }
export function formatLlmRunPlan(plan: LlmRunPlan, budget?: LlmBudgetSnapshot): string {
  const phases = [
    `consolidate=${plan.calls.consolidate}`,
    `lexicon=${plan.calls.lexicon}`,
    `generate<=${plan.calls.generateMax}`,
    `judge<=${plan.calls.judgeMax}`,
  ].join(', ');
  const transmissionLines = plan.transmissions.map((item) =>
    `    - ${item.phase} ${item.serviceId} ${item.file} maxChars=${item.maxChars}${
      item.workItemId === undefined ? '' : ` workItem=${item.workItemId}`
    }${item.originServiceId === undefined ? '' : ` origin=${item.originServiceId}`}${
      item.codeRoot === undefined ? '' : ` codeRoot=${item.codeRoot}`
    }`);
  return [
    `LLM consent plan ${plan.digest}`,
    `  model: ${plan.model} (${plan.authSource}; ${plan.route})`,
    `  calls: ${phases}; total<=${plan.calls.totalMax}`,
    `  tokens: input ~${plan.preparedCalls.reduce((sum, call) => sum + Math.ceil(call.promptBytes / 4), 0).toLocaleString('en-US')} (bytes / 4); output allowance ${plan.preparedCalls.reduce((sum, call) => sum + call.maxOutputTokens, 0).toLocaleString('en-US')} (maximum, not an estimate)`,
    `  token limits: run<=${plan.maxTokensPerRun.toLocaleString('en-US')}, workspace total<=${plan.maxTokensTotal.toLocaleString('en-US')}; reservation ${plan.reservedTokensMax.toLocaleString('en-US')} (UTF-8 bytes + output allowance)`,
    ...(budget ? [`  workspace usage: ${budget.chargedTokens.toLocaleString('en-US')} tokens accounted (includes unresolved reservations); remaining ${Math.max(0, plan.maxTokensTotal - budget.chargedTokens).toLocaleString('en-US')}`] : []),
    ...(budget?.legacyLedgerPresent ? ['  Token accounting starts with this token ledger; older accounting is preserved and is not converted into historical token usage.'] : []),
    '  Adjust: DOKLO_MAX_TOKENS_PER_RUN=<tokens> DOKLO_MAX_TOKENS_TOTAL=<tokens> doklo generate',
    '  Cache hits and cache creation are unknown until the provider responds; no cache savings are assumed. Input uses bytes / 4, which varies by language and model. Output includes any provider-reported reasoning tokens.',
    '  Calls and allowances include the displayed authorized retries; unattempted retries are not measured usage. Generation heuristics cover generation only, excluding consolidation and other phases.',
    '  Reduce scope before approval with --service <id>; after consolidation, use generate --only <DOK-ID,...>. Cancel now to inspect or change the source scope.',
    '  Reservations are conservative estimates, not provider hard limits. Cap breaches stop subsequent calls; unknown usage retains its reservation.',
    `  transmissions: ${plan.transmissions.length} contained file reference(s)`,
    ...transmissionLines,
    `  debug: ${plan.debugDir}`,
  ].join('\n');
}

export function emitLlmRunPlan(
  plan: LlmRunPlan,
  input: {
    machine: boolean;
    budget?: LlmBudgetSnapshot;
    stdout?: Pick<NodeJS.WriteStream, 'write'>;
  },
): void {
  const stdout = input.stdout ?? process.stdout;
  if (input.machine) {
    stdout.write(`${JSON.stringify({ stage: 'consent-plan', plan, ...(input.budget ? { budget: input.budget } : {}) })}\n`);
    return;
  }
  stdout.write(`${formatLlmRunPlan(plan, input.budget)}\n`);
}

function digestUnsignedPlan(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) =>
    `${JSON.stringify(key)}:${stableStringify(record[key])}`).join(',')}}`;
}

function dedupeAndSortTransmissions(items: LlmTransmission[]): LlmTransmission[] {
  const byKey = new Map<string, LlmTransmission>();
  for (const item of items) {
    if (!Number.isInteger(item.maxChars) || item.maxChars < 0) {
      throw contractFailure('LLM_PLAN_INVALID', `Invalid maxChars for ${item.file}.`);
    }
    if ((item.originServiceId === undefined) !== (item.codeRoot === undefined)) {
      throw contractFailure(
        'LLM_PLAN_INVALID',
        `Source origin service and code root must be provided together for ${item.file}.`,
      );
    }
    const normalized = {
      ...item,
      file: normalizePlanPath(item.file),
      ...(item.codeRoot === undefined ? {} : { codeRoot: normalizePlanPath(item.codeRoot) }),
    };
    const key = `${normalized.phase}\0${normalized.serviceId}\0${
      normalized.originServiceId ?? ''
    }\0${normalized.codeRoot ?? ''}\0${normalized.file}\0${
      normalized.workItemId ?? ''
    }`;
    const existing = byKey.get(key);
    if (!existing || normalized.maxChars > existing.maxChars) byKey.set(key, normalized);
  }
  return [...byKey.values()].sort((a, b) =>
    a.phase.localeCompare(b.phase)
      || a.serviceId.localeCompare(b.serviceId)
      || (a.originServiceId ?? '').localeCompare(b.originServiceId ?? '')
      || (a.codeRoot ?? '').localeCompare(b.codeRoot ?? '')
      || a.file.localeCompare(b.file)
      || a.maxChars - b.maxChars);
}

function dedupeAndSortWorkItems(items: readonly LlmWorkItem[]): LlmWorkItem[] {
  const byKey = new Map<string, LlmWorkItem>();
  for (const item of items) {
    if (item.serviceId.trim() === '' || item.id.trim() === '') {
      throw contractFailure('LLM_PLAN_INVALID', 'LLM work item identifiers cannot be empty.');
    }
    byKey.set(workItemKey(item), { ...item });
  }
  return [...byKey.values()].sort((a, b) => workItemKey(a).localeCompare(workItemKey(b)));
}

function workItemKey(item: LlmWorkItem): string {
  return `${item.phase}\0${item.serviceId}\0${item.id}`;
}

function normalizePreparedCalls(calls: readonly LlmPreparedCall[]): {
  descriptors: LlmPlannedCall[];
  prompts: ReadonlyMap<string, string>;
} {
  const descriptors = new Map<string, LlmPlannedCall>();
  const prompts = new Map<string, string>();
  for (const call of calls) {
    if (call.phase !== call.workItem.phase || typeof call.prompt !== 'string') {
      throw contractFailure('LLM_PLAN_INVALID', 'Prepared call phase and work item must match.');
    }
    if (!Number.isInteger(call.maxOutputTokens) || call.maxOutputTokens < 0) {
      throw contractFailure('LLM_PLAN_INVALID', 'Prepared call output allowance is invalid.');
    }
    const key = workItemKey(call.workItem);
    if (descriptors.has(key)) {
      throw contractFailure('LLM_PLAN_INVALID', 'Prepared LLM work items must be unique.');
    }
    const promptDigest = createHash('sha256').update(call.prompt, 'utf8').digest('hex');
    descriptors.set(key, {
      phase: call.phase,
      workItem: { ...call.workItem },
      promptBytes: Buffer.byteLength(call.prompt, 'utf8'),
      promptDigest,
      maxOutputTokens: call.maxOutputTokens,
      reservedTokens: estimateConservativeLlmCallTokens(call.prompt, call.maxOutputTokens),
    });
    prompts.set(key, call.prompt);
  }
  const sorted = [...descriptors.values()].sort((a, b) =>
    workItemKey(a.workItem).localeCompare(workItemKey(b.workItem)));
  return { descriptors: sorted, prompts };
}

function countPreparedCalls(calls: readonly LlmPlannedCall[]): Record<LlmPhase, number> {
  const counts: Record<LlmPhase, number> = {
    consolidate: 0,
    lexicon: 0,
    generate: 0,
    judge: 0,
  };
  for (const call of calls) counts[call.phase] += 1;
  return counts;
}

function normalizePlanPath(file: string): string {
  return file.replaceAll('\\', '/').replace(/^\.\//, '');
}

function transmissionKey(
  item: Pick<
    LlmTransmission,
    'phase' | 'serviceId' | 'originServiceId' | 'codeRoot' | 'file'
  >,
): string {
  return `${item.phase}\0${item.serviceId}\0${item.originServiceId ?? ''}\0${
    item.codeRoot === undefined ? '' : normalizePlanPath(item.codeRoot)
  }\0${normalizePlanPath(item.file)}`;
}

function checkedCount(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw contractFailure('LLM_PLAN_INVALID', `${field} must be a non-negative integer.`);
  }
  return value;
}

function contractFailure(code: string, message: string): CommandContractError {
  return new CommandContractError({
    schema_version: 1,
    command: 'llm',
    status: 'cancelled',
    data: null,
    diagnostics: [{ code, message }],
  }, 2);
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value as Record<string, unknown>)) deepFreeze(child);
  }
  return value;
}
