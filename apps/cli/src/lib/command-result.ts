export type CommandStatus =
  | 'success'
  | 'partial'
  | 'cancelled'
  | 'unsupported'
  | 'failed';

export interface CommandDiagnostic {
  code: string;
  message: string;
  /**
   * How loudly a renderer should present this. Ranks entries; it never filters
   * them — a `--json` consumer still receives every diagnostic, whatever tier
   * the underlying Dok landed on.
   */
  severity?: 'high' | 'normal' | 'low';
  retryable?: boolean;
  serviceId?: string;
  file?: string;
  importPath?: string;
  stages?: string[];
  reason?: string;
  diagnosticCount?: number;
  preserved?: string[];
  nextCommand?: string;
}

export interface CommandResult<T> {
  schema_version: 1;
  command: string;
  status: CommandStatus;
  data: T | null;
  diagnostics: CommandDiagnostic[];
}

export class CommandContractError<T = unknown> extends Error {
  readonly result: CommandResult<T>;
  readonly exitCode: 1 | 2 | 130;

  constructor(result: CommandResult<T>, exitCode?: 1 | 2 | 130) {
    super(
      result.diagnostics[0]?.message
        ?? `Command "${result.command}" ended with status "${result.status}".`,
    );
    this.name = 'CommandContractError';
    this.result = result;
    this.exitCode = exitCode ?? nonZeroExitCode(result.status);
  }
}

export interface EmitResultOptions {
  machine: boolean;
  stdout: Pick<NodeJS.WriteStream, 'write'>;
  stderr: Pick<NodeJS.WriteStream, 'write'>;
}

export function commandExitCode(status: CommandStatus): 0 | 1 | 2 {
  if (status === 'success') return 0;
  if (status === 'failed' || status === 'partial') return 1;
  return 2;
}

export function emitCommandResult<T>(
  result: CommandResult<T>,
  { machine, stdout, stderr }: EmitResultOptions,
): void {
  if (machine) {
    stdout.write(`${JSON.stringify({ stage: 'result', result })}\n`);
    return;
  }
  for (const diagnostic of result.diagnostics) {
    stderr.write(`${diagnostic.code}: ${diagnostic.message}\n`);
    if (diagnostic.file) stderr.write(`  File: ${diagnostic.file}\n`);
    if (diagnostic.nextCommand) stderr.write(`  Next: ${diagnostic.nextCommand}\n`);
  }
}

export function requireExplicitApproval(input: {
  command: string;
  yes: boolean;
  isTTY: boolean;
}): void {
  if (input.yes || input.isTTY) return;

  const command = normalizeCommandName(input.command);
  throw new CommandContractError({
    schema_version: 1,
    command,
    status: 'cancelled',
    data: null,
    diagnostics: [
      {
        code: 'EXPLICIT_APPROVAL_REQUIRED',
        message: `${input.command} requires --yes when stdin is not a TTY.`,
      },
    ],
  });
}

