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
