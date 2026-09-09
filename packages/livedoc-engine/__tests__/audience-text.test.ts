import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { audienceText, type AudienceDictionary } from '../src/helpers/audience-text.js';
import { loadWorkspaceAudienceDictionary } from '../src/audience-dictionary.js';
import * as engine from '../src/index.js';

// Representative PROJECT dictionary — mirrors a real-world project's `.doklo/audience-text.json`.
// The engine ships no terms of its own; this fixture exercises the generic mechanism.
const DICT: AudienceDictionary = [
  ['editingBanner 상태는 반드시 null로 초기화되어', '선택한 배너 정보는 반드시 비워져'],
  ['editingBanner 상태가 null로 초기화되어', '선택한 배너 정보가 비워져'],
  ['editingBanner 상태가 초기화되며', '선택한 배너 정보가 비워지며'],
  ['editingBanner가 null인 경우', '선택한 배너가 없는 경우'],
  ['editingBanner가 null이면', '선택한 배너가 없으면'],
  ['배너 객체(editingBanner)', '배너'],
  ['editingBanner 상태', '선택한 배너 정보'],
  ['editingBanner', '선택한 배너'],
  ['수정 모달 컴포넌트는 DOM에 마운트되지 않는다', '수정 모달은 화면에 열리지 않는다'],
  ['DOM에 마운트되지 않는다', '화면에 열리지 않는다'],
  ['DOM에 마운트', '화면에 표시'],
  ['렌더링되지 않아야 한다', '화면에 표시되지 않아야 한다'],
  ['렌더링되지 않는다', '화면에 표시되지 않는다'],
  ['렌더링된다', '화면에 표시된다'],
  ['ROLE-ADMIN', '관리자'],
  ['ROLE-CUSTOMER', '고객'],
  ['ROLE-USER', '일반 사용자'],
  ['Administrator', '관리자'],
];

describe('audienceText helper', () => {
  it('returns input verbatim when the dictionary is empty (generic engine default)', () => {
    const s = 'editingBanner가 null이면 수정 모달이 열리지 않는다';
    expect(audienceText(s, [])).toBe(s);
  });

  it('substitutes editingBanner phrases with operator language (longest-match first)', () => {
    expect(audienceText('editingBanner가 null이면 수정 모달이 열리지 않는다', DICT)).toBe(
      '선택한 배너가 없으면 수정 모달이 열리지 않는다',
    );
    expect(audienceText('수정 모달이 닫히고 editingBanner 상태가 초기화되며 토스트가 표시된다', DICT)).toBe(
      '수정 모달이 닫히고 선택한 배너 정보가 비워지며 토스트가 표시된다',
    );
    // bare token fallback only fires when no phrase matched
    expect(audienceText('editingBanner를 확인', DICT)).toBe('선택한 배너를 확인');
  });

  it('translates DOM/mount/render jargon to screen-observable wording', () => {
    expect(audienceText('수정 모달 컴포넌트는 DOM에 마운트되지 않는다', DICT)).toBe('수정 모달은 화면에 열리지 않는다');
    expect(audienceText('회원가입 폼은 렌더링되지 않는다', DICT)).toBe('회원가입 폼은 화면에 표시되지 않는다');
  });

  it('maps role enums to operator labels', () => {
    expect(audienceText('ROLE-ADMIN 권한을 가진 사용자만 접근', DICT)).toBe('관리자 권한을 가진 사용자만 접근');
    expect(audienceText('Administrator', DICT)).toBe('관리자');
  });

  it('repairs Korean particles after an identifier becomes an audience label', () => {
    expect(audienceText('ROLE-ADMIN이 아닌 사용자는 접근할 수 없다', DICT)).toBe(
      '관리자가 아닌 사용자는 접근할 수 없다',
    );
  });

  it('removes repetition introduced at a replacement boundary', () => {
    expect(audienceText('화면에 렌더링되지 않아야 한다', DICT)).toBe(
      '화면에 표시되지 않아야 한다',
    );
    expect(audienceText('관리자(ROLE-ADMIN)만 접근할 수 있다', DICT)).toBe(
      '관리자만 접근할 수 있다',
    );
  });

  it('leaves unknown camelCase / ALL_CAPS tokens untouched (no auto-rewrite)', () => {
    // unknown identifiers must survive — "don't hide unknown code"
    expect(audienceText('usePrompts 훅과 SkeletonGrid는 그대로', DICT)).toBe('usePrompts 훅과 SkeletonGrid는 그대로');
    expect(audienceText('ROLE-SUPERVISOR 미등록', DICT)).toBe('ROLE-SUPERVISOR 미등록');
  });

  it('is idempotent and handles empty input', () => {
    const once = audienceText('editingBanner 상태', DICT);
    expect(audienceText(once, DICT)).toBe(once);
    expect(audienceText('', DICT)).toBe('');
  });

  it('no replacement re-introduces a later pattern (guard against substitution loops)', () => {
    for (const [, replacement] of DICT) {
      expect(replacement).not.toMatch(/editingBanner|ROLE-ADMIN|Administrator|DOM에 마운트/);
    }
  });
});

