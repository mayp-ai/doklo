import { access, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  renderLivedocMock,
  routeTmpRoot,
  seenOutputDirs,
} = vi.hoisted(() => ({
  renderLivedocMock: vi.fn(),
  routeTmpRoot: `/tmp/doklo-wizard-livedoc-route-${process.pid}`,
  seenOutputDirs: new Set<string>(),
}));

vi.mock('node:os', () => ({
  tmpdir: () => routeTmpRoot,
}));

vi.mock('../lib/data', () => ({
  workspaceRoot: () => '/workspace',
  loadWorkspace: vi.fn(async () => ({ default_locale: 'en' })),
  loadLexicon: vi.fn(async () => ({ terms: [], version: 1 })),
  listDoks: vi.fn(async () => [{ dok_id: 'AUTH-SIGNIN', name: 'Auth' }]),
}));

vi.mock('@doklo-beta/livedoc-engine', () => ({
  renderLivedoc: renderLivedocMock,
}));

function renderRequest(): Request {
  return new Request('http://localhost/api/wizard/livedoc', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ ref: 'saas-prd', locale: 'en', dok: 'AUTH-SIGNIN' }),
  });
}

describe('wizard livedoc route', () => {
  beforeEach(async () => {
    await rm(routeTmpRoot, { recursive: true, force: true });
    await mkdir(routeTmpRoot, { recursive: true });
    seenOutputDirs.clear();
    renderLivedocMock.mockReset();
    renderLivedocMock.mockImplementation(async (input: {
      outDir: string;
      format?: string;
    }) => {
      if (input.format !== 'html') {
        throw new Error(`expected explicit html format, received ${String(input.format)}`);
      }
      if (seenOutputDirs.has(input.outDir)) {
        throw new Error(`output exists: ${input.outDir}`);
      }
      seenOutputDirs.add(input.outDir);
      await mkdir(input.outDir, { recursive: true });
      const output = join(input.outDir, 'AUTH-SIGNIN.html');
      await writeFile(output, '<html><body>Auth</body></html>');
      return { outputs: [{ format: 'html', path: output }] };
    });
  });

  afterEach(async () => {
    await rm(routeTmpRoot, { recursive: true, force: true });
  });

  it('renders repeated requests in isolated disposable output directories', async () => {
    const { POST } = await import('../app/api/wizard/livedoc/route');

    const first = await POST(renderRequest());
    const second = await POST(renderRequest());

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(await first.json()).toMatchObject({
      kind: 'html',
      html: expect.stringContaining('<body>Auth</body>'),
      filename: 'en-AUTH-SIGNIN.html',
    });
    expect([...seenOutputDirs]).toHaveLength(2);
    for (const outDir of seenOutputDirs) {
      await expect(access(outDir)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });
});
