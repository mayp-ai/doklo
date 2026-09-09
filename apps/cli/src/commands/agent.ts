import { Option, type Command } from 'commander';
import type { CliContext } from '../lib/context.js';
import { AgentSkillError, manageAgentSkill } from '../lib/agent-skill.js';
import { CommandContractError, recordCommandResult } from '../lib/command-result.js';

export function registerAgentCommand(program: Command, ctx: CliContext): void {
  const agent = program.command('agent').description(ctx.t('agent.description'));
  for (const action of ['setup', 'remove'] as const) {
    agent.command(action)
      .description(ctx.t(`agent.${action}_description`))
      .addOption(new Option('--target <client>', ctx.t('agent.target')).choices(['claude-code', 'codex']).makeOptionMandatory())
      .option('-r, --root <dir>', ctx.t('agent.root'), process.cwd())
      .option('--preview', ctx.t('agent.preview'), false)
      .option('--json', ctx.t('agent.json'), false)
      .action(async (opts: { root: string; target: string; preview: boolean; json: boolean }) => {
        try {
          const result = await manageAgentSkill({ ...opts, action });
          if (!opts.json) {
            for (const file of result.files) {
              console.log(ctx.t(file.status === 'preview' ? 'agent.preview_result' : `agent.${file.status}`, { path: file.path }));
              if (opts.preview) console.log(file.content);
            }
            if (action === 'setup') console.log(ctx.t('agent.discovery_note'));
          }
          recordCommandResult(program, {
            schema_version: 1, command: `agent.${action}`, status: 'success',
            data: result, diagnostics: [],
          });
        } catch (error) {
          if (!(error instanceof AgentSkillError)) throw error;
          throw new CommandContractError({
            schema_version: 1, command: `agent.${action}`, status: 'failed', data: null,
            diagnostics: [{ code: `agent.${error.code}`, message: ctx.t(`agent.${error.code}`, { path: error.path }), file: error.path }],
          });
        }
      });
  }
}
