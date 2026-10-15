// The sync judge's request builder (design §4.3). Fake seams pin the
// contract (cases ported from benchmarks/judge-sync/__tests__/request.test.ts,
// plus line-range anchors, format-only files and the answer language); a real
// git repository in a temp dir pins the diff, the base check and the budget.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  DokSchema,
  computeSourceFileSha256,
  readAnchorContentsSync,
  type Dok,
  type SourceAnchor,
  type TranslateContext,
} from '@doklo-beta/core';
import { joinPromptParts } from '@doklo-beta/generator';
import { isFormatOnlyChange } from '@doklo-beta/adapter-nextjs';
import { isFormatOnlyFileChange } from '../src/lib/drift.js';
import { SYNC_JUDGE_PROMPT_DIGEST, SYNC_JUDGE_SYSTEM, SYNC_JUDGE_USER_TEMPLATE } from '../src/lib/judge/prompt.js';
import {
  buildJudgeRequest,
  gitJudgeSeams,
  hasJudgeFacts,
  renderDokForJudge,
  type JudgeRequestSeams,
} from '../src/lib/judge/request.js';

const BASE = 'a'.repeat(40);

const CTX: TranslateContext = {
  locale: 'en',
  primaryLocale: 'en',
  lexicon: { schema_version: 1, terms: [{ term_id: 'TERM-TOKEN', binding: { type: 'owned' }, locales: { ko: '공유 토큰', en: 'share token' } }] } as unknown as TranslateContext['lexicon'],
};
const CTX_KO: TranslateContext = { ...CTX, locale: 'ko', primaryLocale: 'ko' };

const BODY = {
  dok_id: 'ADMIN-TOKEN',
  name: { term_ref: 'TERM-TOKEN' },
  status: 'active',
  description: 'Admins create share tokens.',
  user_actions: { steps: [{ order: 1, actor: { kind: 'role', role_ref: 'ROLE-ADMIN' }, intent: 'open', outcome: 'list shown', variants: [] }] },
};

function dokWith(meta: Record<string, unknown>): Dok {
  return DokSchema.parse({ ...BODY, _meta: { version: 1, history: [], logic_hash: 'h', tracking_version: 2, ...meta } });
}

function facts(files: Record<string, string>, anchors: Array<string | SourceAnchor>, base = BASE): Record<string, unknown> {
  return {
    source_commit: base,
    logic_files: Object.entries(files).map(([file, content]) => ({ file, sha256: computeSourceFileSha256(content) })),
    source_anchors: anchors.map((anchor) => (typeof anchor === 'string' ? { file: anchor } : anchor)),
  };
}

const readOf = (files: Record<string, string>) => ({
  contents: Object.entries(files).map(([file, content]) => ({ file, content })),
  missing: [] as string[],
});

function fakeSeams(over: Partial<JudgeRequestSeams> & { files?: Record<string, string>; atBase?: Record<string, string> } = {}): JudgeRequestSeams {
  const files = over.files ?? {};
  const atBase = over.atBase ?? {};
  return {
    gitShow: over.gitShow ?? (async (_rev, file) => (file in atBase ? Buffer.from(atBase[file]!, 'utf8') : null)),
    gitDiff: over.gitDiff ?? (async (_rev, file) => `diff --git a/${file} b/${file}\n+changed ${file}\n`),
    readFiles: over.readFiles ?? ((list) => new Map(list.map((f) => [f, files[f] ?? null]))),
    isSensitive: over.isSensitive ?? ((f) => f.startsWith('.env') || f.includes('/secrets/')),
  };
}

const before = { 'app/page.tsx': 'export const D = 7\n', 'lib/a.ts': 'export const a = 1\n' };
const after = { 'app/page.tsx': 'export const D = 14\n', 'lib/a.ts': 'export const a = 1\n' };

