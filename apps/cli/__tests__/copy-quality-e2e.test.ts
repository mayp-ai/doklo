import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { buildDokPromptParts } from '@doklo-beta/generator';
import { renderLivedoc } from '@doklo-beta/livedoc-engine';
import { runEvaluate } from '../src/commands/evaluate.js';

const here = dirname(fileURLToPath(import.meta.url));
const builtinRoot = join(here, '../../../packages/livedoc-engine/templates');
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('customer-copy quality flow', () => {
  it('keeps prompt policy, public formats, canonical terms, edited role names, and review scope aligned', async () => {
    const root = await mkdtemp(join(tmpdir(), 'doklo-copy-quality-'));
    roots.push(root);
    const doksDir = join(root, '.doklo', 'hub', 'doks');
    await mkdir(doksDir, { recursive: true });
    await writeFile(join(root, 'workspace.json'), JSON.stringify({
      workspace_id: 'copy-quality',
      name: '사진 제품',
      services: [],
      default_locale: 'ko',
      supported_locales: ['ko'],
    }));
    await writeFile(join(root, '.doklo', 'hub', 'roles.json'), JSON.stringify({
      version: 1,
      roles: [{ role_id: 'ROLE-ADMIN', name: '운영 담당자', kind: 'access', extends: [], scope: 'global' }],
    }));
    await writeFile(join(root, '.doklo', 'hub', 'lexicon.json'), JSON.stringify({
      version: 1,
      terms: [{
        term_id: 'TERM-PHOTO-COPY',
        category: 'concept',
        binding: { type: 'owned' },
        locales: { ko: 'JPEG, PNG, WebP, HEIC, HEIF 형식이며 파일당 10MB까지 첨부할 수 있습니다.' },
        related_doks: ['CHAT'],
      }],
    }));
    await writeFile(join(doksDir, 'CHAT.json'), JSON.stringify({
      dok_id: 'CHAT',
      name: '사진 첨부',
      status: 'active',
      tags: ['photo'],
      surfaces: ['web'],
      description: { term_ref: 'TERM-PHOTO-COPY' },
      user_actions: { steps: [{
        order: 1,
        actor: { kind: 'role', role_ref: 'ROLE-ADMIN' },
        intent: '사진을 선택해 첨부합니다.',
        outcome: '선택한 사진이 표시됩니다.',
        variants: [{ platform: 'all', interaction: 'input' }],
      }] },
      business_rules: { rules: [] },
      acceptance_criteria: { criteria: [] },
      _meta: {
        writing_policy: { locale: 'ko', tone: 'formal' },
        writing_review: { assessed_by: 'deterministic', concerns: [] },
        content_review: { assessed_by: 'model', reported: true, product_sources: [], concerns: [] },
      },
    }));

    const prompt = buildDokPromptParts({
      canonical_id: 'chat',
      label: '사진 첨부',
      dok_id_prefix: 'CHAT',
      primary_route: '/chat',
      members: [],
      files: ['app/chat/page.tsx'],
    }, {
      defaultLocale: 'ko',
      knownRoles: ['ROLE-ADMIN'],
      fileContext: { 'app/chat/page.tsx': 'export const accepted = ["WebP"];' },
      dokId: 'CHAT',
      lexiconTerms: ['사진 첨부'],
    });
    expect(prompt.systemPrompt).toContain('intent: "설정 화면을 열어 계정 정보를 확인합니다."');
    expect(prompt.systemPrompt).toContain('사진 첨부');

    await renderLivedoc({
      workspaceRoot: root,
      templateRef: 'help-page',
      source: 'builtin',
      builtinRoot,
      locale: 'ko',
      format: 'markdown',
      outDir: join(root, 'out'),
      dokIds: ['CHAT'],
    });
    const markdown = await readFile(join(root, 'out', 'CHAT.md'), 'utf8');
    expect(markdown).toContain('JPEG, PNG, WebP, HEIC, HEIF');
    expect(markdown).toContain('운영 담당자');
    expect(markdown).toContain('사진을 선택해 첨부합니다.');

    const evaluated = await runEvaluate({ root });
    expect(evaluated.report.maxTotal).toBe(500);
    expect(evaluated.review).toMatchObject({
      scope: 'recorded_metadata',
      writing: { concerns: 0, assessed_doks: 1 },
      content: { concerns: 0, reported_doks: 1 },
      status: { active: 1, draft: 0 },
    });
  });
});
