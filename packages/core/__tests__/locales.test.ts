import { describe, expect, it } from 'vitest';
import {
  DOK_LOCALES,
  canonicalDokLocale,
  dokLanguageName,
  findDokLocale,
  isKnownDokLocale,
  hasForeignScript,
  normalizeLocaleTag,
  proseScript,
} from '../src/schemas/locales.js';

describe('Dok locales', () => {
  it('lists en and ko first, with unique codes', () => {
    expect(DOK_LOCALES[0]!.code).toBe('en');
    expect(DOK_LOCALES[1]!.code).toBe('ko');
    expect(new Set(DOK_LOCALES.map((entry) => entry.code)).size).toBe(DOK_LOCALES.length);
  });

  it('normalises loosely written tags', () => {
    expect(normalizeLocaleTag('ko_KR')).toBe('ko-KR');
    expect(normalizeLocaleTag('EN')).toBe('en');
    expect(normalizeLocaleTag('zh-hans')).toBe('zh-Hans');
    expect(normalizeLocaleTag(' fr ')).toBe('fr');
    expect(normalizeLocaleTag('english')).toBeNull();
    expect(normalizeLocaleTag('')).toBeNull();
    expect(normalizeLocaleTag(42)).toBeNull();
  });

  it('maps regions onto the list: ko-KR is Korean, zh-TW is Traditional Chinese', () => {
    expect(findDokLocale('ko-KR')?.code).toBe('ko');
    expect(findDokLocale('zh-TW')?.code).toBe('zh-Hant');
    expect(findDokLocale('zh-CN')?.code).toBe('zh-Hans');
    // The script subtag outranks the region (review 2026-10-27).
    expect(findDokLocale('zh-Hant-TW')?.code).toBe('zh-Hant');
    expect(findDokLocale('zh-Hant-HK')?.code).toBe('zh-Hant');
    expect(findDokLocale('zh-Hans-HK')?.code).toBe('zh-Hans');
    expect(findDokLocale('pt-BR')?.code).toBe('pt');
    expect(findDokLocale('nl')).toBeUndefined();
    expect(isKnownDokLocale('ja')).toBe(true);
    expect(isKnownDokLocale(undefined)).toBe(false);
  });

  it('names the language for the prompt, and still instructs for an unlisted tag', () => {
    expect(dokLanguageName('ko')).toBe('Korean (한국어)');
    expect(dokLanguageName('ja')).toBe('Japanese (日本語)');
    expect(dokLanguageName('nl')).toBe('the language with BCP 47 tag `nl`');
    expect(dokLanguageName(undefined)).toBe('English');
  });

  it('canonicalises for storage: listed tags collapse, unlisted stay as written', () => {
    expect(canonicalDokLocale('ko_KR')).toBe('ko');
    expect(canonicalDokLocale('zh-tw')).toBe('zh-Hant');
    expect(canonicalDokLocale('nl')).toBe('nl');
    expect(canonicalDokLocale('???')).toBe('en');
  });
});

describe('proseScript', () => {
  const ten = (sentence: string) => Array.from({ length: 10 }, () => sentence);

  it('names the script the prose is written in', () => {
    expect(proseScript(ten('초대 링크를 열면 가입 화면이 나타납니다.'))).toBe('Hang');
    expect(proseScript(ten('受邀人打开注册页面后填写姓名和密码。'))).toBe('Hani');
    expect(proseScript(ten('招待リンクを開くと登録画面が表示されます。'))).toBe('Jpan');
    expect(proseScript(ten("L'invitation expire après 24 heures et le lien n'est plus valide."))).toBe('Latn');
  });

  it('does not count quoted or parenthesised on-screen wording, or code', () => {
    // A Korean product documented in French or English quotes its own messages.
    expect(proseScript(ten("Le message « 일정이 추가되었습니다. » s'affiche sous le formulaire."))).toBe('Latn');
    expect(proseScript(ten('A confirmation appears ("일정이 추가되었습니다.") and the form closes.'))).toBe('Latn');
    expect(proseScript(ten('系统提示“일정이 추가되었습니다.”（日程已添加）并清空表单。'))).toBe('Hani');
    expect(proseScript(ten('응답은 `id`, `name`, `email` 필드를 돌려줍니다.'))).toBe('Hang');
  });

  it('says nothing about a handful of words', () => {
    expect(proseScript(['Chat', 'Ask a question.'])).toBeNull();
    expect(proseScript([])).toBeNull();
  });

  it('knows the script of every listed language, and its instruction is written in it', () => {
    for (const entry of DOK_LOCALES) expect(proseScript([entry.instruction]), entry.code).toBe(entry.script);
  });
});

describe('hasForeignScript', () => {
  it('finds one stray letter in a short title', () => {
    expect(hasForeignScript('멘토링 프로그램 일정 관리', 'Hani')).toBe(true);
    expect(hasForeignScript('방案行程管理', 'Hani')).toBe(true);
    expect(hasForeignScript('課程排程管理', 'Hani')).toBe(false);
    expect(hasForeignScript('メンター招待・会員管理', 'Hani')).toBe(true);
    expect(hasForeignScript('会員管理', 'Jpan')).toBe(false);
    expect(hasForeignScript('회원 관리', 'Jpan')).toBe(true);
    expect(hasForeignScript('會員管理', 'Hang')).toBe(true);
    expect(hasForeignScript('API 키 관리', 'Hang')).toBe(false);
  });

  it('lets a Latin title carry a name in another script, but not be written in one', () => {
    expect(hasForeignScript('Gestion des invitations de 배시시', 'Latn')).toBe(false);
    expect(hasForeignScript('프로그램 일정 관리', 'Latn')).toBe(true);
    expect(hasForeignScript('Gestion du planning (일정)', 'Latn')).toBe(false);
  });
});