describe('the Dok as the judge sees it', () => {
  it('drops _meta, resolves TermRefs like MCP, keeps actors as-is', () => {
    const dok = renderDokForJudge(dokWith({}), CTX_KO);
    expect(dok).not.toHaveProperty('_meta');
    expect(dok['name']).toBe('공유 토큰');
    expect((dok['user_actions'] as { steps: Array<{ actor: unknown }> }).steps[0]!.actor).toEqual({ kind: 'role', role_ref: 'ROLE-ADMIN' });
  });

  it('needs a full source_commit and a sha256 on every logic file', () => {
    expect(hasJudgeFacts(dokWith(facts(before, [])))).toBe(true);
    expect(hasJudgeFacts(dokWith({ ...facts(before, []), source_commit: undefined }))).toBe(false);
    expect(hasJudgeFacts(dokWith({ ...facts(before, []), source_commit: 'HEAD' }))).toBe(false);
    expect(hasJudgeFacts(dokWith({ ...facts(before, []), source_commit: '--output=/tmp/x' }))).toBe(false);
    expect(hasJudgeFacts(dokWith({ ...facts(before, []), logic_files: [{ file: 'app/page.tsx' }] }))).toBe(false);
    expect(hasJudgeFacts(dokWith({ ...facts(before, []), logic_files: [] }))).toBe(false);
  });
});

describe('format-only files', () => {
  it('are judged by the drift entry point’s normaliser, exactly as slice A’s isFormatOnlyChange', () => {
    const cases: Array<[string, string, string]> = [
      ['a.ts', 'export const a = 1\n', '// note\nexport  const a = 1 // one\r\n'],
      ['a.ts', 'export const a = 1\n', 'export const a = 2\n'],
      ['a.ts', 'export const a = 1\n', 'export const a = 1;\n'],
      ['a.tsx', 'const v = <p>\n  hi\n</p>\n', 'const v = <p>\n    hi\n</p>\n'],
      ['a.ts', "const u = 'https://x//y'\n", "const u = 'https://x//z'\n"],
      ['schema.prisma', 'model A {}\n', 'model A {}  \n'],
      ['broken.ts', 'export const = ;\n', 'export const = ; // c\n'],
    ];
    for (const [file, before, after] of cases) {
      expect(isFormatOnlyFileChange(file, before, after), `${file}: ${JSON.stringify(after)}`).toBe(isFormatOnlyChange(file, before, after));
    }
    expect(isFormatOnlyFileChange('a.ts', 'export const a = 1\n', '// note\nexport  const a = 1 // one\r\n')).toBe(true);
    expect(isFormatOnlyFileChange('schema.prisma', 'model A {}\n', 'model A {}  \n')).toBe(false);
  });
});

