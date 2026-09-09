import { homedir } from 'node:os';
import { rm, stat } from 'node:fs/promises';
import chalk from 'chalk';
import { resolveContainedPath } from '@doklo-beta/core';
import { assertSafeTemplateSegment, resolveTemplatePath } from '@doklo-beta/livedoc-engine';
import { CommandContractError } from '../lib/command-result.js';

export type TemplateMutationOptions = {
  name: string;
  userHome?: string;
};

export type RemoveOptions = TemplateMutationOptions;

export async function removeAction(opts: RemoveOptions): Promise<void> {
  const name = assertSafeTemplateSegment(opts.name, 'template name');
  const templatesRoot = await resolveContainedPath(
    opts.userHome ?? homedir(),
    '.doklo/templates',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const rootExists = await stat(templatesRoot)
    .then((value) => value.isDirectory())
    .catch(() => false);
  if (!rootExists) throwTemplateNotInstalled(name);
  const target = await resolveTemplatePath(
    templatesRoot,
    name,
    'template destination',
    { allowMissingLeaf: true, rejectSymlinkLeaf: true },
  );
  const s = await stat(target).catch(() => null);
  if (!s) throwTemplateNotInstalled(name);
  await rm(target, { recursive: true, force: true });
  process.stdout.write(chalk.green(`✓ Removed ${name}\n`));
}

function throwTemplateNotInstalled(name: string): never {
  throw new CommandContractError({
    schema_version: 1,
    command: 'template remove',
    status: 'failed',
    data: null,
    diagnostics: [
      {
        code: 'TEMPLATE_NOT_INSTALLED',
        message:
          `Template '${name}' is not installed under ~/.doklo/templates/. `
          + 'Built-in templates are protected; remove workspace templates by deleting their directory.',
      },
    ],
  });
}
