import { describe, it, expect } from 'vitest';
import {
  abbrev,
  suggestDokIdPrefix,
  suggestUniqueDokIdPrefix,
  ensureUniquePrefix,
  DokIdPrefixCollisionError,
} from '../src/dok-id-prefix.js';
import { DOK_ID_RE } from '@doklo-beta/core';

describe('abbrev', () => {
  it('truncates to length 4 by default', () => {
    expect(abbrev('program')).toBe('PROG');
  });
  it('uppercases short words as-is', () => {
    expect(abbrev('auth')).toBe('AUTH');
    expect(abbrev('ai')).toBe('AI');
  });
  it('consonants-only keeps the first letter', () => {
    expect(abbrev('mentor', { consonantsOnly: true })).toBe('MNTR');
  });
});

describe('suggestDokIdPrefix', () => {
  it('returns the group prefix when the feature equals the group', () => {
    expect(suggestDokIdPrefix('auth', 'auth')).toBe('AUTH');
  });
  it('strips "detail" — duplicate-of-group token — and keeps the full group word', () => {
    expect(suggestDokIdPrefix('program-detail', 'program')).toBe('PROGRAM');
  });
  it('combines the full group word with the full sub-token (no 4-char abbreviation)', () => {
    expect(suggestDokIdPrefix('program-milestone', 'program')).toBe('PROGRAM-MILESTONE');
  });
  it('produces a 3-segment id from group + up to 2 remaining feature tokens', () => {
    expect(suggestDokIdPrefix('admin-mentor-list', 'admin')).toBe('ADMIN-MENTOR-LIST');
  });
  it('truncates a segment longer than 10 chars instead of failing', () => {
    expect(suggestDokIdPrefix('reconciliation', 'reconciliation')).toBe('RECONCILIA');
  });
});

describe('ensureUniquePrefix', () => {
  it('honors a valid LLM-suggested prefix', () => {
    const prefix = ensureUniquePrefix('AUTH', 'auth-signin', 'auth', new Set());
    expect(prefix).toBe('AUTH');
  });

  it('normalizes and accepts a lowercase LLM prefix', () => {
    const prefix = ensureUniquePrefix('auth', 'auth', 'auth', new Set());
    expect(prefix).toBe('AUTH');
  });

  it('falls back to auto-generation when no LLM prefix is given', () => {
    const prefix = ensureUniquePrefix(undefined, 'admin-mentor', 'admin', new Set());
    expect(prefix).toBe('ADMIN-MENTOR');
  });

  it('falls back to auto-generation when the LLM prefix fails the shared Dok ID grammar', () => {
    // Reserved first segment (BR is reserved for business-rule ids) — invalid
    // regardless of casing, so this must fall through to suggestDokIdPrefix.
    const prefix = ensureUniquePrefix('BR', 'auth-signin', 'auth', new Set());
    expect(prefix).toBe('AUTH-SIGNIN');
  });

  it('throws a DokIdPrefixCollisionError when both the LLM prefix and the auto-suggestion are taken', () => {
    const used = new Set(['PROGRAM']);
    expect(() => ensureUniquePrefix('PROGRAM', 'program', 'program', used))
      .toThrow(DokIdPrefixCollisionError);
  });

  it('throws when auto-generation collides and no LLM prefix was given', () => {
    const used = new Set(['AUTH-SIGNIN']);
    expect(() => ensureUniquePrefix(undefined, 'auth-signin', 'auth', used))
      .toThrow(DokIdPrefixCollisionError);
  });

  it('includes the candidate and canonical id on the collision error', () => {
    // Block both the LLM prefix and the auto-suggestion so neither path succeeds.
    const used = new Set(['AUTH', 'AUTH-SIGNUP']);
    try {
      ensureUniquePrefix('AUTH', 'auth-signup', 'auth', used);
      expect.unreachable('expected ensureUniquePrefix to throw');
    } catch (error) {
      expect(error).toBeInstanceOf(DokIdPrefixCollisionError);
      expect((error as DokIdPrefixCollisionError).candidate).toBe('AUTH');
      expect((error as DokIdPrefixCollisionError).canonicalId).toBe('auth-signup');
    }
  });
});

describe('suggestUniqueDokIdPrefix', () => {
  it('delegates to ensureUniquePrefix', () => {
    expect(suggestUniqueDokIdPrefix('admin-mentor', 'admin', new Set())).toBe('ADMIN-MENTOR');
  });
});

describe('DOK_ID_RE matches the shared v5 Dok ID grammar', () => {
  it('accepts DOMAIN', () => {
    expect(DOK_ID_RE.test('AUTH')).toBe(true);
  });
  it('accepts DOMAIN-SUB', () => {
    expect(DOK_ID_RE.test('PROG-MILE')).toBe(true);
  });
  it('accepts three segments', () => {
    expect(DOK_ID_RE.test('AB-CD-EF')).toBe(true);
  });
  it('accepts digits after the first letter of a segment', () => {
    expect(DOK_ID_RE.test('AUTH2')).toBe(true);
    expect(DOK_ID_RE.test('OAUTH2-CALLBACK')).toBe(true);
  });
  it('rejects lowercase', () => {
    expect(DOK_ID_RE.test('auth')).toBe(false);
  });
  it('rejects single-char segments', () => {
    expect(DOK_ID_RE.test('A')).toBe(false);
    expect(DOK_ID_RE.test('A-BC')).toBe(false);
  });
  it('rejects a segment starting with a digit', () => {
    expect(DOK_ID_RE.test('2FA')).toBe(false);
  });
  it('rejects four or more segments', () => {
    expect(DOK_ID_RE.test('AB-CD-EF-GH')).toBe(false);
  });
});
