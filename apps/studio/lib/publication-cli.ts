import { spawn as nodeSpawn } from 'node:child_process';
import { TextDecoder } from 'node:util';

const STDERR_TAIL_LIMIT = 800;

export type PublicationCliOperation =
  | { kind: 'list' }
  | { kind: 'inspect'; name: string }
  | { kind: 'create'; name: string; args: string[] }
  | {
      kind: 'render';
      name: string;
      overwrite: boolean;
      dryRun: boolean;
    }
  | { kind: 'publish'; name: string; dryRun: boolean }
  | { kind: 'export'; name: string; zipPath?: string };

export type PublicationCommandDiagnostic = {
  code: string;
  message: string;
  retryable?: boolean;
  nextCommand?: string;
};

export type PublicationCommandResult = {
  schema_version: 1;
  command: string;
  status:
    | 'success'
    | 'partial'
    | 'cancelled'
    | 'unsupported'
    | 'failed';
  data: Record<string, unknown> | unknown[] | null;
  diagnostics: PublicationCommandDiagnostic[];
  stderr_tail: string;
};

export interface PublicationCliChild {
  stdout: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  };
  stderr: {
    on(event: 'data', listener: (chunk: Buffer | string) => void): void;
  };
  on(event: 'close', listener: (code: number | null) => void): void;
  on(event: 'error', listener: (error: Error) => void): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface PublicationCliDeps {
  spawn: (
    command: string,
    args: string[],
    options: {
      cwd: string;
      env: NodeJS.ProcessEnv;
      shell: false;
    },
  ) => PublicationCliChild;
}

export class PublicationCliProtocolError extends Error {
  readonly code = 'PUBLICATION_CLI_PROTOCOL_INVALID';

  constructor(message = 'Publication CLI produced invalid machine output') {
    super(message);
    this.name = 'PublicationCliProtocolError';
  }
}

export async function runPublicationCli(
  input: {
    cliBin: string;
    root: string;
    operation: PublicationCliOperation;
    signal?: AbortSignal;
  },
  deps: PublicationCliDeps = {
    spawn: (command, args, options) =>
      nodeSpawn(command, args, options) as PublicationCliChild,
  },
): Promise<PublicationCommandResult> {
  const args = [
    input.cliBin,
    'live-docs',
    'publication',
    ...operationArgs(input.operation),
    '--json',
    '--root',
    input.root,
  ];

  return new Promise<PublicationCommandResult>((resolve, reject) => {
    const child = deps.spawn(process.execPath, args, {
      cwd: input.root,
      env: {
        ...process.env,
        FORCE_COLOR: '0',
        NO_COLOR: '1',
      },
      shell: false,
    });
    const stdoutDecoder = new TextDecoder('utf-8', { fatal: true });
    const stderrDecoder = new TextDecoder('utf-8', { fatal: false });
    let stdout = '';
    let stderrTail = '';
    let childError: Error | undefined;
    let interrupted = false;

    const interrupt = () => {
      if (interrupted) return;
      interrupted = true;
      child.kill('SIGINT');
    };
    const onAbort = () => interrupt();
    if (input.signal?.aborted) onAbort();
    else input.signal?.addEventListener('abort', onAbort, { once: true });

    child.stdout.on('data', (chunk) => {
      try {
        stdout += stdoutDecoder.decode(toBuffer(chunk), { stream: true });
      } catch {
        interrupt();
      }
    });
    child.stderr.on('data', (chunk) => {
      stderrTail = (
        stderrTail
        + stderrDecoder.decode(toBuffer(chunk), { stream: true })
      ).slice(-STDERR_TAIL_LIMIT);
    });
    child.on('error', (error) => {
      childError ??= error;
    });
    child.on('close', (code) => {
      input.signal?.removeEventListener('abort', onAbort);
      if (childError) {
        reject(childError);
        return;
      }
      try {
        stdout += stdoutDecoder.decode();
        stderrTail = (
          stderrTail + stderrDecoder.decode()
        ).slice(-STDERR_TAIL_LIMIT);
        const result = parseTerminalResult(stdout);
        assertExitMatchesResult(code, result);
        resolve({
          ...result,
          diagnostics: result.diagnostics.map(sanitizeDiagnostic),
          stderr_tail: stderrTail,
        });
      } catch (error) {
        reject(error instanceof PublicationCliProtocolError
          ? error
          : new PublicationCliProtocolError());
      }
    });
  });
}

function operationArgs(operation: PublicationCliOperation): string[] {
  switch (operation.kind) {
    case 'list':
      return ['list'];
    case 'inspect':
      return ['inspect', operation.name];
    case 'create':
      return ['create', operation.name, ...operation.args];
    case 'render':
      return [
        'render',
        operation.name,
        ...(operation.overwrite ? ['--overwrite'] : []),
        ...(operation.dryRun ? ['--dry-run'] : []),
      ];
    case 'publish':
      return [
        'publish',
        operation.name,
        ...(operation.dryRun ? ['--dry-run'] : []),
      ];
    case 'export':
      return [
        'export',
        operation.name,
        ...(operation.zipPath ? ['--zip-path', operation.zipPath] : []),
      ];
  }
}

function parseTerminalResult(stdout: string): Omit<
  PublicationCommandResult,
  'stderr_tail'
> {
  const lines = stdout.split('\n').filter((line) => line.trim().length > 0);
  if (lines.length !== 1) throw new PublicationCliProtocolError();
  let value: unknown;
  try {
    value = JSON.parse(lines[0]!);
  } catch {
    throw new PublicationCliProtocolError();
  }
  if (!isRecord(value) || value.stage !== 'result') {
    throw new PublicationCliProtocolError();
  }
  const result = value.result;
  if (
    !isRecord(result)
    || result.schema_version !== 1
    || typeof result.command !== 'string'
    || !isStatus(result.status)
    || !(
      result.data === null
      || isRecord(result.data)
      || Array.isArray(result.data)
    )
    || !Array.isArray(result.diagnostics)
    || !result.diagnostics.every(isDiagnostic)
  ) {
    throw new PublicationCliProtocolError();
  }
  return result as Omit<PublicationCommandResult, 'stderr_tail'>;
}

function assertExitMatchesResult(
  code: number | null,
  result: Omit<PublicationCommandResult, 'stderr_tail'>,
): void {
  if (code === 0 && result.status !== 'success') {
    throw new PublicationCliProtocolError();
  }
  if (code !== 0 && result.status === 'success') {
    throw new PublicationCliProtocolError();
  }
}

function sanitizeDiagnostic(
  diagnostic: PublicationCommandDiagnostic,
): PublicationCommandDiagnostic {
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.retryable === undefined
      ? {}
      : { retryable: diagnostic.retryable }),
  };
}

function isDiagnostic(value: unknown): value is PublicationCommandDiagnostic {
  return isRecord(value)
    && typeof value.code === 'string'
    && typeof value.message === 'string'
    && (
      value.retryable === undefined
      || typeof value.retryable === 'boolean'
    )
    && (
      value.nextCommand === undefined
      || typeof value.nextCommand === 'string'
    );
}

function isStatus(
  value: unknown,
): value is PublicationCommandResult['status'] {
  return value === 'success'
    || value === 'partial'
    || value === 'cancelled'
    || value === 'unsupported'
    || value === 'failed';
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function toBuffer(value: Buffer | string): Buffer {
  return typeof value === 'string' ? Buffer.from(value, 'utf8') : value;
}
