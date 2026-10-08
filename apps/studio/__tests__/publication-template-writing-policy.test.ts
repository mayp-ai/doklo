import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderLivedoc } from '@doklo-beta/livedoc-engine';
import { loadPublicationWorkspaceModel } from '../lib/publication-read-model';
import { getPublicationTemplatePreview } from '../lib/publication-template-preview';

vi.mock('@doklo-beta/livedoc-engine', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/livedoc-engine')>();
  return { ...actual, renderLivedoc: vi.fn(actual.renderLivedoc) };
});

const roots: string[] = [];
afterEach(async () => {
  vi.mocked(renderLivedoc).mockClear();
  await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true })));
});

async function fixture(policyChanged = false) {
  const root = await mkdtemp(join(tmpdir(), 'doklo-template-policy-'));
  roots.push(root);
  await cp(new URL('../../../packages/livedoc-engine/__tests__/fixtures/render-ws', import.meta.url), root, { recursive: true });
  const authPath = join(root, '.doklo/hub/doks/AUTH.json');
  const auth = JSON.parse(await readFile(authPath, 'utf8'));
  auth.description = policyChanged ? '이메일로 로그인합니다.' : '이메일로 로그인한다.';
  if (policyChanged) auth._meta.writing_policy = { locale: 'ko', tone: 'plain' };
  await writeFile(authPath, JSON.stringify(auth));
  const billPath = join(root, '.doklo/hub/doks/BILL.json');
  const bill = JSON.parse(await readFile(billPath, 'utf8'));
  bill.description = '결제 정보를 확인합니다.';
  await writeFile(billPath, JSON.stringify(bill));
  const model = await loadPublicationWorkspaceModel({ root });
  const template = model.templates.find(candidate => candidate.name === 'help-page')!;
  return { root, template, locale: 'ko', authPath, billPath };
}

describe('template preview writing policy fallback', () => {
  it.each([false, true])('uses the next valid Dok without modifying source (policy changed: %s)', async (policyChanged) => {
    const input = await fixture(policyChanged);
    const before = await Promise.all([readFile(input.authPath), readFile(input.billPath)]);
    const preview = await getPublicationTemplatePreview(input);
    expect(preview.kind).toBe('html');
    if (preview.kind === 'html') {
      expect(preview.html).toContain('결제 정보를 확인합니다.');
      expect(preview.html).not.toContain('이메일로 로그인');
    }
    expect(await Promise.all([readFile(input.authPath), readFile(input.billPath)])).toEqual(before);
  });

  it('returns the last validation error when every candidate needs review', async () => {
    const input = await fixture();
    const bill = JSON.parse(await readFile(input.billPath, 'utf8'));
    bill.description = '결제 정보를 확인한다.';
    await writeFile(input.billPath, JSON.stringify(bill));
    await expect(getPublicationTemplatePreview(input)).rejects.toMatchObject({
      code: 'KOREAN_TONE_CONFLICT', dokId: 'BILL',
    });
  });

  it('propagates unrelated failures without trying another candidate', async () => {
    const input = await fixture();
    const failure = Object.assign(new Error('Synthetic filesystem failure'), { code: 'EIO' });
    vi.mocked(renderLivedoc).mockRejectedValueOnce(failure);
    await expect(getPublicationTemplatePreview(input)).rejects.toBe(failure);
    expect(renderLivedoc).toHaveBeenCalledTimes(1);
  });
});
