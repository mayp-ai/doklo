import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLivedoc, renderPublication } from '../src/render.js';
import { publicationDigest, serializePublication, type PublicationV1 } from '../src/publication.js';
import { DokSchema } from '@doklo-beta/core';
import { prepareStableHelpCopy } from '../src/stable-help-copy.js';
import { checkKoreanHelpWriting } from '../src/korean-writing-policy.js';

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
async function fixture(description: unknown, tone?: 'formal' | 'plain' | 'polite', recordedTone?: 'formal' | 'plain') {
  const root = await mkdtemp(join(tmpdir(), 'doklo-ko-policy-'));
  roots.push(root);
  await cp(join(here, 'fixtures/render-ws'), root, { recursive: true });
  const workspacePath = join(root, 'workspace.json');
  const workspace = JSON.parse(await readFile(workspacePath, 'utf8'));
  await writeFile(workspacePath, JSON.stringify({ ...workspace, default_locale: 'ko', ...(tone ? { korean_customer_tone: tone } : {}) }));
  const doks = join(root, '.doklo/hub/doks');
  for (const name of await readdir(doks)) await rm(join(doks, name));
  await writeFile(join(doks, 'CHAT.json'), JSON.stringify({ dok_id: 'CHAT', name: '대화', description, status: 'active',
    ...(recordedTone ? { _meta: { writing_policy: { locale: 'ko', tone: recordedTone } } } : {}),
  }));
  return root;
}
const render = (root: string, preview = false, extra = {}) => renderLivedoc({ workspaceRoot: root, templateRef: 'help-page', source: 'builtin',
  builtinRoot: join(here, '../templates'), locale: 'ko', format: 'html', outDir: join(root, preview ? 'preview' : 'official'), outputRoot: root, dokIds: ['CHAT'], preview, ...extra });
async function acknowledge(root: string, tone: 'formal' | 'plain') {
  const path = join(root, '.doklo/hub/doks/CHAT.json');
  const dok = JSON.parse(await readFile(path, 'utf8'));
  dok._meta.writing_review = { concerns: [], policy_acknowledgment: {
    locale: 'ko', tone, acknowledged_at: '2026-09-25T03:00:00.000Z',
  } };
  await writeFile(path, JSON.stringify(dok));
  return { path, before: await readFile(path) };
}

