import type { PrioritySignal } from '@doklo-beta/core';

// Deterministic priority evidence.
//
// These produce `signals` only — never an axis value. A signal is a fact
// ("this file declares a money-typed persisted field at line 44"); turning
// facts into a judgment belongs to the LLM or to a person, and the axis they
// choose is checked against these signals rather than derived from them.
//
// Precision over recall, deliberately. A false `revenue` signal makes a human
// distrust the whole priority field; a missing one just means the judgment is
// made unaided, which is the normal path for most axes anyway.

export const MONEY_MODEL_DETECTOR = 'money-model';
export const PAYMENT_SDK_DETECTOR = 'payment-sdk';
export const AUTH_GUARD_DETECTOR = 'auth-guard';

export interface PriorityDetectorInput {
  /** Files this Dok was derived from, repo-relative POSIX paths. */
  files: readonly string[];
  /** path → content. Files absent from the map are skipped, not an error. */
  contents: ReadonlyMap<string, string>;
}

// A money-named field WITH a numeric type declaration on the same line. Both
// halves are required: `amount` alone appears in prose and string literals,
// and `{ type: Number }` alone is any counter.
//
// This is the primary revenue detector, and it is a *domain model* detector
// rather than a dependency one: products can move real money through a
// hand-rolled bank-transfer flow without declaring a payment SDK. A numeric
// money field is the signal that still exists in that case.
const MONEY_FIELD =
  /\b(?:amount|totalAmount|totalPrice|unitPrice|price|credits?|balance|fee|discountAmount|refundAmount)\s*\??\s*:\s*(?:\{\s*type\s*:\s*Number\b|number\b)/;

// Secondary signal. Absent from both pilots — kept because when it IS present
// it is near-certain, but never relied on as the primary revenue detector.
const PAYMENT_SDK =
  /\bfrom\s+['"](?:stripe|@stripe\/[\w-]+|@tosspayments\/[\w-]+|iamport[\w-]*|@portone\/[\w-]+|portone[\w-]*|@paypal\/[\w-]+|nicepay[\w-]*)['"]/;

// Server-side authentication wrappers — the ones applied *selectively*, so
// their presence still distinguishes one surface from another.
//
// Deliberately NOT included: NextAuth v5's bare `auth()`. In observed projects
// it appears on essentially every authenticated page, and a signal that fires on
// everything carries no information — it would dilute auth-guard into noise
// exactly where we need it to point at the blocking surfaces. Root middleware
// (below) and explicit wrappers are the discriminating signals; a page that
// merely reads the session to print a username is not a gate.
const AUTH_GUARD =
  /\b(?:withUserAuth|withAuth|withAdminAuth|requireAuth|requireSession|requireUser|getServerSession|ensureAuthenticated|assertSession)\b/;

/** A root-level middleware file gates every route its matcher covers. */
function isRootMiddleware(file: string): boolean {
  return /^(?:src\/)?middleware\.(?:ts|tsx|js|mjs)$/.test(file);
}

// Order matters only for the one-signal-per-line rule below: the first match
// wins, so the more specific patterns are listed first.
const LINE_PATTERNS: readonly { detector: string; pattern: RegExp }[] = [
  { detector: PAYMENT_SDK_DETECTOR, pattern: PAYMENT_SDK },
  { detector: MONEY_MODEL_DETECTOR, pattern: MONEY_FIELD },
  { detector: AUTH_GUARD_DETECTOR, pattern: AUTH_GUARD },
];

/**
 * Scan a Dok's source files for priority evidence.
 *
 * Output order follows `files`, then line number, so two runs over an
 * unchanged tree produce byte-identical signals and never show up as a diff.
 */
export function detectPrioritySignals(input: PriorityDetectorInput): PrioritySignal[] {
  const signals: PrioritySignal[] = [];

  for (const file of input.files) {
    const content = input.contents.get(file);
    if (content === undefined) continue;

    // A root middleware guards by existing, regardless of what it contains.
    if (isRootMiddleware(file)) {
      signals.push({ file, start_line: 1, detector: AUTH_GUARD_DETECTOR });
      continue;
    }

    content.split('\n').forEach((line, index) => {
      for (const { detector, pattern } of LINE_PATTERNS) {
        if (!pattern.test(line)) continue;
        signals.push({ file, start_line: index + 1, detector });
        return; // one signal per line — the first match is the specific one
      }
    });
  }

  return signals;
}
