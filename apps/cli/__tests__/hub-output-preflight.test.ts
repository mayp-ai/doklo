import { describe, expect, it } from 'vitest';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { preflightExistingHubOutputs } from '../src/lib/hub-output-preflight.js';

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-hub-preflight-'));
  await mkdir(join(root, 'app'), { recursive: true });
  await mkdir(join(root, '.doklo', 'hub', 'doks'), { recursive: true });
  await writeFile(join(root, 'app', 'page.tsx'), 'export default function Page(){ return null; }');
  await writeFile(join(root, 'package.json'), JSON.stringify({ dependencies: { next: '15.4.0' } }));
  await writeFile(join(root, 'workspace.json'), JSON.stringify({
    workspace_id: 'demo',
    name: 'Demo',
    services: [{ service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' }],
    default_locale: 'en',
    supported_locales: ['en'],
  }));
  await writeFile(join(root, '.doklo', 'hub', 'roles.json'), JSON.stringify({
    version: 1,
    roles: [{ role_id: 'ROLE-USER', name: 'User', kind: 'access', extends: [], scope: 'global' }],
  }));
  return root;
}

function dok(dokId: string) {
  return {
    dok_id: dokId,
    name: 'Sign in',
    description: 'Users authenticate to enter the application.',
    user_actions: {
      steps: [{
        order: 1,
        actor: { kind: 'role', role_ref: 'ROLE-USER' },
        intent: 'Open sign in',
        outcome: 'Sign in is visible',
        variants: [{ platform: 'all', interaction: 'navigate' }],
      }],
    },
    _meta: {
      version: 1,
      history: [],
      source_anchors: [{ service_id: 'web', file: 'app/page.tsx' }],
    },
  };
}

describe('Hub output preflight', () => {
  it('validates every existing Dok before generation', async () => {
    await expect(preflightExistingHubOutputs({
      root: '/tmp/doklo-missing-fixture',
      services: [],
    })).rejects.toThrow();
  });

  it('loads and validates Doks unrelated to the current generation plan', async () => {
    const root = await fixture();
    await writeFile(join(root, '.doklo', 'hub', 'doks', 'AUTH.json'), JSON.stringify(dok('AUTH')));
    await writeFile(join(root, '.doklo', 'hub', 'doks', 'BILL.json'), JSON.stringify(dok('BILL')));
    const result = await preflightExistingHubOutputs({ root });
    expect([...result.doks.keys()]).toEqual(['AUTH', 'BILL']);
  });

  it('rejects a Dok whose filename does not match its body ID', async () => {
    const root = await fixture();
    await writeFile(join(root, '.doklo', 'hub', 'doks', 'AUTH.json'), JSON.stringify(dok('BILL')));
    await expect(preflightExistingHubOutputs({ root })).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'DOK_ID_PATH_MISMATCH' },
    });
  });
});
