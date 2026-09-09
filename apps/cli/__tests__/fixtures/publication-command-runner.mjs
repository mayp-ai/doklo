import { Command } from 'commander';
import { registerPublicationCommands } from '../../src/commands/live-docs-publication.ts';
import {
  commandExitCode,
  emitCommandResult,
  takeCommandResult,
  toCommandContractError,
} from '../../src/lib/command-result.ts';

const argv = process.argv.slice(2);
const machine = argv.includes('--json') || argv.includes('--progress-json');
const program = new Command().name('doklo').exitOverride();
const liveDocs = program.command('live-docs');
registerPublicationCommands(liveDocs);

try {
  await program.parseAsync(argv, { from: 'user' });
  const result = takeCommandResult(program);
  if (result) {
    emitCommandResult(result, {
      machine,
      stdout: process.stdout,
      stderr: process.stderr,
    });
    process.exitCode = commandExitCode(result.status);
  }
} catch (error) {
  const contract = toCommandContractError(error, 'live-docs.publication');
  emitCommandResult(contract.result, {
    machine,
    stdout: process.stdout,
    stderr: process.stderr,
  });
  process.exitCode = contract.exitCode;
}
