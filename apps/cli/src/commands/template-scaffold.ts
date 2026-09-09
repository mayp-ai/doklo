// `doklo template scaffold <name>` — generate a starter Live Docs
// template so authoring a new doc type is one command, not manual cp.
//
// This is the "anyone can add a template" lever from the Q5 scenario:
// it drops a valid manifest + body + stylesheet + README into
// .doklo/templates/<name>/ (workspace) or ~/.doklo/templates/<name>/ (user).

import { mkdir, writeFile, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve } from 'node:path';
import chalk from 'chalk';
import { resolveContainedPath } from '@doklo-beta/core';
import { assertSafeTemplateSegment, resolveTemplatePath } from '@doklo-beta/livedoc-engine';

export type ScaffoldScope = 'per_dok' | 'workspace' | 'selected_doks';

export interface ScaffoldOptions {
  name: string;
  scope: ScaffoldScope;
  dest: 'workspace' | 'user';
  root: string;
  force: boolean;
  userHome?: string;
}

async function destRoot(opts: ScaffoldOptions): Promise<string> {
  const root = opts.dest === 'user' ? opts.userHome ?? homedir() : opts.root;
  const templatesRoot = await resolveContainedPath(root, '.doklo/templates', {
    allowMissingLeaf: true,
    rejectSymlinkLeaf: true,
  });
  await mkdir(templatesRoot, { recursive: true });
  return templatesRoot;
}