export function toCommandContractError(
  error: unknown,
  command = 'doklo',
): CommandContractError {
  if (error instanceof CommandContractError) return error;

  const message = error instanceof Error ? error.message : String(error);
  const name = error instanceof Error ? error.name : '';
  const record = isRecord(error) ? error : {};
  const rawCode = typeof record['code'] === 'string' ? record['code'] : undefined;
  const retryable = record['retryable'] === true;

  if (
    command === 'generate'
    && name === 'InvalidRolesFileError'
    && typeof record['rolesFile'] === 'string'
  ) {
    const file = record['rolesFile'];
    return new CommandContractError({
      schema_version: 1,
      command,
      status: 'failed',
      data: null,
      diagnostics: [{
        code: 'MALFORMED_HUB_FILE',
        message,
        retryable: true,
        file,
        preserved: [file],
        nextCommand: 'doklo generate --yes',
      }],
    });
  }

  if (command === 'generate' && (rawCode === 'EACCES' || rawCode === 'EPERM')) {
    const file = typeof record['path'] === 'string' ? record['path'] : undefined;
    return new CommandContractError({
      schema_version: 1,
      command,
      status: 'failed',
      data: null,
      diagnostics: [{
        code: 'PERMISSION_DENIED',
        message,
        retryable: true,
        ...(file === undefined ? {} : { file }),
        preserved: [],
        nextCommand: 'doklo generate --yes',
      }],
    });
  }

  if (
    name === 'WorkspaceNotInitializedError'
    || rawCode === 'WORKSPACE_NOT_INITIALIZED'
  ) {
    return new CommandContractError({
      schema_version: 1,
      command,
      status: 'failed',
      data: null,
      diagnostics: [{
        code: 'WORKSPACE_NOT_INITIALIZED',
        message,
        nextCommand: 'doklo init',
      }],
    });
  }

  if (
    rawCode === 'UNSUPPORTED_RUNTIME'
    || rawCode === 'UNSUPPORTED_FRAMEWORK'
    || rawCode === 'UNSUPPORTED_NEXTJS_PROJECT'
  ) {
    return new CommandContractError({
      schema_version: 1,
      command,
      status: 'unsupported',
      data: null,
      diagnostics: [{ code: rawCode, message }],
    });
  }

  if (rawCode === 'PARSER_LEDGER_INCOMPLETE') {
    const details = isRecord(record['details']) ? record['details'] : {};
    const failedFiles = stringArray(details['failedFiles']);
    const failures = parserLedgerFailures(details['failures']);
    const preserved = stringArray(details['preserved']);
    const diagnosticInputs: ParserLedgerFailure[] = failures.length > 0
      ? failures
      : (failedFiles.length > 0 ? failedFiles : [undefined]).map((file) => ({ file }));
    const diagnostics: CommandDiagnostic[] = diagnosticInputs.map((failure) => ({
      code: rawCode,
      message: failure.reason === undefined
        ? message
        : parserLedgerMessage(failure),
      ...(typeof details['serviceId'] === 'string'
        ? { serviceId: details['serviceId'] }
        : {}),
      ...(failure.file !== undefined ? { file: failure.file } : {}),
      ...(failure.stages !== undefined ? { stages: failure.stages } : {}),
      ...(failure.reason !== undefined ? { reason: failure.reason } : {}),
      ...(failure.diagnosticCount !== undefined
        ? { diagnosticCount: failure.diagnosticCount }
        : {}),
      ...(preserved.length > 0 ? { preserved } : {}),
      ...(typeof details['nextCommand'] === 'string'
        ? { nextCommand: details['nextCommand'] }
        : {}),
    }));
    return new CommandContractError({
      schema_version: 1,
      command,
      status: 'partial',
      data: null,
      diagnostics,
    });
  }

  const validationFailure =
    name === 'ZodError'
    || name.startsWith('Invalid')
    || rawCode === 'VALIDATION_FAILED';
  return new CommandContractError({
    schema_version: 1,
    command,
    status: 'failed',
    data: null,
    diagnostics: [
      {
        code: validationFailure ? 'VALIDATION_FAILED' : (rawCode ?? 'COMMAND_FAILED'),
        message,
        ...(retryable ? { retryable: true } : {}),
      },
    ],
  });
}

const commandResults = new WeakMap<object, CommandResult<unknown>>();

export function recordCommandResult<T>(owner: object, result: CommandResult<T>): void {
  commandResults.set(owner, result);
}

export function takeCommandResult(owner: object): CommandResult<unknown> | undefined {
  const result = commandResults.get(owner);
  commandResults.delete(owner);
  return result;
}

function normalizeCommandName(command: string): string {
  return command.trim().replace(/^doklo(?:\s+|$)/, '') || 'doklo';
}

function nonZeroExitCode(status: CommandStatus): 1 | 2 {
  const code = commandExitCode(status);
  return code === 2 ? 2 : 1;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string')
    : [];
}

interface ParserLedgerFailure {
  file?: string;
  stages?: string[];
  reason?: string;
  diagnosticCount?: number;
}

function parserLedgerFailures(value: unknown): ParserLedgerFailure[] {
  if (!Array.isArray(value)) return [];
  const failures: ParserLedgerFailure[] = [];
  for (const item of value) {
    if (!isRecord(item)) continue;
    if (typeof item['file'] !== 'string' || item['file'].length === 0) continue;
    if (typeof item['reason'] !== 'string') continue;
    const stages = stringArray(item['stages']);
    const diagnosticCount = item['diagnosticCount'];
    if (!Number.isInteger(diagnosticCount) || (diagnosticCount as number) < 1) continue;
    failures.push({
      file: item['file'],
      stages,
      reason: item['reason'],
      diagnosticCount: diagnosticCount as number,
    });
  }
  return failures;
}

function diagnosticSummary(reason: string, diagnosticCount: number | undefined): string {
  return diagnosticCount !== undefined && diagnosticCount > 1
    ? `${reason} (+${diagnosticCount - 1} more diagnostics)`
    : reason;
}

function parserLedgerMessage(failure: ParserLedgerFailure): string {
  const summary = diagnosticSummary(failure.reason ?? '', failure.diagnosticCount);
  return failure.stages && failure.stages.length > 0
    ? `${failure.stages.join(', ')}: ${summary}`
    : summary;
}
