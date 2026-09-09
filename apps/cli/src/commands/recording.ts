import type { Command } from 'commander';
import type { CliContext } from '../lib/context.js';
import { setRecordingBranch } from '../lib/recording-branch.js';
import { loadWorkspaceWithPaths } from '../lib/workspace.js';
import { recordCommandResult } from '../lib/command-result.js';
export function registerRecordingCommand(program: Command, ctx: CliContext): void {
  program.command('recording')
    .description('Inspect or set the product recording branch without reinitializing')
    .option('-r, --root <dir>', 'Project root', process.cwd())
    .option('--branch <branch>', 'Set an existing local branch as the product recording source')
    .option('--json', 'Emit JSONL only', false)
    .action(async opts => {
      if (opts.branch !== undefined) await setRecordingBranch(opts.root, opts.branch);
      const { workspace } = await loadWorkspaceWithPaths(opts.root);
      const branch = workspace.recording_branch ?? null;
      if (!opts.json) console.log(branch ? ctx.t('recording.saved', {branch}) : ctx.t('recording.unset'));
      recordCommandResult(program, {schema_version: 1, command: 'recording', status: 'success', data: {branch}, diagnostics: []});
    });
}