describe('judge request builder (fake seams)', () => {
  const build = (dok: Dok, seams: JudgeRequestSeams, extra: { budgetChars?: number; locale?: string; read?: ReturnType<typeof readOf> } = {}) =>
    buildJudgeRequest({
      dok,
      read: extra.read ?? readOf(after),
      translate: CTX,
      locale: extra.locale ?? 'en',
      ...(extra.budgetChars !== undefined ? { budgetChars: extra.budgetChars } : {}),
    }, seams);

  it('sends only the changed files, as a verified git diff, then anchors', async () => {
    const req = await build(dokWith(facts(before, ['app/page.tsx', 'lib/a.ts'])), fakeSeams({ atBase: before, files: after }));
    expect(req.status).toBe('ready');
    expect(req.changedFiles).toEqual(['app/page.tsx']);
    expect(req.diffBaseChecks).toEqual([{ file: 'app/page.tsx', check: 'verified' }]);
    expect(req.diffSource).toBe('git');
    expect(req.payload!.changed_files).toEqual([{ path: 'app/page.tsx', shown_as: 'diff' }]);
    expect(req.payload!.diff).toBe('diff --git a/app/page.tsx b/app/page.tsx\n+changed app/page.tsx\n');
    expect(req.anchorsSent).toEqual(['app/page.tsx', 'lib/a.ts']);
    expect(req.payload!.anchors).toEqual([
      { path: 'app/page.tsx', lines: null, content: after['app/page.tsx'] },
      { path: 'lib/a.ts', lines: null, content: after['lib/a.ts'] },
    ]);
    expect(req.sentFiles).toEqual(['app/page.tsx', 'lib/a.ts']);
    expect(req.promptDigest).toBe(SYNC_JUDGE_PROMPT_DIGEST);
    expect(req.systemPrompt).toBe(SYNC_JUDGE_SYSTEM);
    expect(JSON.parse(req.userPrompt)).toEqual(req.payload);
    // Consent digests the generator's canonical joined prompt.
    expect(req.prompt).toBe(joinPromptParts({ systemPrompt: SYNC_JUDGE_SYSTEM, userPrompt: req.userPrompt }));
    expect(req.requestDigest).toBe(createHash('sha256').update(req.prompt).digest('hex'));
    // Per-file characters, for the consent plan's transmissions.
    expect(req.transmissions).toEqual([
      { file: 'app/page.tsx', chars: req.payload!.diff!.length + after['app/page.tsx'].length },
      { file: 'lib/a.ts', chars: after['lib/a.ts'].length },
    ]);
  });

  it('keeps the user template’s key order and names the answer language', async () => {
    const ko = await build(dokWith(facts(before, ['lib/a.ts'])), fakeSeams({ atBase: before, files: after }), { locale: 'ko' });
    expect(Object.keys(ko.payload!)).toEqual([...SYNC_JUDGE_USER_TEMPLATE.matchAll(/"([a-z_]+)":/g)]
      .map((m) => m[1]).filter((key) => !['path', 'shown_as', 'content', 'lines'].includes(key!)));
    expect(ko.payload!.answer_language).toBe('Korean');
    const en = await build(dokWith(facts(before, ['lib/a.ts'])), fakeSeams({ atBase: before, files: after }));
    expect(en.payload!.answer_language).toBe('English');
  });

  it('falls back to the whole current content when the diff base does not match the stored hash', async () => {
    const req = await build(
      dokWith(facts(before, ['lib/a.ts'])),
      fakeSeams({ atBase: { 'app/page.tsx': 'export const D = 3 // dirty at generation\n' }, files: after }),
    );
    expect(req.diffBaseChecks).toEqual([{ file: 'app/page.tsx', check: 'hash-mismatch' }]);
    expect(req.payload!.diff).toBeNull();
    expect(req.payload!.full_files).toEqual([{ path: 'app/page.tsx', content: after['app/page.tsx'] }]);
    expect(req.payload!.changed_files).toEqual([{ path: 'app/page.tsx', shown_as: 'full' }]);
    expect(req.diffSource).toBe('full_content');
  });

  it('a missing base blob also falls back; a changed full file is not repeated as an anchor', async () => {
    const req = await build(dokWith(facts(before, ['app/page.tsx', 'lib/a.ts'])), fakeSeams({ atBase: {}, files: after }));
    expect(req.diffBaseChecks[0]!.check).toBe('missing-at-base');
    expect(req.anchorsSent).toEqual(['lib/a.ts']);
    expect(req.anchorNotes).toContainEqual({ file: 'app/page.tsx', note: 'already-full' });
  });

  it('a git diff that fails falls back to the whole current file', async () => {
    const req = await build(dokWith(facts(before, [])), fakeSeams({ atBase: before, files: after, gitDiff: async () => null }));
    expect(req.diffBaseChecks).toEqual([{ file: 'app/page.tsx', check: 'verified' }]);
    expect(req.payload!.changed_files).toEqual([{ path: 'app/page.tsx', shown_as: 'full' }]);
  });

  it('leaves a file that changed in form only out of the diff, and skips when nothing else changed', async () => {
    const b = { 'app/page.tsx': 'export const D = 7\n', 'lib/a.ts': 'export const a = 1\n' };
    const a = { 'app/page.tsx': 'export const D = 14\n', 'lib/a.ts': '// the a flag\nexport  const a = 1 // one\n' };
    const req = await build(dokWith(facts(b, [])), fakeSeams({ atBase: b, files: a }), { read: readOf(a) });
    expect(req.formatOnlyFiles).toEqual(['lib/a.ts']);
    expect(req.changedFiles).toEqual(['app/page.tsx']);
    expect(req.payload!.changed_files.map((f) => f.path)).toEqual(['app/page.tsx']);
    expect(req.payload!.diff).not.toContain('lib/a.ts');

    const onlyForm = { ...b, 'lib/a.ts': a['lib/a.ts'] };
    const skip = await build(dokWith(facts(b, [])), fakeSeams({ atBase: b, files: onlyForm }), { read: readOf(onlyForm) });
    expect(skip).toMatchObject({ status: 'skip', skipReason: 'no_diff', formatOnlyFiles: ['lib/a.ts'], userPrompt: '' });
  });

  it('fills the budget in the order Dok → diff → anchors and stops at the first anchor that does not fit', async () => {
    const big = 'x'.repeat(600);
    const small = 'y'.repeat(10);
    const files = { ...after, 'a1.ts': big, 'a2.ts': big, 'a3.ts': small };
    const dok = dokWith(facts(before, ['a1.ts', 'a2.ts', 'a3.ts']));
    const probe = await build(dok, fakeSeams({ atBase: before, files }));
    const fixed = probe.sections.dokChars + probe.sections.diffChars;
    // Room for exactly one big anchor: a2 does not fit, so a3 is left out too even though it would fit.
    const req = await build(dok, fakeSeams({ atBase: before, files }), { budgetChars: fixed + 600 + 5 });
    expect(req.anchorsSent).toEqual(['a1.ts']);
    expect(req.omittedAnchors).toEqual(['a2.ts', 'a3.ts']);
    expect(req.payload!.omitted_anchors).toEqual(['a2.ts', 'a3.ts']);
    expect(req.sections.totalChars).toBeLessThanOrEqual(req.sections.budgetChars);
    expect(req.sentFiles).not.toContain('a2.ts');
  });

  it('Dok + diff over the budget → no call (over_budget)', async () => {
    const req = await build(dokWith(facts(before, ['lib/a.ts'])), fakeSeams({ atBase: before, files: after }), { budgetChars: 50 });
    expect(req).toMatchObject({ status: 'skip', skipReason: 'over_budget', userPrompt: '', prompt: '' });
  });

  it('refuses to send sensitive files (changed or anchor) and names them', async () => {
    const b = { ...before, '.env.local': 'A=1\n', 'config/secrets/keys.ts': 'export const k = 1\n' };
    const a = { ...after, '.env.local': 'A=2\n', 'config/secrets/keys.ts': 'export const k = 1\n' };
    const req = await build(
      dokWith(facts(b, ['config/secrets/keys.ts', 'app/page.tsx'])),
      fakeSeams({ atBase: b, files: a }),
      { read: readOf(a) },
    );
    expect(req.payload!.changed_files).toEqual([
      { path: '.env.local', shown_as: 'withheld' },
      { path: 'app/page.tsx', shown_as: 'diff' },
    ]);
    expect(req.payload!.diff).not.toContain('.env.local');
    expect(req.payload!.withheld_files).toEqual(['.env.local', 'config/secrets/keys.ts']);
    expect(req.userPrompt).not.toContain('A=2');
    expect(req.sentFiles).toEqual(['app/page.tsx']);
    expect(req.transmissions.map((t) => t.file)).toEqual(['app/page.tsx']);
  });

  it('skips when nothing can be shown: only withheld changes', async () => {
    const b = { 'lib/a.ts': 'export const a = 1\n', '.env': 'A=1\n' };
    const a = { 'lib/a.ts': 'export const a = 1\n', '.env': 'A=2\n' };
    const req = await build(dokWith(facts(b, [])), fakeSeams({ atBase: b, files: a }), { read: readOf(a) });
    expect(req).toMatchObject({ status: 'skip', skipReason: 'no_diff', withheld: ['.env'] });
  });

  it('skips Doks the judge must not see: no change facts, or an unreadable file', async () => {
    const noFacts = await build(dokWith({ logic_files: [{ file: 'app/page.tsx' }] }), fakeSeams());
    expect(noFacts.skipReason).toBe('no_facts');
    const unreadable = await build(
      dokWith(facts(before, [])),
      fakeSeams(),
      { read: { contents: readOf(after).contents, missing: ['gone.ts'] } },
    );
    expect(unreadable.skipReason).toBe('unreadable');
  });

  it('sends line-range anchors as excerpts; a whole-file entry wins; ranges merge; out-of-range lines drop', async () => {
    const page = Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join('\n');
    const files = { ...after, 'app/view.tsx': page, 'lib/whole.ts': 'whole\n' };
    const dok = dokWith(facts(before, [
      { file: 'app/view.tsx', start_line: 8, end_line: 9 },
      { file: 'app/view.tsx', start_line: 2, end_line: 3 },
      { file: 'app/view.tsx', start_line: 4, end_line: 5 },
      { file: 'app/view.tsx', start_line: 40, end_line: 41 },
      { file: 'lib/whole.ts', start_line: 1, end_line: 1 },
      { file: 'lib/whole.ts' },
      { file: 'app/view.tsx', start_line: 11 },
    ]));
    const req = await build(dok, fakeSeams({ atBase: before, files }));
    expect(req.payload!.anchors).toEqual([
      { path: 'app/view.tsx', lines: '2-5', content: 'line 2\nline 3\nline 4\nline 5' },
      { path: 'app/view.tsx', lines: '8-9', content: 'line 8\nline 9' },
      { path: 'app/view.tsx', lines: '11-11', content: 'line 11' },
      { path: 'lib/whole.ts', lines: null, content: 'whole\n' },
    ]);
    expect(req.anchorsSent).toEqual(['app/view.tsx', 'lib/whole.ts']);
    expect(req.sentFiles).toEqual(['app/page.tsx', 'app/view.tsx', 'lib/whole.ts']);
  });

  it('is deterministic: two builds are byte-identical', async () => {
    const make = () => build(dokWith(facts(before, ['app/page.tsx', 'lib/a.ts'])), fakeSeams({ atBase: before, files: after }));
    const [x, y] = [await make(), await make()];
    expect(x.userPrompt).toBe(y.userPrompt);
    expect(x.requestDigest).toBe(y.requestDigest);
    expect(x.logicHash).toBe(y.logicHash);
    expect(x.dokSha256).toBe(y.dokSha256);
  });
});

