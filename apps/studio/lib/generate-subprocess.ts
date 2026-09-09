// Bridge: run the built CLI `generate --progress-json` as a subprocess and
// forward its JSONL progress events. Spawning (not importing) the CLI avoids
// bundling its native @napi-rs/keyring dep into the Next route.

import { TextDecoder } from 'node:util';
import { doneCounters } from './generate-progress';

const INVALID_MACHINE_OUTPUT = 'generate produced invalid machine output';

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isOptionalString(value: unknown): boolean {
  return value === undefined || typeof value === 'string';
}

interface CommandDiagnostic {
  code: string;
  message: string;
  retryable?: boolean;
  serviceId?: string;
  file?: string;
  preserved?: string[];
  nextCommand?: string;
}

interface CommandResultEnvelope {
  schema_version: 1;
  command: 'generate' | 'llm';
  status: 'success' | 'partial' | 'cancelled' | 'unsupported' | 'failed';
  data: Record<string, unknown> | null;
  diagnostics: CommandDiagnostic[];
}

type ParsedMachineLine =
  | { kind: 'progress'; event: Record<string, unknown> }
  | { kind: 'result'; result: CommandResultEnvelope };

function isCommandDiagnostic(value: unknown): value is CommandDiagnostic {
  if (!isRecord(value)) return false;
  return (
    typeof value.code === 'string'
    && typeof value.message === 'string'
    && (value.retryable === undefined || typeof value.retryable === 'boolean')
    && isOptionalString(value.serviceId)
    && isOptionalString(value.file)
    && isOptionalString(value.nextCommand)
    && (
      value.preserved === undefined
      || (Array.isArray(value.preserved) && value.preserved.every((file) => typeof file === 'string'))
    )
  );
}

function isCommandResultEnvelope(value: Record<string, unknown>): value is Record<string, unknown> & {
  result: CommandResultEnvelope;
} {
  const result = value.result;
  if (!isRecord(result)) return false;
  const status = result.status;
  const command = result.command;
  return (
    result.schema_version === 1
    && (
      command === 'generate'
      || (command === 'llm' && status !== 'success')
    )
    && (
      status === 'success'
      || status === 'partial'
      || status === 'cancelled'
      || status === 'unsupported'
      || status === 'failed'
    )
    && (result.data === null || isRecord(result.data))
    && Array.isArray(result.diagnostics)
    && result.diagnostics.every(isCommandDiagnostic)
  );
}

function parseMachineLine(line: string): ParsedMachineLine | null {
  const t = line.trim();
  if (!t) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t) as unknown;
  } catch {
    throw new Error(INVALID_MACHINE_OUTPUT);
  }
  if (!isRecord(parsed)) throw new Error(INVALID_MACHINE_OUTPUT);
  if (parsed.stage === 'result') {
    if (!isCommandResultEnvelope(parsed)) throw new Error(INVALID_MACHINE_OUTPUT);
    return { kind: 'result', result: parsed.result };
  }
  if (typeof parsed.stage !== 'string' || parsed.stage.length === 0) {
    throw new Error(INVALID_MACHINE_OUTPUT);
  }
  return { kind: 'progress', event: parsed };
}

export function parseProgressLine(line: string): Record<string, unknown> | null {
  const parsed = parseMachineLine(line);
  return parsed?.kind === 'progress' ? parsed.event : null;
}

const CREDENTIAL_DIAGNOSTIC_CODES = new Set([
  'MISSING_CREDENTIALS',
  'RUNTIME_TRUST_CREDENTIAL_REQUIRED',
]);

const SAFE_RECOVERY_COMMANDS = new Set([
  'doklo auth',
  'doklo generate --yes',
]);

function sanitizedDiagnostic(diagnostic: CommandDiagnostic): CommandDiagnostic {
  const nextCommand = CREDENTIAL_DIAGNOSTIC_CODES.has(diagnostic.code)
    ? 'doklo auth'
    : (
      diagnostic.nextCommand !== undefined
      && SAFE_RECOVERY_COMMANDS.has(diagnostic.nextCommand)
        ? diagnostic.nextCommand
        : undefined
    );
  return {
    code: diagnostic.code,
    message: diagnostic.message,
    ...(diagnostic.retryable === undefined ? {} : { retryable: diagnostic.retryable }),
    ...(diagnostic.serviceId === undefined ? {} : { serviceId: diagnostic.serviceId }),
    ...(diagnostic.file === undefined ? {} : { file: diagnostic.file }),
    ...(diagnostic.preserved === undefined ? {} : { preserved: [...diagnostic.preserved] }),
    ...(nextCommand === undefined ? {} : { nextCommand }),
  };
}

