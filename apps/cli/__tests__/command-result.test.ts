import { describe, expect, it } from 'vitest';
import {
  CommandContractError,
  commandExitCode,
  emitCommandResult,
  requireExplicitApproval,
  toCommandContractError,
  type CommandResult,
} from '../src/lib/command-result.js';

function writer(): Pick<NodeJS.WriteStream, 'write'> & { text(): string } {
  let output = '';
  return {
    write(chunk: string | Uint8Array): boolean {
      output += String(chunk);
      return true;
    },
    text(): string {
      return output;
    },
  };
}

describe('command result contract', () => {
  const failure: CommandResult<null> = {
    schema_version: 1,
    command: 'scan',
    status: 'failed',
    data: null,
    diagnostics: [{ code: 'BROKEN', message: 'parse failed' }],
  };

  it('writes one terminal JSONL result envelope to stdout in machine mode', () => {
    const stdout = writer();
    const stderr = writer();

    emitCommandResult(failure, { machine: true, stdout, stderr });

    expect(stdout.text()).toBe(
      '{"stage":"result","result":{"schema_version":1,"command":"scan","status":"failed","data":null,"diagnostics":[{"code":"BROKEN","message":"parse failed"}]}}\n',
    );
    expect(stderr.text()).toBe('');
  });

  it('keeps human diagnostics on stderr and stdout empty', () => {
    const stdout = writer();
    const stderr = writer();

    emitCommandResult(failure, { machine: false, stdout, stderr });

    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe('BROKEN: parse failed\n');
  });

  it.each([
    ['success', 0],
    ['failed', 1],
    ['partial', 1],
    ['cancelled', 2],
    ['unsupported', 2],
  ] as const)('maps %s to deterministic exit code %i', (status, expected) => {
    expect(commandExitCode(status)).toBe(expected);
  });

  it('rejects a non-TTY command without explicit approval', () => {
    expect(() =>
      requireExplicitApproval({
        command: 'doklo generate',
        yes: false,
        isTTY: false,
      }),
    ).toThrow(
      expect.objectContaining({
        exitCode: 2,
        result: expect.objectContaining({
          command: 'generate',
          status: 'cancelled',
          diagnostics: [
            expect.objectContaining({ code: 'EXPLICIT_APPROVAL_REQUIRED' }),
          ],
        }),
      }),
    );
  });

  it('allows explicit approval and interactive TTY commands', () => {
    expect(() =>
      requireExplicitApproval({ command: 'doklo generate', yes: true, isTTY: false }),
    ).not.toThrow();
    expect(() =>
      requireExplicitApproval({ command: 'doklo generate', yes: false, isTTY: true }),
    ).not.toThrow();
  });

  it('preserves the conventional exit 130 for a structured SIGINT cancellation', () => {
    const result: CommandResult<{ results: { outputPath: string }[] }> = {
      schema_version: 1,
      command: 'generate',
      status: 'cancelled',
      data: { results: [{ outputPath: '.doklo/hub/doks/AUTH.json' }] },
      diagnostics: [{
        code: 'GENERATION_INTERRUPTED',
        message: 'Generation was interrupted.',
        retryable: true,
        preserved: ['.doklo/hub/doks/AUTH.json'],
        nextCommand: 'doklo generate --yes',
      }],
    };

    const contract = new CommandContractError(result, 130);

    expect(contract.exitCode).toBe(130);
    expect(toCommandContractError(contract)).toBe(contract);
  });

  it('normalizes unsupported project errors into exit-2 contracts', () => {
    const contract = toCommandContractError(
      Object.assign(new Error('App Router required'), {
        code: 'UNSUPPORTED_NEXTJS_PROJECT',
      }),
      'init',
    );

    expect(contract).toBeInstanceOf(CommandContractError);
    expect(contract.exitCode).toBe(2);
    expect(contract.result).toMatchObject({
      command: 'init',
      status: 'unsupported',
      diagnostics: [{ code: 'UNSUPPORTED_NEXTJS_PROJECT', message: 'App Router required' }],
    });
  });

  it('renders file-scoped parser details and a valid scan recovery command', () => {
    const contract = toCommandContractError(
      Object.assign(new Error('Parser ledger is incomplete for service "web".'), {
        code: 'PARSER_LEDGER_INCOMPLETE',
        details: {
          serviceId: 'web',
          failedFiles: ['app/broken.tsx', 'app/also-broken.tsx'],
          failures: [
            {
              file: 'app/broken.tsx',
              stages: ['ast'],
              reason: "TS1005 667:34 ';' expected.",
              diagnosticCount: 655,
            },
            {
              file: 'app/also-broken.tsx',
              stages: ['routing'],
              reason: 'Route parser failed.',
              diagnosticCount: 1,
            },
          ],
          preserved: ['.doklo/cache/web.scan.json'],
          nextCommand: 'doklo scan --service web',
        },
      }),
      'scan',
    );

    expect(contract.exitCode).toBe(1);
    expect(contract.result).toMatchObject({
      command: 'scan',
      status: 'partial',
      diagnostics: [
        {
          code: 'PARSER_LEDGER_INCOMPLETE',
          message: "ast: TS1005 667:34 ';' expected. (+654 more diagnostics)",
          serviceId: 'web',
          file: 'app/broken.tsx',
          stages: ['ast'],
          reason: "TS1005 667:34 ';' expected.",
          diagnosticCount: 655,
          preserved: ['.doklo/cache/web.scan.json'],
          nextCommand: 'doklo scan --service web',
        },
        {
          code: 'PARSER_LEDGER_INCOMPLETE',
          message: 'routing: Route parser failed.',
          serviceId: 'web',
          file: 'app/also-broken.tsx',
          stages: ['routing'],
          reason: 'Route parser failed.',
          diagnosticCount: 1,
          preserved: ['.doklo/cache/web.scan.json'],
          nextCommand: 'doklo scan --service web',
        },
      ],
    });

    const stdout = writer();
    const stderr = writer();
    emitCommandResult(contract.result, { machine: false, stdout, stderr });
    expect(stdout.text()).toBe('');
    expect(stderr.text()).toBe(
      'PARSER_LEDGER_INCOMPLETE: ast: TS1005 667:34 \';\' expected. (+654 more diagnostics)\n'
      + '  File: app/broken.tsx\n'
      + '  Next: doklo scan --service web\n'
      + 'PARSER_LEDGER_INCOMPLETE: routing: Route parser failed.\n'
      + '  File: app/also-broken.tsx\n'
      + '  Next: doklo scan --service web\n',
    );
  });

  it('normalizes validation errors into failed contracts', () => {
    const contract = toCommandContractError(
      Object.assign(new Error('Invalid Dok schema'), { name: 'ZodError' }),
      'evaluate',
    );

    expect(contract.exitCode).toBe(1);
    expect(contract.result).toMatchObject({
      command: 'evaluate',
      status: 'failed',
      diagnostics: [{ code: 'VALIDATION_FAILED', message: 'Invalid Dok schema' }],
    });
  });

  it('preserves retryability for confined path identity failures', () => {
    const contract = toCommandContractError(
      Object.assign(new Error('Path identity changed'), {
        code: 'PATH_IDENTITY_CHANGED',
        retryable: true,
      }),
      'live-docs.publication.create',
    );

    expect(contract.result).toMatchObject({
      status: 'failed',
      data: null,
      diagnostics: [
        {
          code: 'PATH_IDENTITY_CHANGED',
          message: 'Path identity changed',
          retryable: true,
        },
      ],
    });
  });

  it('maps a malformed roles preflight to a file-scoped recovery contract', () => {
    const rolesFile = '.doklo/hub/roles.json';
    const contract = toCommandContractError(
      Object.assign(new Error(`Existing roles file is invalid: ${rolesFile}`), {
        name: 'InvalidRolesFileError',
        rolesFile,
      }),
      'generate',
    );

    expect(contract.exitCode).toBe(1);
    expect(contract.result).toMatchObject({
      command: 'generate',
      status: 'failed',
      data: null,
      diagnostics: [{
        code: 'MALFORMED_HUB_FILE',
        file: rolesFile,
        retryable: true,
        preserved: [rolesFile],
        nextCommand: 'doklo generate --yes',
      }],
    });
  });

  it('maps filesystem permission failures to the affected file and retry command', () => {
    const file = '.doklo/hub/doks/AUTH.json';
    const contract = toCommandContractError(
      Object.assign(new Error(`EACCES: permission denied, open '${file}'`), {
        code: 'EACCES',
        path: file,
      }),
      'generate',
    );

    expect(contract.exitCode).toBe(1);
    expect(contract.result).toMatchObject({
      command: 'generate',
      status: 'failed',
      data: null,
      diagnostics: [{
        code: 'PERMISSION_DENIED',
        file,
        retryable: true,
        preserved: [],
        nextCommand: 'doklo generate --yes',
      }],
    });
  });
});
