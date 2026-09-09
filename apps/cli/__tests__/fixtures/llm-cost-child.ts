import {
  registerLlmRun,
  reserveRegisteredLlmCall,
} from '../../src/lib/llm-cost-cap.js';

const [root, mode, amountText, index] = process.argv.slice(2);
if (!root || !mode || !amountText || !index) throw new Error('missing fixture arguments');

const run = await registerLlmRun(root, {
  receiptId: `child-receipt-${index}`,
  planDigest: `child-plan-${index}`,
  maxCalls: 1,
});
await reserveRegisteredLlmCall(run, {
  callKey: `child/call-${index}`,
  reservedTokens: Number(amountText),
});

if (mode === 'crash') process.exit(17);