export async function scaffoldAction(opts: ScaffoldOptions): Promise<number> {
  let name: string;
  try {
    name = assertSafeTemplateSegment(opts.name, 'template name');
  } catch (error) {
    process.stderr.write(
      chalk.red(`✗ Invalid name '${opts.name}'. Use lowercase kebab-case (dots ok): my-template, rfp-2.0\n`),
    );
    throw error;
  }

  const templatesRoot = await destRoot(opts);
  const dir = await resolveTemplatePath(
    templatesRoot,
    name,
    'template destination',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const exists = await stat(dir).then(() => true).catch(() => false);
  if (exists && !opts.force) {
    process.stderr.write(
      chalk.red(`✗ ${dir} already exists. Use --force to overwrite.\n`),
    );
    return 1;
  }

  await mkdir(dir, { recursive: true });
  const assetsDir = await resolveTemplatePath(
    dir,
    'assets',
    'template assets',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  await mkdir(assetsDir, { recursive: true });
  const manifestPath = await resolveTemplatePath(
    dir,
    'doklo-template.json',
    'template manifest',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const entryPath = await resolveTemplatePath(
    dir,
    'template.md.tpl',
    'template entry',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const stylePath = await resolveTemplatePath(
    assetsDir,
    'style.css',
    'template stylesheet',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const readmePath = await resolveTemplatePath(
    dir,
    'README.md',
    'template README',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  await writeFile(manifestPath, manifestStub(opts), 'utf-8');
  await writeFile(entryPath, bodyStub(opts), 'utf-8');
  await writeFile(stylePath, styleStub(), 'utf-8');
  await writeFile(readmePath, readmeStub(opts), 'utf-8');

  process.stdout.write(chalk.green(`✓ Scaffolded template '${opts.name}' → ${dir}\n`));
  process.stdout.write(chalk.dim('\nFiles:\n'));
  process.stdout.write(chalk.dim('  doklo-template.json   manifest (name, scope, output, strings, selector?)\n'));
  process.stdout.write(chalk.dim('  template.md.tpl       Handlebars Markdown body + {{helpers}}\n'));
  process.stdout.write(chalk.dim('  assets/style.css      stylesheet (extends_default_css: false)\n'));
  process.stdout.write(chalk.dim('  README.md             human description\n'));
  process.stdout.write(chalk.cyan(`\nNext:\n`));
  process.stdout.write(chalk.cyan(`  doklo template validate ${dir}\n`));
  const dokFlag = opts.scope === 'workspace' ? '' : ' --dok <DOK-ID>';
  process.stdout.write(chalk.cyan(`  doklo live-docs render ${opts.name}${dokFlag} --locale ko\n`));
  return 0;
}

function manifestStub(opts: ScaffoldOptions): string {
  const isWorkspace = opts.scope === 'workspace';
  const outputBase = isWorkspace ? opts.name : '{{dok.dok_id}}';
  const manifest: Record<string, unknown> = {
    $schema: 'https://doklo.dev/template-manifest-v2.json',
    name: opts.name,
    version: '0.1.0',
    display_name: { en: opts.name, ko: opts.name },
    description: {
      en: `TODO: describe what ${opts.name} produces and who reads it.`,
      ko: `TODO: ${opts.name}가 무엇을 만들고 누가 읽는지 설명하세요.`,
    },
    stability: 'experimental',
    audience: {
      en: 'TODO: identify the intended readers.',
      ko: 'TODO: 대상 독자를 명시하세요.',
    },
    purpose: {
      en: 'TODO: state what this publication explains or proves.',
      ko: 'TODO: 이 산출물이 설명하거나 증명하는 목적을 적으세요.',
    },
    job: {
      en: 'TODO: state the reader job this publication completes.',
      ko: 'TODO: 독자가 이 산출물로 완료할 일을 적으세요.',
    },
    required_input: {
      en: 'TODO: list the reviewed Hub data required for truthful output.',
      ko: 'TODO: 신뢰할 수 있는 출력에 필요한 검토된 Hub 데이터를 적으세요.',
    },
    variables: {},
    author: { name: 'TODO', url: '' },
    license: 'MIT',
    default_format: 'markdown',
    outputs: {
      markdown: {
        entry: 'template.md.tpl',
        output_path: `${outputBase}.md`,
        source: 'markdown',
      },
      html: {
        entry: 'template.md.tpl',
        output_path: `${outputBase}.html`,
        source: 'markdown',
      },
    },
    scope: opts.scope,
    supported_locales: ['en', 'ko'],
    default_locale: 'ko',
    extends_default_css: false,
    strings: {
      ko: { heading: '제목', empty: '아직 내용이 없습니다.' },
      en: { heading: 'Heading', empty: 'Nothing here yet.' },
    },
    requires_hub_layers: ['doks'],
  };
  if (opts.scope === 'selected_doks') {
    manifest.selector = {
      include_tags: ['TODO-tag'],
      exclude_tags: ['internal'],
    };
  }
  return JSON.stringify(manifest, null, 2) + '\n';
}

function bodyStub(opts: ScaffoldOptions): string {
  if (opts.scope === 'workspace') {
    return `# {{translate workspace.name}}

{{len doks}} Doks{{#if workspace.services.length}} · {{len workspace.services}} services{{/if}}

## {{t "heading"}}

{{#each doks}}
- **{{translate this.name}}** — {{translate this.description}}
{{else}}
{{t "empty"}}
{{/each}}
`;
  }
  // per_dok / selected_doks
  return `# {{translate dok.name}}

{{dok.dok_id}}

{{translate dok.description}}

## {{t "heading"}}

{{#if dok.user_actions.steps.length}}
{{#each dok.user_actions.steps}}
1. **{{actor_label this.actor}}** — {{translate this.intent}} → {{translate this.outcome}}
{{/each}}
{{else}}
{{t "empty"}}
{{/if}}
`;
}

function styleStub(): string {
  return `/* ${'='.repeat(56)}
 * Starter stylesheet. extends_default_css: false means this REPLACES
 * the engine default — you own all the styling here.
 * ${'='.repeat(56)} */
@import url('https://cdn.jsdelivr.net/gh/orioncactus/pretendard/dist/web/static/pretendard.css');

:root {
  color-scheme: light dark;
  --bg: #ffffff; --fg: #1f2328; --muted: #6b7280;
  --border: #e5e7eb; --brand: #2563eb; --brand-soft: #eff6ff;
}
@media (prefers-color-scheme: dark) {
  :root { --bg: #0d1117; --fg: #e6edf3; --muted: #8b949e;
          --border: #30363d; --brand: #4493f8; --brand-soft: #0d1b2a; }
}
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--fg);
  font-family: Pretendard, -apple-system, system-ui, sans-serif;
  line-height: 1.7; word-break: keep-all; }
main.livedoc { max-width: 760px; margin: 0 auto; padding: 40px 24px 80px; }

.tpl-hero { padding-bottom: 20px; border-bottom: 2px solid var(--brand); margin-bottom: 32px; }
.tpl-id { font-family: ui-monospace, monospace; font-size: .8em; color: var(--brand); }
.tpl-hero h1 { font-size: 2.2em; font-weight: 800; margin: 6px 0; }
.tpl-sub { color: var(--muted); margin: 0; }
.tpl-section h2 { font-size: 1.4em; margin: 32px 0 14px; }
.tpl-steps { padding-left: 22px; }
.tpl-steps li { margin: 10px 0; }
.tpl-arrow { color: var(--muted); margin: 0 4px; }
.tpl-item { padding: 14px 0; border-bottom: 1px solid var(--border); }
.tpl-empty { color: var(--muted); font-style: italic; background: var(--brand-soft);
  border-radius: 8px; padding: 14px 18px; }
`;
}

function readmeStub(opts: ScaffoldOptions): string {
  return `# ${opts.name}

> Scaffolded by \`doklo template scaffold\`. Edit the TODO markers below, then render.

## What this template produces

TODO: one or two sentences. Who reads it, and where (in-app / email / print / external)?

## Scope

\`${opts.scope}\`${opts.scope === 'selected_doks' ? ' — edit `selector` in doklo-template.json to target the right Doks.' : ''}

## Develop

\`\`\`bash
doklo template validate .doklo/templates/${opts.name}
doklo live-docs render ${opts.name}${opts.scope === 'workspace' ? '' : ' --dok <DOK-ID>'} --locale ko --out-dir /tmp/preview
open /tmp/preview/*.html
\`\`\`

## Helpers available in the body

\`translate\`, \`t\`, \`actor_label\`, \`role_label\`, \`service_label\`, \`format_date\`,
\`unique_actors\`, \`group_doks_by_primary_tag\`, \`limit\`, \`filter_active_with_steps\`,
plus \`add\`/\`sub\`/\`eq\`/\`gt\`/\`lt\`/\`len\`/\`join\`/\`default\`.
`;
}

import type { Command } from 'commander';
import type { CliContext } from '../lib/context.js';
import { CommandContractError } from '../lib/command-result.js';

export function registerTemplateScaffoldCommand(tmpl: Command, _ctx: CliContext): void {
  tmpl
    .command('scaffold <name>')
    .description('Generate a starter template (manifest + body + stylesheet + README)')
    .option('--scope <scope>', 'per_dok | workspace | selected_doks', 'per_dok')
    .option('--user', 'scaffold into ~/.doklo/templates instead of workspace')
    .option('--root <path>', 'workspace root (defaults to cwd)')
    .option('--force', 'overwrite if the template dir already exists')
    .action(async (name: string, opts: { scope?: string; user?: boolean; root?: string; force?: boolean }) => {
      const scope = (opts.scope ?? 'per_dok') as ScaffoldScope;
      if (!['per_dok', 'workspace', 'selected_doks'].includes(scope)) {
        throw new CommandContractError({
          schema_version: 1,
          command: 'template scaffold',
          status: 'failed',
          data: null,
          diagnostics: [
            {
              code: 'INVALID_TEMPLATE_SCOPE',
              message: '--scope must be per_dok | workspace | selected_doks',
            },
          ],
        });
      }
      const code = await scaffoldAction({
        name,
        scope,
        dest: opts.user ? 'user' : 'workspace',
        root: resolve(opts.root ?? process.cwd()),
        force: opts.force ?? false,
      });
      if (code !== 0) {
        throw new CommandContractError({
          schema_version: 1,
          command: 'template scaffold',
          status: 'failed',
          data: null,
          diagnostics: [],
        });
      }
    });
}