function commandResultError(result: CommandResultEnvelope): Record<string, unknown> {
  const diagnostics = result.diagnostics.map(sanitizedDiagnostic);
  const primary = diagnostics[0];
  const nextCommand = primary?.nextCommand;
  const baseMessage = primary?.message.trim()
    || `Generate ended with status "${result.status}".`;
  const message = nextCommand === undefined
    ? baseMessage
    : `${baseMessage} Run \`${nextCommand}\` and retry.`;
  return {
    stage: 'error',
    message,
    ...(primary === undefined ? {} : {
      code: primary.code,
      ...(primary.retryable === undefined ? {} : { retryable: primary.retryable }),
      ...(primary.serviceId === undefined ? {} : { serviceId: primary.serviceId }),
      ...(primary.file === undefined ? {} : { file: primary.file }),
      ...(primary.preserved === undefined ? {} : { preserved: primary.preserved }),
      ...(primary.nextCommand === undefined ? {} : { nextCommand: primary.nextCommand }),
    }),
    diagnostics,
  };
}

export interface CliChild {
  stdout: {
    on(ev: 'data', cb: (chunk: Buffer | string) => void): void;
    removeListener?(ev: 'data', cb: (chunk: Buffer | string) => void): void;
  };
  stderr?: {
    on(ev: 'data', cb: (chunk: Buffer | string) => void): void;
    removeListener?(ev: 'data', cb: (chunk: Buffer | string) => void): void;
  };
  on(ev: 'close', cb: (code: number | null) => void): void;
  on(ev: 'error', cb: (err: Error) => void): void;
  removeListener?(ev: 'close' | 'error', cb: ((code: number | null) => void) | ((err: Error) => void)): void;
  kill(signal?: NodeJS.Signals): boolean;
}

export interface StreamCliDeps {
  spawn: (
    cmd: string,
    args: string[],
    opts: { cwd?: string; env?: NodeJS.ProcessEnv },
  ) => CliChild;
}

export interface StreamCliOptions {
  cliBin: string;
  root: string;
  service: string;
  signal?: AbortSignal;
}

function doneFailureMessage(event: Record<string, unknown>): string | null {
  const counters = doneCounters(event);
  if (!counters) return 'Generate returned an invalid completion summary.';
  const { failed, layerFailed } = counters;
  const failures: string[] = [];
  if (failed > 0) failures.push(`${failed} Dok${failed === 1 ? '' : 's'} failed`);
  if (layerFailed > 0) {
    failures.push(`${layerFailed} layer${layerFailed === 1 ? '' : 's'} failed`);
  }
  return failures.length > 0
    ? `Generate completed with ${failures.join(' and ')}.`
    : null;
}

/** Spawn the current Node runtime with `generate --progress-json --yes`,
 *  split stdout into lines, and emit each JSONL progress event. Resolves when
 *  the child exits. Every non-empty stdout line must satisfy the machine-output contract. */
