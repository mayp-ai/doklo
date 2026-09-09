import { beforeEach, describe, expect, it, vi } from 'vitest';

const { loadDokMock, loadLexiconMock, resolveTermTextMock } = vi.hoisted(() => ({
  loadDokMock: vi.fn(),
  loadLexiconMock: vi.fn(),
  resolveTermTextMock: vi.fn(),
}));

vi.mock('../lib/data', () => ({
  loadDok: loadDokMock,
  loadLexicon: loadLexiconMock,
  resolveTermText: resolveTermTextMock,
}));

import { summarizePersistedDok } from '../lib/onboarding-generation';

describe('summarizePersistedDok', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    loadLexiconMock.mockResolvedValue({ terms: [{ term_id: 'TERM-SIGN-IN' }] });
    resolveTermTextMock.mockReturnValue('Sign in');
  });

  it('uses the persisted Hub Dok, TermRef text, and source anchors', async () => {
    loadDokMock.mockResolvedValue({
      dok_id: 'AUTH-SIGNIN',
      name: { term_ref: 'TERM-SIGN-IN' },
      status: 'draft',
      _meta: { source_anchors: [{ file: 'app/login/page.tsx' }] },
    });

    await expect(summarizePersistedDok('AUTH-SIGNIN')).resolves.toEqual({
      dok_id: 'AUTH-SIGNIN',
      name: 'Sign in',
      status: 'draft',
      anchorFiles: ['app/login/page.tsx'],
    });
    expect(loadDokMock).toHaveBeenCalledWith('AUTH-SIGNIN');
  });
});