describe('judge request builder over a real git repository', () => {
  let dir: string | undefined;
  afterEach(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function git(args: string[]): string {
    return execFileSync('git', ['-C', dir!, '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', ...args], {
      encoding: 'utf8',
      env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' },
    });
  }

  async function put(rel: string, content: string): Promise<void> {
    await mkdir(dirname(join(dir!, rel)), { recursive: true });
    await writeFile(join(dir!, rel), content);
  }

  async function repo(files: Record<string, string>): Promise<string> {
    dir = await mkdtemp(join(tmpdir(), 'doklo-judge-git-'));
    for (const [rel, content] of Object.entries(files)) await put(rel, content);
    git(['init', '-q']);
    git(['add', '-A']);
    git(['commit', '-q', '-m', 'base']);
    return git(['rev-parse', 'HEAD']).trim();
  }

  async function buildAt(projectRoot: string, meta: Record<string, unknown>, files: string[], budgetChars?: number) {
    const read = readAnchorContentsSync(files, projectRoot);
    expect(read.missing).toEqual([]);
    return buildJudgeRequest(
      { dok: dokWith(meta), read, translate: CTX, locale: 'en', ...(budgetChars !== undefined ? { budgetChars } : {}) },
      gitJudgeSeams(projectRoot),
    );
  }

  it('diffs the working tree against source_commit (uncommitted edits included, no ..HEAD), with paths relative to the project root', async () => {
    const page = 'export function expiry() {\n  return 7\n}\n';
    const lib = 'export const x = 1\n';
    const base = await repo({ 'web/app/[id]/page.tsx': page, 'web/lib.ts': lib, 'README.md': 'root\n' });
    // A committed change and an uncommitted one: both must be in the diff.
    await put('web/app/[id]/page.tsx', page.replace('7', '14'));
    git(['commit', '-q', '-am', 'change']);
    await put('web/lib.ts', 'export const x = 2\n');

    const projectRoot = join(dir!, 'web');
    const req = await buildAt(projectRoot, {
      source_commit: base,
      logic_files: [
        { file: 'app/[id]/page.tsx', sha256: computeSourceFileSha256(page) },
        { file: 'lib.ts', sha256: computeSourceFileSha256(lib) },
      ],
      source_anchors: [{ file: 'app/[id]/page.tsx' }],
    }, ['app/[id]/page.tsx', 'lib.ts']);

    expect(req.diffBaseChecks).toEqual([
      { file: 'app/[id]/page.tsx', check: 'verified' },
      { file: 'lib.ts', check: 'verified' },
    ]);
    expect(req.payload!.changed_files).toEqual([
      { path: 'app/[id]/page.tsx', shown_as: 'diff' },
      { path: 'lib.ts', shown_as: 'diff' },
    ]);
    expect(req.payload!.diff).toContain('+  return 14');
    expect(req.payload!.diff).toContain('+export const x = 2');
    // Headers name the paths the judge must cite — relative to the service's code root.
    expect(req.payload!.diff).toContain('diff --git a/app/[id]/page.tsx b/app/[id]/page.tsx');
    expect(req.payload!.diff).not.toContain('web/');
    expect(req.anchorsSent).toEqual(['app/[id]/page.tsx']);
    // Reading never touched the repository.
    expect(git(['status', '--porcelain']).trim()).toBe('M web/lib.ts');
  });

  it('falls back to the whole current file when the tree was dirty at generation, or the file is new', async () => {
    const base = await repo({ 'lib.ts': 'export const x = 1\n', 'app.ts': 'export const app = 1\n' });
    // Generation saw an uncommitted edit (and a file not yet committed); the stored hashes are of that.
    const atGeneration = 'export const x = 2\n';
    const created = 'export const extra = 1\n';
    await put('lib.ts', 'export const x = 3\n');
    await put('extra.ts', 'export const extra = 2\n');

    const req = await buildAt(dir!, {
      source_commit: base,
      logic_files: [
        { file: 'app.ts', sha256: computeSourceFileSha256('export const app = 1\n') },
        { file: 'extra.ts', sha256: computeSourceFileSha256(created) },
        { file: 'lib.ts', sha256: computeSourceFileSha256(atGeneration) },
      ],
      source_anchors: [{ file: 'app.ts' }],
    }, ['app.ts', 'extra.ts', 'lib.ts']);

    expect(req.diffBaseChecks).toEqual([
      { file: 'extra.ts', check: 'missing-at-base' },
      { file: 'lib.ts', check: 'hash-mismatch' },
    ]);
    expect(req.payload!.diff).toBeNull();
    expect(req.payload!.full_files).toEqual([
      { path: 'extra.ts', content: 'export const extra = 2\n' },
      { path: 'lib.ts', content: 'export const x = 3\n' },
    ]);
    expect(req.diffSource).toBe('full_content');
  });

  it('leaves a file that changed in form only out of the diff', async () => {
    const a = 'export const a = 1;\n';
    const b = 'export const b = 1;\n';
    const base = await repo({ 'a.ts': a, 'b.ts': b });
    await put('a.ts', '// The a flag.\nexport   const a = 1; // one\n');
    await put('b.ts', 'export const b = 2;\n');
    const req = await buildAt(dir!, {
      source_commit: base,
      logic_files: [{ file: 'a.ts', sha256: computeSourceFileSha256(a) }, { file: 'b.ts', sha256: computeSourceFileSha256(b) }],
      source_anchors: [],
    }, ['a.ts', 'b.ts']);
    expect(req.formatOnlyFiles).toEqual(['a.ts']);
    expect(req.payload!.changed_files).toEqual([{ path: 'b.ts', shown_as: 'diff' }]);
    expect(req.payload!.diff).toContain('+export const b = 2;');
    expect(req.payload!.diff).not.toContain('a.ts');
  });

  it('fills the budget Dok → diff → anchors, naming the anchors left out', async () => {
    const changed = 'export const limit = 10;\n';
    const big = `export const big = '${'x'.repeat(2_000)}';\n`;
    const small = 'export const small = 1;\n';
    const base = await repo({ 'limit.ts': changed, 'big1.ts': big, 'big2.ts': big, 'small.ts': small });
    await put('limit.ts', 'export const limit = 20;\n');
    const meta = {
      source_commit: base,
      logic_files: [{ file: 'limit.ts', sha256: computeSourceFileSha256(changed) }],
      source_anchors: [{ file: 'big1.ts' }, { file: 'big2.ts' }, { file: 'small.ts' }],
    };
    const probe = await buildAt(dir!, meta, ['limit.ts']);
    expect(probe.anchorsSent).toEqual(['big1.ts', 'big2.ts', 'small.ts']);
    const fixed = probe.sections.dokChars + probe.sections.diffChars;

    const req = await buildAt(dir!, meta, ['limit.ts'], fixed + big.length + 1);
    expect(req.payload!.diff).toContain('+export const limit = 20;');
    expect(req.anchorsSent).toEqual(['big1.ts']);
    expect(req.payload!.omitted_anchors).toEqual(['big2.ts', 'small.ts']);

    const over = await buildAt(dir!, meta, ['limit.ts'], fixed - 1);
    expect(over).toMatchObject({ status: 'skip', skipReason: 'over_budget' });
  });
});
