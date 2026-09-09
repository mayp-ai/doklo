import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { renderLivedoc } from '../src/render.js';

const here = dirname(fileURLToPath(import.meta.url));
const builtinRoot = join(here, '..', 'templates');

describe('help-index built-in template', () => {
  it('projects route IA, preserves unplaced topics, and honors link_extension', async () => {
    const root = await workspace(true);
    try {
      const htmlOutput = join(root, 'html-output');
      await renderLivedoc({
        workspaceRoot: root,
        templateRef: 'help-index',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: htmlOutput,
        dokIds: ['AUTH', 'LOOSE'],
        format: 'markdown',
      });

      const htmlIndex = await readFile(
        join(htmlOutput, 'help-index.md'),
        'utf8',
      );
      expect(htmlIndex).toContain('# Find Product Help');
      expect(htmlIndex).toContain('### Sign in');
      expect(htmlIndex).toContain(
        '- [Sign-in help](./AUTH.html)',
      );
      expect(htmlIndex).toContain('## Topics outside navigation');
      expect(htmlIndex).toContain(
        '- [Account help](./LOOSE.html)',
      );

      const markdownOutput = join(root, 'markdown-output');
      await renderLivedoc({
        workspaceRoot: root,
        templateRef: 'help-index',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir: markdownOutput,
        dokIds: ['AUTH', 'LOOSE'],
        format: 'markdown',
        variables: { link_extension: '.md' },
      });
      const markdownIndex = await readFile(
        join(markdownOutput, 'help-index.md'),
        'utf8',
      );
      expect(markdownIndex).toContain(
        '- [Sign-in help](./AUTH.md)',
      );
      expect(markdownIndex).toContain(
        '- [Account help](./LOOSE.md)',
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('honors link_prefix so the index can sit one folder above its articles', async () => {
    const root = await workspace(false);
    try {
      const outDir = join(root, 'prefixed');
      await renderLivedoc({
        workspaceRoot: root,
        templateRef: 'help-index',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir,
        dokIds: ['AUTH', 'LOOSE'],
        format: 'markdown',
        variables: { link_prefix: './pages/' },
      });
      const index = await readFile(join(outDir, 'help-index.md'), 'utf8');
      expect(index).toContain('- [Sign-in help](./pages/AUTH.html)');
      expect(index).toContain('- [Account help](./pages/LOOSE.html)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('warns and falls back to a flat other-topics list without IA', async () => {
    const root = await workspace(false);
    try {
      const outDir = join(root, 'output');
      const result = await renderLivedoc({
        workspaceRoot: root,
        templateRef: 'help-index',
        source: 'builtin',
        builtinRoot,
        locale: 'en',
        outDir,
        dokIds: ['AUTH', 'LOOSE'],
        format: 'markdown',
      });

      expect(result.manifest.warnings).toContainEqual(
        expect.objectContaining({ code: 'MISSING_IA' }),
      );
      const index = await readFile(join(outDir, 'help-index.md'), 'utf8');
      expect(index).toContain('## Topics outside navigation');
      expect(index).toContain('- [Sign-in help](./AUTH.html)');
      expect(index).toContain('- [Account help](./LOOSE.html)');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

async function workspace(withIa: boolean): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'doklo-help-index-'));
  const hubRoot = join(root, '.doklo/hub');
  const doksRoot = join(hubRoot, 'doks');
  await mkdir(doksRoot, { recursive: true });
  await writeJson(join(hubRoot, 'workspace.json'), {
    workspace_id: 'help-index-test',
    name: 'Help Index Test',
    services: [
      {
        service_id: 'web',
        type: 'frontend',
        framework: 'nextjs',
        code_root: '.',
      },
    ],
    default_locale: 'en',
    supported_locales: ['en', 'ko'],
  });
  await Promise.all(
    [
      { dokId: 'AUTH', name: 'Sign-in help', description: 'Sign in safely.' },
      { dokId: 'LOOSE', name: 'Account help', description: 'Manage your account.' },
    ].map(({ dokId, name, description }) =>
      writeJson(join(doksRoot, `${dokId}.json`), {
        dok_id: dokId,
        name,
        status: 'active',
        tags: [],
        surfaces: ['web'],
        description,
        _meta: { version: 1, history: [] },
      }),
    ),
  );

  if (withIa) {
    const serviceRoot = join(hubRoot, 'services/web');
    await mkdir(serviceRoot, { recursive: true });
    await writeJson(join(serviceRoot, 'ia.json'), {
      service_id: 'web',
      version: 2,
      trees: [
        {
          tree_id: 'web-route-hierarchy',
          type: 'route_hierarchy',
          source: 'auto',
          producer: 'doklo-route-hierarchy@1',
          platform: 'all',
          nodes: [
            {
              path: '/auth',
              kind: 'group',
              label: 'Auth',
              curated_fields: [],
              tags: [],
              children: [
                {
                  path: '/auth/signin',
                  kind: 'destination',
                  label: 'Sign in',
                  curated_fields: [],
                  bindings: [{ dok_ref: 'AUTH', source: 'auto' }],
                  evidence: [
                    {
                      kind: 'route_source',
                      file: 'app/auth/signin/page.tsx',
                    },
                  ],
                  tags: [],
                  children: [],
                },
              ],
            },
          ],
        },
      ],
    });
  }

  return root;
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
