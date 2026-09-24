import { cp, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLivedoc } from '../src/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function renderCopy(copy: string, preview: boolean, field: 'description' | 'rule' = 'description') {
  const root = await mkdtemp(join(tmpdir(), 'doklo-implementation-copy-'));
  roots.push(root);
  await cp(join(here, 'fixtures/render-ws'), root, { recursive: true });
  const path = join(root, '.doklo/hub/doks/AUTH.json');
  const dok = JSON.parse(await readFile(path, 'utf8'));
  dok.status = preview ? 'draft' : 'active';
  if (field === 'rule') dok.business_rules = { rules: [{ id: 'BR-AUTH-03', type: 'calculation', description: copy }] };
  else dok.description = copy;
  await writeFile(path, JSON.stringify(dok));
  return {
    root,
    render: () => renderLivedoc({
      workspaceRoot: root, templateRef: 'help-page', source: 'builtin',
      builtinRoot: join(here, '../templates'), locale: 'ko',
      outDir: join(root, 'output'), dokIds: ['AUTH'], allFormats: true, preview,
    }),
  };
}

describe('customer copy implementation details', () => {
  it.each([
    '이메일이 없으면 내부 초대용 주소를 만들어 저장합니다.',
    '내부 초대용 이메일 주소를 저장합니다.',
    'A synthetic email address is saved for the invited account.',
    'The account stores an internal invitation address.',
  ])('rejects leaked address storage detail in reviewed and draft renders: %s', async (copy) => {
    for (const preview of [false, true]) {
      const { root, render } = await renderCopy(copy, preview);
      await expect(render()).rejects.toMatchObject({
        code: 'STABLE_LINT_FAILED',
        violations: expect.arrayContaining([expect.objectContaining({ code: 'IMPLEMENTATION_DETAIL' })]),
      });
      expect(await readdir(root)).not.toContain('output');
    }
  });

  it('rejects the original Baesisi SETTINGS rule without approving or rewriting it', async () => {
    const copy = '초대 링크로 참여한 가족 구성원은 실제 이메일 대신 내부 초대용 주소로 저장되며 화면에는 이메일 대신 초대 링크로 참여했다는 문구가 표시됩니다.';
    for (const preview of [false, true]) {
      const { root, render } = await renderCopy(copy, preview, 'rule');
      const path = join(root, '.doklo/hub/doks/AUTH.json');
      const before = await readFile(path, 'utf8');
      await expect(render()).rejects.toMatchObject({
        code: 'STABLE_LINT_FAILED',
        violations: expect.arrayContaining([expect.objectContaining({ code: 'IMPLEMENTATION_DETAIL' })]),
      });
      expect(await readFile(path, 'utf8')).toBe(before);
    }
  });

  it.each([
    '초대 링크로 참여한 구성원의 목록 항목에는 실제 이메일 대신 초대 링크로 참여라는 문구가 표시됩니다.',
    '초대할 사람의 이메일 주소를 입력하고 초대 보내기를 누릅니다.',
    'Enter an email address, then send the invitation. Your saved address is shown in settings.',
  ])('retains public invitation and email entry instructions: %s', async (copy) => {
    const { render } = await renderCopy(copy, false);
    const result = await render();
    expect(await readFile(result.outputs.find((output) => output.format === 'markdown')!.path, 'utf8')).toContain(copy);
  });
});