describe('workspace audience dictionary loader', () => {
  const load = (engine as unknown as {
    loadWorkspaceAudienceDictionary?: (
      workspaceRoot: string,
      locale: string,
      primaryLocale?: string,
    ) => Promise<{
      dictionary?: AudienceDictionary;
      malformed?: boolean;
    }>;
  }).loadWorkspaceAudienceDictionary;

  it('prefers the requested locale and then falls back to the primary locale', async () => {
    expect(typeof load).toBe('function');
    if (!load) return;
    const root = await mkdtemp(join(tmpdir(), 'audience-dictionary-'));
    try {
      await mkdir(join(root, '.doklo'), { recursive: true });
      const dictionaryPath = join(root, '.doklo', 'audience-text.json');
      await writeFile(dictionaryPath, JSON.stringify({
        en: { editingBanner: 'selected banner' },
        ko: { editingBanner: '선택한 배너' },
      }));
      await expect(load(root, 'en', 'ko')).resolves.toMatchObject({
        dictionary: [['editingBanner', 'selected banner']],
      });

      await writeFile(dictionaryPath, JSON.stringify({
        ko: { editingBanner: '선택한 배너' },
      }));
      await expect(load(root, 'en', 'ko')).resolves.toMatchObject({
        dictionary: [['editingBanner', '선택한 배너']],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

/**
 * `.doklo/audience-text.json` is the last workspace-root read in the engine that
 * used to open a path built by hand. It matters more than a plain file read:
 * whatever it parses becomes substitution rules applied to generated document
 * text, so a foreign file is both an out-of-root read and a content-injection
 * primitive.
 *
 * These three probe it as an oracle — the observable result tells you whether
 * the foreign file was opened at all.
 */
describe('workspace audience dictionary containment', () => {
  const OUTSIDE_MARKER = 'INJECTED-FROM-OUTSIDE';

  async function sandbox(): Promise<{ root: string; outside: string; cleanup: () => Promise<void> }> {
    const base = await realpath(await mkdtemp(join(tmpdir(), 'audience-containment-')));
    const root = join(base, 'workspace');
    const outside = join(base, 'outside');
    await mkdir(join(root, '.doklo'), { recursive: true });
    await mkdir(outside, { recursive: true });
    return { root, outside, cleanup: () => rm(base, { recursive: true, force: true }) };
  }

  it('does not report a symlinked dictionary as malformed, because it never parses it', async () => {
    // "malformed" is only reachable by parsing, so seeing it proves the engine
    // opened the foreign file.
    const { root, outside, cleanup } = await sandbox();
    try {
      const foreign = join(outside, 'not-json.txt');
      await writeFile(foreign, 'this is not json at all');
      await symlink(foreign, join(root, '.doklo', 'audience-text.json'));

      const result = await loadWorkspaceAudienceDictionary(root, 'en', 'ko');
      expect(result.malformed).toBeUndefined();
      expect(result.dictionary).toBeUndefined();
      expect(result.rejected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('does not adopt substitution rules from a symlinked dictionary', async () => {
    const { root, outside, cleanup } = await sandbox();
    try {
      const foreign = join(outside, 'rules.json');
      await writeFile(foreign, JSON.stringify({ en: { 'Email login': OUTSIDE_MARKER } }));
      await symlink(foreign, join(root, '.doklo', 'audience-text.json'));

      const result = await loadWorkspaceAudienceDictionary(root, 'en', 'ko');
      expect(JSON.stringify(result)).not.toContain(OUTSIDE_MARKER);
      expect(result.dictionary).toBeUndefined();
      expect(result.rejected).toBe(true);
    } finally {
      await cleanup();
    }
  });

  it('refuses a non-regular dictionary leaf rather than opening it', async () => {
    // A directory stands in for the FIFO case: readFile on a FIFO blocks until
    // a writer appears, which would hang the render rather than fail it.
    const { root, cleanup } = await sandbox();
    try {
      await mkdir(join(root, '.doklo', 'audience-text.json'), { recursive: true });
      const result = await loadWorkspaceAudienceDictionary(root, 'en', 'ko');
      expect(result.rejected).toBe(true);
      expect(result.dictionary).toBeUndefined();
    } finally {
      await cleanup();
    }
  });

  it('still loads a real contained dictionary and still ignores an absent one', async () => {
    const { root, cleanup } = await sandbox();
    try {
      await expect(loadWorkspaceAudienceDictionary(root, 'en', 'ko')).resolves.toEqual({});

      await writeFile(
        join(root, '.doklo', 'audience-text.json'),
        JSON.stringify({ en: { editingBanner: 'selected banner' } }),
      );
      await expect(loadWorkspaceAudienceDictionary(root, 'en', 'ko')).resolves.toEqual({
        dictionary: [['editingBanner', 'selected banner']],
      });
    } finally {
      await cleanup();
    }
  });

  it('still reports a genuinely malformed contained dictionary as malformed', async () => {
    const { root, cleanup } = await sandbox();
    try {
      await writeFile(join(root, '.doklo', 'audience-text.json'), 'not json');
      await expect(loadWorkspaceAudienceDictionary(root, 'en', 'ko')).resolves.toEqual({
        malformed: true,
      });
    } finally {
      await cleanup();
    }
  });
});
