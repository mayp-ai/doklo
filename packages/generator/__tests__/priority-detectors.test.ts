import { describe, expect, it } from 'vitest';
import {
  detectPrioritySignals,
  MONEY_MODEL_DETECTOR,
  PAYMENT_SDK_DETECTOR,
  AUTH_GUARD_DETECTOR,
} from '../src/priority-detectors.js';

function run(files: Record<string, string>) {
  return detectPrioritySignals({
    files: Object.keys(files),
    contents: new Map(Object.entries(files)),
  });
}

describe('money-model detector', () => {
  // Covers a Mongoose schema with no payment SDK in the dependency tree. A
  // dependency-based detector scores 0 here.
  it('finds a mongoose money field', () => {
    const signals = run({
      'models/order.model.ts': [
        'const OrderSchema = new Schema({',
        '  status: { type: String },',
        '  amount: { type: Number, required: true },',
        '});',
      ].join('\n'),
    });
    expect(signals).toEqual([
      { file: 'models/order.model.ts', start_line: 3, detector: MONEY_MODEL_DETECTOR },
    ]);
  });

  it('finds a plain TypeScript money field', () => {
    const signals = run({
      'types/credit.ts': 'export interface Credit {\n  totalAmount: number;\n}',
    });
    expect(signals).toHaveLength(1);
    expect(signals[0]?.start_line).toBe(2);
  });

  it('finds an optional money field', () => {
    const signals = run({ 'types/order.ts': 'interface O {\n  discountAmount?: number;\n}' });
    expect(signals[0]?.detector).toBe(MONEY_MODEL_DETECTOR);
  });

  it('ignores a numeric field that is not money', () => {
    expect(run({ 'models/page.ts': 'const S = { pageCount: { type: Number } };' })).toEqual([]);
  });

  // Precision guard: "amount" as a bare word in prose or a string must not fire.
  it('ignores a money word with no numeric declaration', () => {
    expect(run({ 'docs/notes.ts': 'const label = "amount owed";' })).toEqual([]);
  });

  it('reports every match in a file, not just the first', () => {
    const signals = run({
      'models/credit.model.ts': [
        'const A = { totalAmount: { type: Number } };',
        'const B = { amount: { type: Number } };',
      ].join('\n'),
    });
    expect(signals.map((s) => s.start_line)).toEqual([1, 2]);
  });
});

describe('payment-sdk detector', () => {
  it('finds a payment SDK import as a secondary signal', () => {
    const signals = run({ 'lib/pay.ts': "import Stripe from 'stripe';" });
    expect(signals).toEqual([
      { file: 'lib/pay.ts', start_line: 1, detector: PAYMENT_SDK_DETECTOR },
    ]);
  });

  it('finds a scoped Korean PG SDK', () => {
    const signals = run({
      'lib/pay.ts': "import { loadTossPayments } from '@tosspayments/payment-sdk';",
    });
    expect(signals[0]?.detector).toBe(PAYMENT_SDK_DETECTOR);
  });
});

describe('auth-guard detector', () => {
  it('finds a server-side auth wrapper', () => {
    const signals = run({
      'app/api/member/me/route.ts': 'export const GET = withUserAuth(handler);',
    });
    expect(signals).toEqual([
      { file: 'app/api/member/me/route.ts', start_line: 1, detector: AUTH_GUARD_DETECTOR },
    ]);
  });

  it('treats a root middleware file as a guard on its own', () => {
    const signals = run({
      'middleware.ts': 'export const config = { matcher: ["/((?!_next).*)"] };',
    });
    expect(signals).toEqual([
      { file: 'middleware.ts', start_line: 1, detector: AUTH_GUARD_DETECTOR },
    ]);
  });

  it('treats a src-rooted middleware file the same way', () => {
    expect(run({ 'src/middleware.ts': 'export function middleware() {}' })).toEqual([
      { file: 'src/middleware.ts', start_line: 1, detector: AUTH_GUARD_DETECTOR },
    ]);
  });

  it('does not treat a nested file named middleware as a root guard', () => {
    expect(run({ 'lib/auth/middleware.ts': 'export const x = 1;' })).toEqual([]);
  });

  it('ignores an unrelated file', () => {
    expect(run({ 'components/Button.tsx': 'export const Button = () => null;' })).toEqual([]);
  });
});

describe('detectPrioritySignals', () => {
  it('skips files with no content available', () => {
    expect(detectPrioritySignals({ files: ['gone.ts'], contents: new Map() })).toEqual([]);
  });

  it('returns signals in file order so output is stable across runs', () => {
    const signals = run({
      'b.ts': 'const x = { amount: { type: Number } };',
      'a.ts': "import Stripe from 'stripe';",
    });
    expect(signals.map((s) => s.file)).toEqual(['b.ts', 'a.ts']);
  });

  it('emits one signal per line even when two patterns could match', () => {
    const signals = run({
      'lib/pay.ts': "import Stripe from 'stripe'; const p = { amount: { type: Number } };",
    });
    expect(signals).toHaveLength(1);
  });
});
