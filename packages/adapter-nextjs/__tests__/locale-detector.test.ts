import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { detectProjectLocale, tallyScripts } from '../src/locale-detector.js';

async function tmpProject(files: Record<string, string | object>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-locale-'));
  for (const [path, content] of Object.entries(files)) {
    const abs = join(root, path);
    await mkdir(dirname(abs), { recursive: true });
    const text = typeof content === 'string' ? content : JSON.stringify(content);
    await writeFile(abs, text, 'utf-8');
  }
  return root;
}

const KOREAN_PAGE = `export default function Page() {
  return (
    <main>
      <h1>회원 가입을 진행합니다</h1>
      <p>이메일 주소와 비밀번호를 입력한 뒤 다음 단계로 넘어갑니다. 약관에 동의해야 계정이 만들어집니다.</p>
      <p>이미 계정이 있으면 로그인 화면으로 이동할 수 있습니다. 비밀번호를 잊었다면 재설정 메일을 보냅니다.</p>
      <button>다음</button>
    </main>
  );
}`;

const ENGLISH_PAGE = `export default function Page() {
  return (
    <main>
      <h1>Create your account</h1>
      <p>Enter an email address and a password, then continue to the next step. You must accept the terms.</p>
      <button>Next</button>
    </main>
  );
}`;

