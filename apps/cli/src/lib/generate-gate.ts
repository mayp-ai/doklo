// Pure presentation helpers for the `doklo generate` preview/confirm gate.
// No IO, no prompts — the command action does the clack confirm and the
// runGenerate calls; this file only turns a plan into strings/numbers so it
// stays unit-testable.
import { createContext } from './context.js';

export interface GatePlanItem {
  serviceId: string;
  dokId: string;
  featureLabel: string;
  domain: string;
}

export interface GenerateTokenEstimate {
  inputTokens: number;
  outputTokens: number;
  maxOutputTokens: number;
}

/** UTF-8 bytes / 4 is a heuristic, not a provider tokenizer. Output is a
 * rough 1,500 tokens per Dok, deliberately distinct from its 8,192 limit. */
export function estimateGenerateTokens(items: readonly { prompt: string }[]): GenerateTokenEstimate {
  return {
    inputTokens: items.reduce((sum, item) => sum + Math.ceil(Buffer.byteLength(item.prompt, 'utf8') / 4), 0),
    outputTokens: items.length * 1500,
    maxOutputTokens: items.length * 8192,
  };
}

// Observed per-Dok wall-clock band (Sonnet/reasoning models): 30s–2min.
const MIN_SECONDS_PER_DOK = 30;
const MAX_SECONDS_PER_DOK = 120;

/** Domain counts and up to three human-readable examples; full IDs are opt-in. */
export function formatGeneratePlan(plan: GatePlanItem[], details = false): string {
  const byDomain = new Map<string, GatePlanItem[]>();
  for (const item of plan) {
    const bucket = byDomain.get(item.domain) ?? [];
    bucket.push(item);
    byDomain.set(item.domain, bucket);
  }
  return [...byDomain].map(([domain, items]) => {
    const examples = details
      ? items.map((item) => `${item.dokId} — ${item.featureLabel}`).join(', ')
      : items.slice(0, 3).map((item) => item.featureLabel).join(', ')
        + (items.length > 3 ? ` … (+${items.length - 3})` : '');
    return `  ${domain} (${items.length}): ${examples}`;
  }).join('\n');
}

function formatMinutesRange(dokCount: number): string {
  const lo = Math.max(1, Math.round((dokCount * MIN_SECONDS_PER_DOK) / 60));
  const hi = Math.max(lo, Math.round((dokCount * MAX_SECONDS_PER_DOK) / 60));
  return lo === hi ? `~${lo}min` : `~${lo}–${hi}min`;
}

/** Same selected batch as the paid run; no pricing registry dependency. */
export function formatGateSummary(
  dokCount: number,
  tokens: GenerateTokenEstimate,
  locale: 'en' | 'ko' = 'en',
): string {
  return createContext(locale).t('generate.token_summary', {
    count: dokCount,
    input: tokens.inputTokens.toLocaleString('en-US'),
    output: tokens.outputTokens.toLocaleString('en-US'),
    time: formatMinutesRange(dokCount),
  });
}

/** Prompt only on an interactive TTY without an explicit skip. Non-TTY
 * (pipe/CI) and `--yes` proceed without asking. */
export function shouldPromptGate(opts: { yes: boolean; isTTY: boolean }): boolean {
  return opts.isTTY && !opts.yes;
}

export type GateChoice = 'generate' | 'studio' | 'cancel';
export interface GateLabels { generate: string; studio: string; cancel: string }
export interface GateInteractionDeps {
  select: (opts: {
    message: string;
    options: { value: GateChoice; label: string }[];
  }) => Promise<GateChoice | symbol>;
  isCancel: (v: unknown) => boolean;
  launchStudio: () => Promise<void>;
}

/** Show the 3-way gate (Generate / Adjust in Studio / Cancel). On "studio"
 *  the caller-supplied launcher runs (blocking `dk serve`) before returning;
 *  the caller then stops (does not generate) so the user re-runs `generate`
 *  after editing. ESC / cancel maps to "cancel". */
export async function runGateInteraction(
  message: string,
  labels: GateLabels,
  deps: GateInteractionDeps,
): Promise<GateChoice> {
  const choice = await deps.select({
    message,
    options: [
      { value: 'generate', label: labels.generate },
      { value: 'studio', label: labels.studio },
      { value: 'cancel', label: labels.cancel },
    ],
  });
  if (deps.isCancel(choice)) return 'cancel';
  if (choice === 'studio') {
    await deps.launchStudio();
    return 'studio';
  }
  return choice === 'cancel' ? 'cancel' : 'generate';
}
