import { homedir } from 'node:os';
import { cp, mkdir, mkdtemp, rm, stat } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import { tmpdir } from 'node:os';
import { simpleGit } from 'simple-git';
import prompts from 'prompts';
import chalk from 'chalk';
import { resolveContainedPath } from '@doklo-beta/core';
import {
  assertSafeTemplateSegment,
  assertTemplateTreeHasNoSymlinks,
  listTemplateDirs,
  parseTemplate,
  resolveTemplatePath,
} from '@doklo-beta/livedoc-engine';
import { CommandContractError } from '../lib/command-result.js';

export interface AddOptions {
  src: string;
  name?: string;
  yes: boolean;
  userHome?: string;
}

function isGitUrl(s: string): boolean {
  return (
    s.startsWith('https://') ||
    s.startsWith('http://') ||
    s.startsWith('git@') ||
    s.startsWith('ssh://') ||
    s.endsWith('.git')
  );
}

export async function addAction(opts: AddOptions): Promise<void> {
  const overrideName = opts.name === undefined
    ? undefined
    : assertSafeTemplateSegment(opts.name, 'template name');
  const templatesRoot = await resolveContainedPath(
    opts.userHome ?? homedir(),
    '.doklo/templates',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  await mkdir(templatesRoot, { recursive: true });

  let sourcePath: string;
  let sourceContainmentRoot: string | undefined;
  let cleanup: (() => Promise<void>) | undefined;

  if (isGitUrl(opts.src)) {
    const work = await mkdtemp(join(tmpdir(), 'doklo-add-'));
    process.stdout.write(chalk.cyan(`Cloning ${opts.src}…\n`));
    await simpleGit().clone(opts.src, work, ['--depth', '1']);
    sourcePath = work;
    sourceContainmentRoot = work;
    cleanup = async () => rm(work, { recursive: true, force: true });
  } else {
    const s = await stat(opts.src).catch(() => null);
    if (!s) {
      throw new CommandContractError({
        schema_version: 1,
        command: 'template add',
        status: 'failed',
        data: null,
        diagnostics: [
          { code: 'TEMPLATE_PATH_NOT_FOUND', message: `Path not found: ${opts.src}` },
        ],
      });
    }
    sourcePath = opts.src;
    sourceContainmentRoot = isAbsolute(opts.src) ? undefined : process.cwd();
  }

  try {
    // Find all template dirs (the source might itself be a template, or a
    // repo with one-or-many template directories).
    let candidates: string[];
    const selfManifest = await resolveTemplatePath(
      sourcePath,
      'doklo-template.json',
      'template source manifest',
      { allowMissingLeaf: true },
    );
    const selfHasManifest = await stat(selfManifest).then(() => true).catch(() => false);
    candidates = selfHasManifest
      ? [sourcePath]
      : await listTemplateDirs(sourcePath, { containmentRoot: sourceContainmentRoot });

    if (candidates.length === 0) {
      throw new CommandContractError({
        schema_version: 1,
        command: 'template add',
        status: 'unsupported',
        data: null,
        diagnostics: [
          {
            code: 'TEMPLATE_MANIFEST_NOT_FOUND',
            message: `No doklo-template.json found in ${opts.src}`,
          },
        ],
      });
    }

    for (const c of candidates) {
      await assertTemplateTreeHasNoSymlinks(c, 'template source');
      const parsed = await parseTemplate(c, { containmentRoot: sourceContainmentRoot });
      const installName = overrideName
        ?? assertSafeTemplateSegment(parsed.manifest.name, 'template name');
      const dest = await resolveTemplatePath(
        templatesRoot,
        installName,
        'template destination',
        { allowMissingLeaf: true, rejectSymlinkLeaf: true },
      );
      const existing = await stat(dest).catch(() => null);

      if (existing && !opts.yes) {
        const a = await prompts({
          type: 'confirm',
          name: 'overwrite',
          message: `Overwrite existing template at ${dest}?`,
          initial: false,
        });
        if (!a.overwrite) {
          process.stdout.write(chalk.yellow(`Skipped ${installName}\n`));
          continue;
        }
        await rm(dest, { recursive: true, force: true });
      } else if (existing) {
        await rm(dest, { recursive: true, force: true });
      }

      await cp(c, dest, { recursive: true });
      process.stdout.write(chalk.green(`✓ Installed ${installName} v${parsed.manifest.version} → ${dest}\n`));
    }
  } finally {
    if (cleanup) await cleanup();
  }
}
