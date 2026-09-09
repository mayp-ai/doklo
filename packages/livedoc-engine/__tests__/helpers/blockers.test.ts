import { describe, expect, it } from 'vitest';
import { createEngine } from '../../src/handlebars-setup.js';

function renderHasBlockers(dok: unknown): string {
  return createEngine().compile('{{has_blockers dok}}')({ dok });
}

describe('has_blockers helper', () => {
  it('treats a reviewed step precondition as a blocker without business rules', () => {
    expect(renderHasBlockers({
      user_actions: {
        steps: [{
          order: 1,
          actor: { kind: 'role', role_ref: 'ROLE-CUSTOMER' },
          intent: '결제 정보를 입력한다',
          outcome: '입력값이 실시간으로 검증된다',
          variants: [],
          preconditions: ['결제 수단이 선택되어 있어야 한다'],
        }],
      },
      business_rules: { rules: [] },
    })).toBe('true');
  });

  it('returns false only when neither rules nor step preconditions exist', () => {
    expect(renderHasBlockers({
      user_actions: { steps: [] },
      business_rules: { rules: [] },
    })).toBe('false');
  });
});
