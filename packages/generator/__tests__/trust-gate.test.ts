import { chmod, mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { validateDokForWrite, type DokWriteTrustContext } from '../src/trust-gate.js';

const validDok = {
  dok_id: 'AUTH',
  name: 'Sign in',
  description: 'Users authenticate to enter the application.',
  surfaces: ['web'],
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
    source_anchors: [{ service_id: 'web', file: 'app/auth/page.tsx' }],
  },
};

async function context(): Promise<DokWriteTrustContext> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-trust-'));
  await mkdir(join(root, 'app/auth'), { recursive: true });
  await writeFile(join(root, 'app/auth/page.tsx'), 'export default function Page() { return null; }');
  return {
    expectedDokId: 'AUTH',
    serviceRoots: new Map([['web', root]]),
    knownRoleIds: new Set(['ROLE-USER']),
  };
}

describe('validateDokForWrite', () => {
  it('rejects a Dok with zero source anchors', async () => {
    await expect(validateDokForWrite({
      ...validDok,
      _meta: { ...validDok._meta, source_anchors: [] },
    }, await context())).rejects.toMatchObject({ code: 'DOK_TRUST_FAILED' });
  });

  it('rejects an escaped source anchor', async () => {
    await expect(validateDokForWrite({
      ...validDok,
      _meta: { ...validDok._meta, source_anchors: [{ service_id: 'web', file: '../secret.ts' }] },
    }, await context())).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'ESCAPED_SOURCE_ANCHOR' },
    });
  });

  it('rejects a source anchor that resolves to a directory', async () => {
    const trustContext = await context();
    await expect(validateDokForWrite({
      ...validDok,
      _meta: {
        ...validDok._meta,
        source_anchors: [{ service_id: 'web', file: 'app/auth' }],
      },
    }, trustContext)).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'SOURCE_ANCHOR_NOT_FILE' },
    });
  });

  it('rejects a source anchor that is not readable', async () => {
    const trustContext = await context();
    const file = trustContext.serviceRoots.get('web')! + '/app/auth/page.tsx';
    await chmod(file, 0o000);
    try {
      await expect(validateDokForWrite(validDok, trustContext)).rejects.toMatchObject({
        code: 'DOK_TRUST_FAILED',
        details: { reason: 'MISSING_SOURCE_ANCHOR' },
      });
    } finally {
      await chmod(file, 0o644);
    }
  });

  it('rejects anchor_service_id that disagrees with per-anchor provenance', async () => {
    const web = await context();
    const apiRoot = await mkdtemp(join(tmpdir(), 'doklo-trust-api-'));
    await mkdir(join(apiRoot, 'app/auth'), { recursive: true });
    await writeFile(join(apiRoot, 'app/auth/page.tsx'), 'export default function Page() { return null; }');
    await expect(validateDokForWrite({
      ...validDok,
      _meta: {
        ...validDok._meta,
        anchor_service_id: 'web',
        source_anchors: [{ service_id: 'api', file: 'app/auth/page.tsx' }],
      },
    }, {
      ...web,
      serviceRoots: new Map([['web', web.serviceRoots.get('web')!], ['api', apiRoot]]),
    })).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'ANCHOR_SERVICE_MISMATCH' },
    });
  });

  it('rejects an unknown declared anchor_service_id even when an anchor has provenance', async () => {
    await expect(validateDokForWrite({
      ...validDok,
      _meta: {
        ...validDok._meta,
        anchor_service_id: 'ghost',
      },
    }, await context())).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'UNKNOWN_ANCHOR_SERVICE' },
    });
  });

  it('rejects multi-service anchors without a canonical anchor_service_id', async () => {
    const web = await context();
    const apiRoot = await mkdtemp(join(tmpdir(), 'doklo-trust-api-'));
    await mkdir(join(apiRoot, 'app/auth'), { recursive: true });
    await writeFile(join(apiRoot, 'app/auth/page.tsx'), 'export default function Page() { return null; }');
    await expect(validateDokForWrite({
      ...validDok,
      _meta: {
        ...validDok._meta,
        source_anchors: [
          { service_id: 'web', file: 'app/auth/page.tsx' },
          { service_id: 'api', file: 'app/auth/page.tsx' },
        ],
      },
    }, {
      ...web,
      serviceRoots: new Map([['web', web.serviceRoots.get('web')!], ['api', apiRoot]]),
    })).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'ANCHOR_SERVICE_REQUIRED' },
    });
  });

  it('rejects a multi-service workspace Dok without anchor_service_id even when all anchors name one service', async () => {
    const web = await context();
    const apiRoot = await mkdtemp(join(tmpdir(), 'doklo-trust-api-'));
    await mkdir(join(apiRoot, 'app/auth'), { recursive: true });
    await writeFile(join(apiRoot, 'app/auth/page.tsx'), 'export default function Page() { return null; }');
    await expect(validateDokForWrite(validDok, {
      ...web,
      serviceRoots: new Map([['web', web.serviceRoots.get('web')!], ['api', apiRoot]]),
    })).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'ANCHOR_SERVICE_REQUIRED' },
    });
  });

  it('rejects an unknown role reference', async () => {
    await expect(validateDokForWrite({
      ...validDok,
      user_actions: {
        steps: [{
          ...validDok.user_actions.steps[0],
          actor: { kind: 'role', role_ref: 'ROLE-GHOST' },
        }],
      },
    }, await context())).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'UNKNOWN_ROLE_REF' },
    });
  });

  it('rejects a filename and Dok ID mismatch', async () => {
    await expect(validateDokForWrite({ ...validDok, dok_id: 'OTHER' }, {
      ...(await context()),
      expectedDokId: 'AUTH',
    })).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'DOK_ID_PATH_MISMATCH' },
    });
  });

  it('rejects model-authored active status at a generated-Dok write boundary', async () => {
    await expect(validateDokForWrite({ ...validDok, status: 'active' }, {
      ...(await context()),
      expectedStatus: 'draft',
    })).rejects.toMatchObject({
      code: 'DOK_TRUST_FAILED',
      details: { reason: 'REVIEW_STATUS_MISMATCH', expectedStatus: 'draft' },
    });
  });

  it('accepts a valid Dok and confirms the anchored file exists', async () => {
    const result = await validateDokForWrite(validDok, await context());
    expect(result.dok_id).toBe('AUTH');
  });
});