describe('Korean customer help writing policy', () => {
  it.each(['메시지를 보낸다\n답변을 확인합니다.', 'API 처리를 수행한다.\n메시지를 보낸다\n답변을 확인합니다.'])(
    'retains newline sentence boundaries through stable copy normalization: %s', (description) => {
      const dok = DokSchema.parse({ dok_id: 'CHAT', name: '대화', description });
      const { copy } = prepareStableHelpCopy({ dok, workspaceName: '제품', resolve: value => String(value), actorLabel: () => '사용자' });
      expect(copy.description).toContain('메시지를 보낸다\n답변을 확인합니다.');
      expect(checkKoreanHelpWriting({ dok, copy })).toContainEqual(expect.objectContaining({
        code: 'KOREAN_TONE_CONFLICT', field: 'description',
      }));
    },
  );
  it('reports newline-separated conflicts in the actual render path', async () => {
    const root = await fixture('메시지를 보낸다\n답변을 확인합니다.');
    const result = await render(root);
    expect(result.manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT', field: 'description' }));
  });
  it('publishes legacy plain sentences as written under the formal policy and names them (D1)', async () => {
    const root = await fixture('메시지를 보낸다. 요청을 취소한다.');
    const dokPath = join(root, '.doklo/hub/doks/CHAT.json');
    const before = await readFile(dokPath);
    const result = await render(root);
    expect(result.manifest.warnings).toContainEqual(expect.objectContaining({
      code: 'KOREAN_TONE_CONFLICT', dok_id: 'CHAT', field: 'description', message: expect.stringContaining('Published as written'),
    }));
    const html = await readFile(join(root, 'official/CHAT.html'), 'utf8');
    expect(html).toContain('메시지를 보낸다.');
    expect(html).not.toMatch(/data-doklo-preview="draft"/);
    expect(await readFile(dokPath)).toEqual(before);
  });
  it('allows the selected plain policy and preserves quotations and labels', async () => {
    const root = await fixture('“취소합니다.”라는 문구를 확인한다. 메시지를 보낸다.', 'plain');
    await render(root);
    expect(await readFile(join(root, 'official/CHAT.html'), 'utf8')).toContain('메시지를 보낸다.');
  });
  it('a polite workspace names 합쇼체 wording and accepts 해요체 as written', async () => {
    const formal = await render(await fixture('주문을 선택합니다.', 'polite'));
    expect(formal.manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT', field: 'description' }));
    const polite = await render(await fixture('주문을 선택하세요. 환불이 접수돼요.', 'polite'));
    expect(polite.manifest.warnings.filter(w => w.code === 'KOREAN_TONE_CONFLICT')).toEqual([]);
  });
  it('checks canonical TermRefs after resolution and permits explicit audience corrections', async () => {
    const root = await fixture({ term_ref: 'TERM-MESSAGE-SEND' });
    await writeFile(join(root, '.doklo/hub/lexicon.json'), JSON.stringify({ version: 1, terms: [
      { term_id: 'TERM-MESSAGE-SEND', category: 'concept', binding: { type: 'owned' }, locales: { ko: '메시지를 보낸다.' }, related_doks: [] },
    ] }));
    expect((await render(root)).manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT', field: 'description' }));
    const corrected = await render(root, false, { overwrite: true, audienceDictionary: [['메시지를 보낸다.', '메시지를 보냅니다.']] });
    expect(corrected.manifest.warnings ?? []).not.toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT' }));
    expect(await readFile(join(root, 'official/CHAT.html'), 'utf8')).toContain('메시지를 보냅니다.');
  });
  it('warns in a permanently marked preview without changing Hub status or prose', async () => {
    const root = await fixture('메시지를 보낸다.');
    const dokPath = join(root, '.doklo/hub/doks/CHAT.json');
    const before = await readFile(dokPath);
    const result = await render(root, true);
    expect(result.manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT', dok_id: 'CHAT', field: 'description' }));
    expect(await readFile(join(root, 'preview/CHAT.html'), 'utf8')).toMatch(/data-doklo-preview="draft"/);
    expect(await readFile(dokPath)).toEqual(before);
  });
  it('asks for renewed review when the recorded generation policy differs from the workspace', async () => {
    const root = await fixture('메시지를 보낸다.', 'plain', 'formal');
    expect((await render(root)).manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_WRITING_POLICY_CHANGED', dok_id: 'CHAT' }));
    const preview = await render(root, true);
    expect(preview.manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_WRITING_POLICY_CHANGED' }));
  });
  it('accepts explicit review for the current policy without changing generation provenance or Hub bytes', async () => {
    const root = await fixture('메시지를 보낸다.', 'plain', 'formal');
    const { path, before } = await acknowledge(root, 'plain');
    const result = await render(root);
    expect(result.manifest.warnings ?? []).not.toContainEqual(expect.objectContaining({ code: 'KOREAN_WRITING_POLICY_CHANGED' }));
    expect(await readFile(path)).toEqual(before);
    expect(JSON.parse(await readFile(path, 'utf8'))._meta.writing_policy).toEqual({ locale: 'ko', tone: 'formal' });
  });
  it('does not accept acknowledgment for another policy', async () => {
    const root = await fixture('메시지를 보낸다.', 'plain', 'formal');
    await acknowledge(root, 'formal');
    expect((await render(root)).manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_WRITING_POLICY_CHANGED' }));
  });
  it('continues checking actual prose after a matching policy acknowledgment', async () => {
    const root = await fixture('메시지를 보냅니다.', 'plain', 'formal');
    await acknowledge(root, 'plain');
    expect((await render(root)).manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT', field: 'description' }));
    const preview = await render(root, true);
    expect(preview.manifest.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT' }));
    expect(preview.manifest.warnings).not.toContainEqual(expect.objectContaining({ code: 'KOREAN_WRITING_POLICY_CHANGED' }));
  });
});

describe('Korean customer help writing policy in a publication render', () => {
  it('publishes and names the Dok and field in the plan warnings', async () => {
    const root = await fixture('메시지를 보낸다. 요청을 취소한다.');
    const value: PublicationV1 = {
      schema_version: 1, name: 'ko-help', display_name: '도움말', template: 'help-page',
      selection: { mode: 'explicit', dok_ids: ['CHAT'] }, selected_dok_ids: ['CHAT'], format: 'html', locale: 'ko',
      vars: {}, output_dir: 'help-page/ko-help', created_at: '2026-10-08T00:00:00.000Z',
    };
    const directory = join(root, '.doklo/livedocs/publications');
    await mkdir(directory, { recursive: true });
    const path = join(directory, 'ko-help.json');
    await writeFile(path, serializePublication(value));
    const result = await renderPublication({ workspaceRoot: root, publication: value, definition: { path, sha256: publicationDigest(value) } });
    expect(result.status).toBe('success');
    if (result.status !== 'success') return;
    expect(result.data.rendered_dok_ids ?? result.data.selected_dok_ids).toContain('CHAT');
    expect(result.data.plan.warnings).toContainEqual(expect.objectContaining({ code: 'KOREAN_TONE_CONFLICT', dok_id: 'CHAT' }));
  });
});