export async function streamCliGenerate(
  opts: StreamCliOptions,
  emit: (event: Record<string, unknown>) => unknown,
  deps: StreamCliDeps,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = deps.spawn(
      process.execPath,
      [
        opts.cliBin,
        'generate',
        '--progress-json',
        '--yes',
        '--service',
        opts.service,
        '--root',
        opts.root,
      ],
      { cwd: opts.root },
    );

    const stdoutDecoder = new TextDecoder('utf-8', { fatal: true });
    let buf = '';
    let doneFailure: string | null | undefined;
    let childError: Error | null = null;
    let stderrTail = '';
    let settled = false;
    let aborted = false;
    let interrupted = false;
    let delivery: Promise<void> | null = null;
    let deliveryFailed = false;
    let deliveryError: unknown;
    let protocolError: string | null = null;
    let commandResult: CommandResultEnvelope | null = null;

    const interrupt = () => {
      if (settled || interrupted) return;
      interrupted = true;
      child.kill('SIGINT');
    };
    const rememberDeliveryFailure = (error: unknown) => {
      if (deliveryFailed) return;
      deliveryFailed = true;
      deliveryError = error;
      interrupt();
    };
    const rememberProtocolFailure = () => {
      if (protocolError) return;
      protocolError = INVALID_MACHINE_OUTPUT;
      interrupt();
    };
    const rememberDelivery = (pending: Promise<void>) => {
      delivery = pending;
      void pending.then(
        () => {
          if (delivery === pending) delivery = null;
        },
        (error) => {
          rememberDeliveryFailure(error);
          if (delivery === pending) delivery = null;
        },
      );
      return pending;
    };

    const forward = (event: Record<string, unknown>): Promise<void> => {
      // A first delivery failure is authoritative. Later stdout can still
      // arrive before SIGINT closes the child, but must not create fresh
      // rejected promises for an EventEmitter caller that cannot await them.
      if (deliveryFailed) return Promise.resolve();
      if (event.stage === 'done') {
        const message = doneFailureMessage(event);
        // Keep the first done summary, but let any later failed duplicate win.
        // The close handler remains the sole owner of the terminal event.
        if (doneFailure === undefined || message) doneFailure = message;
      }
      if (delivery) {
        return rememberDelivery(delivery.then(() => emit(event)).then(() => undefined));
      }
      try {
        const result = emit(event);
        if (result && typeof (result as PromiseLike<unknown>).then === 'function') {
          return rememberDelivery(Promise.resolve(result).then(() => undefined));
        }
        return Promise.resolve();
      } catch (error) {
        return rememberDelivery(Promise.reject(error));
      }
    };

    const drain = (flush: boolean) => {
      let nl: number;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (protocolError || !line.trim()) continue;
        try {
          const parsed = parseMachineLine(line);
          if (parsed?.kind === 'result') {
            if (commandResult !== null) rememberProtocolFailure();
            else commandResult = parsed.result;
          } else if (parsed?.kind === 'progress') {
            if (commandResult !== null) rememberProtocolFailure();
            else void forward(parsed.event).catch(() => {});
          }
        } catch {
          rememberProtocolFailure();
        }
      }
      if (flush && buf.trim()) {
        const line = buf;
        buf = '';
        if (protocolError) return;
        try {
          const parsed = parseMachineLine(line);
          if (parsed?.kind === 'result') {
            if (commandResult !== null) rememberProtocolFailure();
            else commandResult = parsed.result;
          } else if (parsed?.kind === 'progress') {
            if (commandResult !== null) rememberProtocolFailure();
            else void forward(parsed.event).catch(() => {});
          }
        } catch {
          rememberProtocolFailure();
        }
      }
    };

    const onStdout = (chunk: Buffer | string) => {
      if (protocolError) return;
      try {
        buf += stdoutDecoder.decode(
          typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk,
          { stream: true },
        );
        drain(false);
      } catch {
        rememberProtocolFailure();
      }
    };
    const onStderr = (chunk: Buffer | string) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-800);
    };
    const onError = (err: Error) => {
      if (!settled && !childError) childError = err;
    };
    const onAbort = () => {
      if (settled) return;
      aborted = true;
      interrupt();
    };
    const cleanup = () => {
      child.stdout.removeListener?.('data', onStdout);
      child.stderr?.removeListener?.('data', onStderr);
      child.removeListener?.('error', onError);
      child.removeListener?.('close', onClose);
      opts.signal?.removeEventListener('abort', onAbort);
    };
    const finish = async (code: number | null) => {
      try {
        if (delivery) await delivery.catch(() => {});
        if (deliveryFailed) {
          cleanup();
          reject(deliveryError);
          return;
        }
        if (!aborted) {
          const tail = stderrTail.trim().split('\n').pop() ?? '';
          if (childError) {
            await forward({ stage: 'error', message: childError.message });
          } else if (protocolError) {
            await forward({ stage: 'error', message: protocolError });
          } else if (commandResult !== null && commandResult.status !== 'success') {
            await forward(commandResultError(commandResult));
          } else if (code !== 0) {
            await forward({
              stage: 'error',
              message: `generate exited ${code}${tail ? `: ${tail}` : ''}`,
            });
          } else if (doneFailure === undefined) {
            await forward({
              stage: 'error',
              message: 'generate produced no output',
            });
          } else if (doneFailure) {
            await forward({ stage: 'error', message: doneFailure });
          } else {
            await forward({ stage: 'clean-close' });
          }
        }
        cleanup();
        resolve();
      } catch (error) {
        cleanup();
        reject(error);
      }
    };
    const onClose = (code: number | null) => {
      if (settled) return;
      settled = true;
      if (!protocolError) {
        try {
          buf += stdoutDecoder.decode();
        } catch {
          rememberProtocolFailure();
        }
      }
      drain(true);
      void finish(code);
    };

    child.stdout.on('data', onStdout);
    child.stderr?.on('data', onStderr);
    child.on('error', onError);
    child.on('close', onClose);
    if (opts.signal?.aborted) onAbort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
  });
}
