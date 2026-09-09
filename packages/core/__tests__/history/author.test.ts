import { describe, expect, it } from 'vitest';
import { resolveHistoryAuthor } from '../../src/index.js';

describe('resolveHistoryAuthor', () => {
  it('prefers DOKLO_AUTHOR, then git user.name, then undefined; never throws', async () => {
    expect(await resolveHistoryAuthor({ env: { DOKLO_AUTHOR: '  pumpa ' } })).toBe('pumpa');
    expect(await resolveHistoryAuthor({ env: {}, git: async () => 'Git Name\n' })).toBe('Git Name');
    expect(await resolveHistoryAuthor({ env: {}, git: async () => '' })).toBeUndefined();
    expect(await resolveHistoryAuthor({ env: {}, git: async () => { throw new Error('no git'); } })).toBeUndefined();
    expect(await resolveHistoryAuthor({ env: {} })).toBeUndefined();
  });
});
