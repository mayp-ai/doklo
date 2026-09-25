import { describe, it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runEvaluate, NoDoksFoundError } from '../src/commands/evaluate.js';

async function tmpHub(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-eval-'));
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await writeFile(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'demo',
      name: 'Demo',
      services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
    'utf-8',
  );
  return root;
}

function dummyDok(dokId: string, name: string) {
  return {
    dok_id: dokId,
    name,
    status: 'active',
    tags: [],
    surfaces: ['web'],
    description:
      'A reasonably sized description so the description-length signal does not flag it.',
    user_actions: {
      steps: [
        {
          order: 1,
          actor: { kind: 'system' },
          intent: 'Render the page',
          outcome: 'Page is shown',
          variants: [{ platform: 'all', interaction: 'auto' }],
        },
      ],
    },
    business_rules: { rules: [] },
    acceptance_criteria: { criteria: [] },
  };
}

describe('runEvaluate', () => {
  it('throws NoDoksFoundError when .doklo/hub/doks is empty', async () => {
    const root = await tmpHub();
    await expect(runEvaluate({ root })).rejects.toThrowError(NoDoksFoundError);
  });

  it('returns a ScoreReport when at least one Dok is present', async () => {
    const root = await tmpHub();
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(dummyDok('AUTH', 'Sign in')),
      'utf-8',
    );

    const result = await runEvaluate({ root });
    expect(result.report.maxTotal).toBe(500);
    expect(result.report.totalDoks).toBe(1);
    expect(result.report.total).toBeGreaterThan(0);
  });

  it('aggregates multiple per-Dok files', async () => {
    const root = await tmpHub();
    await writeFile(
      join(root, '.doklo/hub/doks/AUTH.json'),
      JSON.stringify(dummyDok('AUTH', 'Sign in')),
      'utf-8',
    );
    await writeFile(
      join(root, '.doklo/hub/doks/USER.json'),
      JSON.stringify(dummyDok('USER', 'Profile')),
      'utf-8',
    );

    const result = await runEvaluate({ root });
    expect(result.report.totalDoks).toBe(2);
  });

  it('reports non-scoring writing, content, and lifecycle review signals without collapsing unknown states', async () => {
    const root = await tmpHub();
    const fixtures = [
      {
        ...dummyDok('REPORTED', 'Reported'),
        status: 'draft',
        _meta: {
          writing_review: { assessed_by: 'deterministic', concerns: [] },
          content_review: { assessed_by: 'model', reported: true, product_sources: [], concerns: [] },
        },
      },
      {
        ...dummyDok('UNREPORTED', 'Unreported'),
        status: 'review',
        _meta: {
          writing_review: { assessed_by: 'deterministic', concerns: [
            { code: 'KOREAN_TONE_CONFLICT', field: 'description', expected_tone: 'formal', actual_tone: 'plain', excerpt: '메시지를 보낸다.' },
            { code: 'KOREAN_TONE_CONFLICT', field: 'user_actions.steps[0].intent', expected_tone: 'formal', actual_tone: 'plain', excerpt: '설정을 확인한다.' },
          ] },
          content_review: { assessed_by: 'model', reported: false, product_sources: [], concerns: [] },
        },
      },
      { ...dummyDok('MISSING', 'Missing'), status: 'active' },
      {
        ...dummyDok('MALFORMED', 'Malformed'),
        status: 'archived',
        _meta: {
          content_review: { reported: 'unknown', concerns: [{ message: 'Retain visible concern count.' }] },
        },
      },
      {
        ...dummyDok('CONCERN', 'Concern'),
        status: 'draft',
        _meta: {
          content_review: { assessed_by: 'model', reported: true, product_sources: [], concerns: [{ message: 'Check fact.' }] },
        },
      },
    ];
    await Promise.all(fixtures.map((dok) => writeFile(
      join(root, `.doklo/hub/doks/${dok.dok_id}.json`),
      JSON.stringify(dok),
      'utf-8',
    )));

    const result = await runEvaluate({ root });

    expect(result.review).toEqual({
      scope: 'recorded_metadata',
      notice: 'Recorded review signals may predate manual prose edits; they are not fresh findings or content approval.',
      writing: {
        assessed_doks: 2,
        missing_doks: 3,
        doks_with_concerns: 1,
        concerns: 2,
      },
      content: {
        reported_doks: 2,
        unreported_doks: 1,
        missing_doks: 1,
        unknown_doks: 1,
        doks_with_concerns: 2,
        concerns: 2,
      },
      status: { draft: 2, review: 1, active: 1, planned: 0, deprecated: 0, archived: 1 },
    });
    expect(result.report.maxTotal).toBe(500);
  });

  it('also accepts a single doks.json (array form) for golden-fixture compat', async () => {
    const root = await tmpHub();
    await writeFile(
      join(root, '.doklo/hub/doks.json'),
      JSON.stringify([
        dummyDok('AUTH', 'Sign in'),
        dummyDok('USER', 'Profile'),
      ]),
      'utf-8',
    );
    const result = await runEvaluate({ root });
    expect(result.report.totalDoks).toBe(2);
  });

  it('skips files that fail Dok schema validation (records them in problems)', async () => {
    const root = await tmpHub();
    await writeFile(
      join(root, '.doklo/hub/doks/BAD.json'),
      JSON.stringify({ dok_id: 'BAD' /* missing required fields */ }),
      'utf-8',
    );
    await writeFile(
      join(root, '.doklo/hub/doks/GOOD.json'),
      JSON.stringify(dummyDok('GOOD', 'OK')),
      'utf-8',
    );
    const result = await runEvaluate({ root });
    expect(result.report.totalDoks).toBe(1);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]?.file.endsWith('BAD.json')).toBe(true);
  });
});
