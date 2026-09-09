#!/usr/bin/env node
import { Command } from 'commander';
import { createContext, resolveLocale } from './lib/context.js';
import { resolveVersion } from './lib/version.js';
import { registerAgentCommand } from './commands/agent.js';
import { registerRecordingCommand } from './commands/recording.js';
import { registerInitCommand } from './commands/init.js';
import { registerScanCommand } from './commands/scan.js';
import { registerConsolidateCommand } from './commands/consolidate.js';
import { registerGenerateCommand } from './commands/generate.js';
import { registerEvaluateCommand } from './commands/evaluate.js';
import { registerLexiconSuggestCommand } from './commands/lexicon-suggest.js';
import { registerRolesCommand } from './commands/roles.js';
import { registerShowCommand } from './commands/show.js';
import { registerSyncCommand } from './commands/sync.js';
import { registerServeCommand } from './commands/serve.js';
import { registerMcpCommand } from './commands/mcp.js';
import {
  ensureLiveDocsCommand,
  registerLiveDocsRenderCommand,
} from './commands/live-docs-render.js';
import { registerLiveDocsCaptureCommand } from './commands/live-docs-capture.js';
import { registerPublicationCommands } from './commands/live-docs-publication.js';
import { registerTemplateCommands } from './commands/template-list.js';
import { registerAuthCommand } from './commands/auth.js';
import { registerModelCommand } from './commands/model.js';
import {
  commandExitCode,
  emitCommandResult,
  takeCommandResult,
  toCommandContractError,
} from './lib/command-result.js';

async function main(argv: string[] = process.argv): Promise<void> {
  const ctx = createContext(resolveLocale());

  const program = new Command()
    .name('doklo')
    .description('Doklo v5 (beta) — code → living documentation hub')
    .version(resolveVersion());

  registerInitCommand(program, ctx);
  registerRecordingCommand(program, ctx);
  registerAgentCommand(program, ctx);
  registerScanCommand(program, ctx);
  registerConsolidateCommand(program, ctx);
  registerGenerateCommand(program, ctx);
  registerEvaluateCommand(program, ctx);
  registerLexiconSuggestCommand(program, ctx);
  registerRolesCommand(program, ctx);
  registerShowCommand(program, ctx);
  registerSyncCommand(program, ctx);
  registerServeCommand(program, ctx);
  registerMcpCommand(program, ctx);
  registerLiveDocsRenderCommand(program, ctx);
  registerLiveDocsCaptureCommand(program, ctx);
  registerPublicationCommands(ensureLiveDocsCommand(program));
  registerTemplateCommands(program, ctx);
  registerAuthCommand(program, ctx);
  registerModelCommand(program, ctx);

  const machine = argv.includes('--json') || argv.includes('--progress-json');
  try {
    await program.parseAsync(argv);
    const result = takeCommandResult(program);
    if (result !== undefined) {
      emitCommandResult(result, {
        machine,
        stdout: process.stdout,
        stderr: process.stderr,
      });
      process.exitCode = commandExitCode(result.status);
      return;
    }
    process.exitCode ??= 0;
  } catch (error) {
    const contract = toCommandContractError(error, commandName(argv));
    emitCommandResult(contract.result, {
      machine,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exitCode = contract.exitCode;
  }
}

function commandName(argv: string[]): string {
  const [rootCommand, parentCommand, nestedCommand] = argv.slice(2);
  if (
    rootCommand === 'live-docs'
    && parentCommand === 'publication'
    && (
      nestedCommand === 'create'
      || nestedCommand === 'list'
      || nestedCommand === 'inspect'
      || nestedCommand === 'render'
      || nestedCommand === 'publish'
      || nestedCommand === 'export'
    )
  ) {
    return `live-docs.publication.${nestedCommand}`;
  }
  const candidate = argv.slice(2).find((value) => !value.startsWith('-'));
  if (candidate === 'gen') return 'generate';
  if (candidate === 'eval') return 'evaluate';
  return candidate ?? 'doklo';
}

void main();
