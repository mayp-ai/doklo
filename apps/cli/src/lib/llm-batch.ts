import { estimateConservativeLlmCallTokens } from './llm-cost-cap.js';
import type { LlmPreparedCall } from './llm-preflight.js';

/** Phases that must run for the batch to mean anything; never deferred. */
const REQUIRED_PHASES = new Set(['consolidate', 'lexicon']);

export interface FittedCalls {
  /** Calls to run now, in the caller's original order. */
  readonly kept: LlmPreparedCall[];
  /** Calls left for a later run. Empty when the plan already fit. */
  readonly deferred: LlmPreparedCall[];
  /** True when work was actually deferred. */
  readonly capped: boolean;
  /** Conservative token reservation for `kept`. */
  readonly reservedTokens: number;
}

const tokensOf = (call: LlmPreparedCall): number =>
  estimateConservativeLlmCallTokens(call.prompt, call.maxOutputTokens);

/**
 * Split `calls` into a batch that fits `capTokens` and the remainder.
 *
 * Required-phase calls are always kept. If they alone exceed the cap there is
 * no batch that helps, so the input is returned unchanged and the caller still
 * hits the cap error — silently running an under-provisioned plan would be
 * worse than failing.
 */
export function fitCallsToRunCap(
  calls: readonly LlmPreparedCall[],
  capTokens: number,
): FittedCalls {
  const reservations = new Map<LlmPreparedCall, number>(calls.map((call) => [call, tokensOf(call)]));
  const total = calls.reduce((sum, call) => sum + (reservations.get(call) ?? 0), 0);
  if (total <= capTokens) {
    return { kept: [...calls], deferred: [], capped: false, reservedTokens: total };
  }

  const required = calls.filter((call) => REQUIRED_PHASES.has(call.phase));
  const requiredTokens = required.reduce((sum, call) => sum + (reservations.get(call) ?? 0), 0);
  if (requiredTokens > capTokens) {
    return { kept: [...calls], deferred: [], capped: false, reservedTokens: total };
  }

  // Greedy in the caller's order: the batch stays stable across runs, so a
  // repeat picks up exactly where this one stopped.
  const kept: LlmPreparedCall[] = [];
  const deferred: LlmPreparedCall[] = [];
  let spent = requiredTokens;
  for (const call of calls) {
    if (REQUIRED_PHASES.has(call.phase)) {
      kept.push(call);
      continue;
    }
    const tokens = reservations.get(call) ?? 0;
    if (spent + tokens <= capTokens) {
      kept.push(call);
      spent += tokens;
    } else {
      deferred.push(call);
    }
  }

  return { kept, deferred, capped: deferred.length > 0, reservedTokens: spent };
}

/** Minimal view of a prepared generation item this module needs. */
export interface GenerationBatchItem {
  readonly serviceId: string;
  readonly dokId: string;
  readonly prompt: string;
}

export interface GenerationBatch {
  readonly keptDokIds: string[];
  readonly deferredDokIds: string[];
  readonly capped: boolean;
  readonly reservedTokens: number;
}

/** Output allowance per generated Dok, mirroring the value generate.ts plans with. */
const GENERATE_MAX_OUTPUT_TOKENS = 8_192;

/**
 * Which Doks a single capped run should generate.
 *
 * The caller narrows both the plan and the prepared payload to `keptDokIds` and
 * passes them as `onlyDokIds` — the same path `doklo sync` uses — so the run's
 * digest, payload and work list stay consistent. Deferred Doks are produced by
 * running the command again: existing files are skipped without `--force`.
 */
export function selectGenerationBatch(
  items: readonly GenerationBatchItem[],
  capTokens: number,
): GenerationBatch {
  const calls: LlmPreparedCall[] = items.map((item) => ({
    phase: 'generate' as const,
    workItem: { phase: 'generate' as const, serviceId: item.serviceId, id: item.dokId },
    prompt: item.prompt,
    maxOutputTokens: GENERATE_MAX_OUTPUT_TOKENS,
  }));
  const fitted = fitCallsToRunCap(calls, capTokens);
  return {
    keptDokIds: fitted.kept.map((call) => call.workItem.id),
    deferredDokIds: fitted.deferred.map((call) => call.workItem.id),
    capped: fitted.capped,
    reservedTokens: fitted.reservedTokens,
  };
}