describe('detectProjectLocale', () => {
  it('says nothing about a project with no signal', async () => {
    const root = await tmpProject({ 'package.json': '{}', 'app/page.tsx': ENGLISH_PAGE });
    expect(detectProjectLocale({ rootDir: root })).toEqual({
      locale: null,
      supported: [],
      source: null,
      evidence: null,
    });
  });

  it('reads next-intl routing: defaultLocale decides, locales become supported', async () => {
    const root = await tmpProject({
      'i18n/routing.ts': `import { defineRouting } from 'next-intl/routing';
export const routing = defineRouting({ locales: ['en', 'ko', 'ja'], defaultLocale: 'ko' });`,
      'app/[locale]/page.tsx': ENGLISH_PAGE,
    });
    expect(detectProjectLocale({ rootDir: root })).toEqual({
      locale: 'ko',
      supported: ['en', 'ko', 'ja'],
      source: 'i18n-config',
      evidence: 'i18n/routing.ts',
    });
  });

  it('reads the Pages Router i18n block in next.config.js and normalises the tag', async () => {
    const root = await tmpProject({
      'next.config.js': `module.exports = { i18n: { locales: ['en-US', 'zh-TW'], defaultLocale: 'zh-TW' } };`,
    });
    const detected = detectProjectLocale({ rootDir: root });
    expect(detected.locale).toBe('zh-Hant');
    expect(detected.source).toBe('i18n-config');
    expect(detected.supported).toEqual(['en', 'zh-Hant']);
  });

  it('lets Korean source copy outrank the template <html lang="en">', async () => {
    const root = await tmpProject({
      'app/layout.tsx': `export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }`,
      'app/page.tsx': KOREAN_PAGE,
      'app/signup/page.tsx': KOREAN_PAGE,
    });
    const detected = detectProjectLocale({ rootDir: root, files: ['app/layout.tsx', 'app/page.tsx', 'app/signup/page.tsx'] });
    expect(detected.locale).toBe('ko');
    expect(detected.source).toBe('content');
    expect(detected.evidence).toMatch(/page\.tsx$/);
    expect(detected.supported).toEqual(['ko']);
  });

  it('walks the root itself when no file list is given', async () => {
    const root = await tmpProject({
      'app/page.tsx': KOREAN_PAGE,
      'node_modules/pkg/index.js': 'const x = "これは日本語のテキストです。これは日本語のテキストです。これは日本語のテキストです。これは日本語のテキストです。";',
    });
    expect(detectProjectLocale({ rootDir: root }).locale).toBe('ko');
  });

  it('ignores a stray non-Latin comment', async () => {
    const root = await tmpProject({
      'app/page.tsx': `// 임시 주석\n${ENGLISH_PAGE}`,
    });
    expect(detectProjectLocale({ rootDir: root }).locale).toBeNull();
  });

  it('falls back to <html lang> when the content is Latin', async () => {
    const root = await tmpProject({
      'src/app/layout.tsx': `export default function Layout({ children }) { return <html lang="fr"><body>{children}</body></html>; }`,
      'src/app/page.tsx': ENGLISH_PAGE,
    });
    expect(detectProjectLocale({ rootDir: root })).toEqual({
      locale: 'fr',
      supported: ['fr'],
      source: 'html-lang',
      evidence: 'src/app/layout.tsx',
    });
  });

  it('ignores a dynamic lang attribute', async () => {
    const root = await tmpProject({
      'app/layout.tsx': `export default function Layout({ children, params }) { return <html lang={params.locale}><body>{children}</body></html>; }`,
    });
    expect(detectProjectLocale({ rootDir: root }).locale).toBeNull();
  });

  it('takes a single i18n message locale as the language, several as supported only', async () => {
    const one = await tmpProject({ 'messages/ja.json': { hello: 'こんにちは' } });
    expect(detectProjectLocale({ rootDir: one })).toEqual({
      locale: 'ja',
      supported: ['ja'],
      source: 'i18n-files',
      evidence: 'messages/ja.json',
    });

    const many = await tmpProject({ 'messages/en.json': { hello: 'Hello' }, 'messages/de.json': { hello: 'Hallo' } });
    expect(detectProjectLocale({ rootDir: many })).toEqual({
      locale: null,
      supported: ['de', 'en'],
      source: null,
      evidence: null,
    });
  });

  // Independent review 2026-10-27: each of these called an English product Korean,
  // Greek or Russian, or lost the language a project declared.
  describe('what is not the product\'s copy', () => {
    it('does not count comments, however many', async () => {
      const comments = '// 이 함수는 사용자 정보를 불러와서 화면에 보여 줍니다. 오류가 나면 다시 시도합니다.\n'.repeat(6);
      const root = await tmpProject({ 'app/page.tsx': `${comments}${ENGLISH_PAGE}`, 'app/about/page.tsx': `/* 회사 소개 화면입니다. 내용은 마케팅 팀이 관리합니다. 수정 전에 꼭 확인을 받아 주세요. */\n${ENGLISH_PAGE}` });
      expect(detectProjectLocale({ rootDir: root }).locale).toBeNull();
    });

    it('lets visible English copy outweigh a few non-Latin strings', async () => {
      const root = await tmpProject({
        'app/page.tsx': ENGLISH_PAGE,
        'app/stats/page.tsx': `export const LABELS = { delta: 'Δ', sigma: 'σ', theta: 'Θ', gamma: 'Γ', rho: 'ρ', nu: 'ν' };\nexport const SAMPLE = '${'Δ Γ Θ ν ρ σ λ μ π '.repeat(10)}';\n${ENGLISH_PAGE}`,
        'components/language-switch.tsx': `export const LANGUAGES = [{ code: 'ko', label: '한국어' }, { code: 'ja', label: '日本語' }];\n${ENGLISH_PAGE}`,
      });
      expect(detectProjectLocale({ rootDir: root }).locale).toBeNull();
    });

    it('skips dictionaries, tests, fixtures, documents and vendored code', async () => {
      const korean = '회원 가입을 진행합니다. 이메일 주소와 비밀번호를 입력한 뒤 다음 단계로 넘어갑니다. 약관에 동의해야 계정이 만들어집니다.';
      const root = await tmpProject({
        'app/page.tsx': ENGLISH_PAGE,
        'lib/dictionaries/ko.ts': `export default { title: '${korean}', body: '${korean}' };`,
        '__tests__/signup.test.tsx': `it('${korean}', () => {}); it('${korean}', () => {});`,
        'app/signup/signup.spec.ts': `it('${korean}', () => {});`,
        'fixtures/users.ts': `export const USERS = ['${korean}', '${korean}'];`,
        'README.md': `# 프로젝트\n\n${korean}\n${korean}`,
        'docs/reports/2026-10-01-weekly.html': `<html><body><p>${korean}</p><p>${korean}</p></body></html>`,
        'scripts/seed-demo.ts': `export const ROWS = ['${korean}', '${korean}'];`,
        'lib/seed-data.ts': `export const ROWS = ['${korean}', '${korean}'];`,
        'public/vendor/moment-locales.min.js': `var ru = '${'Январь Февраль Март Апрель Май Июнь Июль Август Сентябрь Октябрь Ноябрь Декабрь '.repeat(4)}';`,
      });
      expect(detectProjectLocale({ rootDir: root }).locale).toBeNull();
    });

    it('reads a Korean product styled with class lists as Korean', async () => {
      const classes = 'flex items-center justify-between gap-4 rounded-lg border border-gray-200 bg-white px-6 py-4 text-sm font-medium text-gray-900 shadow-sm hover:bg-gray-50';
      const page = KOREAN_PAGE.replace(/<(h1|p|button)>/g, `<$1 className="${classes}">`).replace('<main>', '<main><nav>Doklo</nav><a href="/login">Sign in</a>');
      const root = await tmpProject({ 'app/page.tsx': page, 'app/signup/page.tsx': page });
      expect(detectProjectLocale({ rootDir: root })).toMatchObject({ locale: 'ko', source: 'content' });
    });
  });

  it('takes a single message locale over the template <html lang="en">', async () => {
    const root = await tmpProject({
      'app/layout.tsx': `export default function Layout({ children }) { return <html lang="en"><body>{children}</body></html>; }`,
      'app/page.tsx': `import { useTranslations } from 'next-intl';\nexport default function Page() { const t = useTranslations(); return <h1>{t('title')}</h1>; }`,
      'messages/ko.json': { title: '회원 가입을 진행합니다' },
    });
    expect(detectProjectLocale({ rootDir: root })).toMatchObject({ locale: 'ko', source: 'i18n-files' });
  });

  it('tells Traditional Chinese copy from Simplified, and settles a tie from the declared locale', async () => {
    const traditional = `export default function Page() { return <main><h1>這個頁面會顯示您的帳戶設定</h1><p>請輸入電話號碼與郵件地址，確認後點選下一頁。註冊完成後我們會寄送確認信。</p><p>如果您還沒有帳戶，請先註冊。登錄後可以在這裡變更語言與通知設定。</p></main>; }`;
    // The copy alone decides, with no declared locale to lean on.
    expect(detectProjectLocale({ rootDir: await tmpProject({ 'app/page.tsx': traditional, 'app/terms/page.tsx': traditional }) }))
      .toMatchObject({ locale: 'zh-Hant', source: 'content' });
    const simplified = traditional.replace(/這/g, '这').replace(/個/g, '个').replace(/會/g, '会').replace(/顯/g, '显').replace(/帳/g, '账').replace(/戶/g, '户').replace(/設/g, '设').replace(/請/g, '请').replace(/輸/g, '输').replace(/電/g, '电').replace(/話/g, '话').replace(/號/g, '号').replace(/碼/g, '码').replace(/郵/g, '邮').replace(/確/g, '确').replace(/認/g, '认').replace(/點/g, '点').replace(/選/g, '选').replace(/頁/g, '页').replace(/註/g, '注').replace(/冊/g, '册').replace(/們/g, '们').replace(/還/g, '还').replace(/錄/g, '录').replace(/變/g, '变').replace(/與/g, '与');
    expect(detectProjectLocale({ rootDir: await tmpProject({ 'app/page.tsx': simplified, 'app/terms/page.tsx': simplified }) }))
      .toMatchObject({ locale: 'zh-Hans', source: 'content' });
    const neutral = `export default function Page() { return <main><h1>${'中文内容品质测试文本示例'.repeat(10)}</h1></main>; }`;
    expect(detectProjectLocale({ rootDir: await tmpProject({ 'app/page.tsx': neutral, 'app/layout.tsx': '<html lang="zh-HK"></html>' }) }).locale).toBe('zh-Hant');
    expect(detectProjectLocale({ rootDir: await tmpProject({ 'app/page.tsx': neutral }) }).locale).toBe('zh-Hans');
  });

  it('does not take a message file name that is no language for one', async () => {
    const root = await tmpProject({ 'messages/app.json': { hello: 'Hello' } });
    expect(detectProjectLocale({ rootDir: root })).toMatchObject({ locale: null, supported: [] });
  });

  it('never throws for a root that does not exist', () => {
    expect(detectProjectLocale({ rootDir: '/nonexistent/doklo-locale-root' }).locale).toBeNull();
  });
});

describe('tallyScripts', () => {
  it('reads kana plus kanji as Japanese, kanji alone as Chinese', () => {
    const ja = tallyScripts('ユーザーは設定画面でパスワードを変更できます。'.repeat(8));
    expect(ja.counts.kana).toBeGreaterThan(0);
    expect(ja.counts.han).toBeGreaterThan(0);
    const zh = tallyScripts('用户可以在设置页面更改密码。'.repeat(10));
    expect(zh.counts.kana).toBeUndefined();
    expect(zh.counts.han).toBeGreaterThan(80);
  });
});
