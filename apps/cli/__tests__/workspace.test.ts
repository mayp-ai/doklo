import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadWorkspace, WorkspaceNotInitializedError } from '../src/lib/workspace.js';

async function tmpRoot(): Promise<string> {
  return await mkdtemp(join(tmpdir(), 'doklo-ws-'));
}

const validWorkspace = {
  workspace_id: 'demo',
  name: 'Demo',
  services: [
    {
      service_id: 'web',
      type: 'frontend',
      framework: 'nextjs',
      code_root: '.',
    },
  ],
  default_locale: 'en',
  supported_locales: ['en'],
};

describe('loadWorkspace', () => {
  it('parses workspace.json into a typed Workspace', async () => {
    const root = await tmpRoot();
    await writeFile(join(root, 'workspace.json'), JSON.stringify(validWorkspace), 'utf-8');
    const ws = await loadWorkspace(root);
    expect(ws.workspace_id).toBe('demo');
    expect(ws.services).toHaveLength(1);
    expect(ws.services[0]?.framework).toBe('nextjs');
  });

  it('throws WorkspaceNotInitializedError when workspace.json missing', async () => {
    const root = await tmpRoot();
    await expect(loadWorkspace(root)).rejects.toThrowError(
      WorkspaceNotInitializedError,
    );
  });

  it('throws on schema-invalid workspace.json (caller sees the Zod message)', async () => {
    const root = await tmpRoot();
    await writeFile(
      join(root, 'workspace.json'),
      JSON.stringify({ workspace_id: '', services: 'not-an-array' }),
      'utf-8',
    );
    await expect(loadWorkspace(root)).rejects.toThrow();
  });

  it('rejects malformed JSON (caller sees a clear error)', async () => {
    const root = await tmpRoot();
    await writeFile(join(root, 'workspace.json'), '{ not json', 'utf-8');
    await expect(loadWorkspace(root)).rejects.toThrow();
  });

  it('searches upward when root is a child directory of the workspace', async () => {
    const root = await tmpRoot();
    await writeFile(join(root, 'workspace.json'), JSON.stringify(validWorkspace), 'utf-8');
    const child = join(root, 'src', 'pages');
    await mkdir(child, { recursive: true });
    const ws = await loadWorkspace(child);
    expect(ws.workspace_id).toBe('demo');
  });
});
