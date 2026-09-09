import { describe, expect, it } from 'vitest';
import { WorkspaceSchema } from '../src/schemas/workspace.js';

function workspace(codeRoot = 'apps/web') {
  return {
    workspace_id: 'demo',
    name: 'Demo',
    services: [
      {
        service_id: 'web',
        type: 'frontend',
        framework: 'nextjs',
        code_root: codeRoot,
      },
    ],
  };
}

describe('WorkspaceSchema service boundaries', () => {
  it.each([
    '../outside',
    'apps/../../outside',
    '/absolute/service',
    'C:\\absolute\\service',
    'apps/web\0secret',
  ])('rejects unsafe code_root %j', (codeRoot) => {
    expect(WorkspaceSchema.safeParse(workspace(codeRoot)).success).toBe(false);
  });

  it('accepts contained relative code roots and the workspace root', () => {
    expect(WorkspaceSchema.safeParse(workspace('apps/web')).success).toBe(true);
    expect(WorkspaceSchema.safeParse(workspace('.')).success).toBe(true);
  });

  it('rejects duplicate service ids', () => {
    const input = workspace();
    input.services.push({
      ...input.services[0]!,
      code_root: 'apps/admin',
    });

    expect(WorkspaceSchema.safeParse(input).success).toBe(false);
  });
});
