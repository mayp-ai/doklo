import { EventEmitter } from 'node:events';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createContext } from '../src/lib/context.js';

const { spawnMock, pickStudioPortMock, waitForStudioReadyMock } = vi.hoisted(
  () => ({
    spawnMock: vi.fn(),
    pickStudioPortMock: vi.fn(),
    waitForStudioReadyMock: vi.fn(),
  }),
);

vi.mock('node:child_process', () => ({ spawn: spawnMock }));
vi.mock('../src/lib/studio-port.js', () => ({
  DEFAULT_STUDIO_PORT: 4321,
  pickStudioPort: pickStudioPortMock,
  waitForStudioReady: waitForStudioReadyMock,
}));

import { registerServeCommand } from '../src/commands/serve.js';

// A real, minimal workspace on disk — not Studio's bundled demo. `serve`
// must be exercised against the thing users actually point it at.
function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'doklo-serve-'));
  mkdirSync(join(root, '.doklo', 'hub'), { recursive: true });
  writeFileSync(
    join(root, 'workspace.json'),
    JSON.stringify({
      workspace_id: 'serve-fixture',
      name: 'serve-fixture',
      services: [
        { service_id: 'web', type: 'frontend', framework: 'nextjs', code_root: '.' },
      ],
      default_locale: 'en',
      supported_locales: ['en'],
    }),
  );
  return root;
}

const workspaceRoot = makeWorkspace();
/** A directory with no workspace.json anywhere above it. */
const bareRoot = mkdtempSync(join(tmpdir(), 'doklo-bare-'));

afterAll(() => {
  rmSync(workspaceRoot, { recursive: true, force: true });
  rmSync(bareRoot, { recursive: true, force: true });
});

type ChildStub = EventEmitter & {
  kill: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
};

function childStub(): ChildStub {
  const child = new EventEmitter() as ChildStub;
  child.kill = vi.fn();
  child.unref = vi.fn();
  return child;
}

/** spawn stub whose child exits cleanly right away. */
function exitingSpawn(): void {
  spawnMock.mockImplementation(() => {
    const child = childStub();
    queueMicrotask(() => child.emit('exit', 0));
    return child;
  });
}

function registeredServeCommand(): Command {
  const program = new Command();
  registerServeCommand(program, createContext('en'));
  const command = program.commands.find(
    (candidate) => candidate.name() === 'serve',
  );
  if (!command) throw new Error('serve command was not registered');
  return command;
}

beforeEach(() => {
  spawnMock.mockReset();
  pickStudioPortMock.mockReset();
  pickStudioPortMock.mockResolvedValue({ port: 4321, fallback: false });
  waitForStudioReadyMock.mockReset();
  waitForStudioReadyMock.mockResolvedValue(false);
});

describe('serve command production entry', () => {
  it('describes --open as opening the real workspace Hub', () => {
    const command = registeredServeCommand();
    const option = command.options.find(
      (candidate) => candidate.long === '--open',
    );

    expect(option?.description).toBe(
      'Open the real workspace Hub in your browser',
    );
  });

  it('prints the workspace Hub as the startup entry', async () => {
    exitingSpawn();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      await program.parseAsync(
        ['serve', '--root', workspaceRoot, '--port', '4321'],
        { from: 'user' },
      );

      const output = consoleLog.mock.calls.flat().join(' ');
      expect(output).toContain('http://localhost:4321/doks');
      expect(output).toContain('— workspace Hub');
      expect(output).not.toContain('/onboarding');
    } finally {
      consoleLog.mockRestore();
    }
  });
});

describe('serve command port preflight', () => {
  it('picks the default port flexibly when --port is not given', async () => {
    exitingSpawn();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      await program.parseAsync(['serve', '--root', workspaceRoot], { from: 'user' });
    } finally {
      consoleLog.mockRestore();
    }

    expect(pickStudioPortMock).toHaveBeenCalledWith(4321, { strict: false });
  });

  it('requires the exact port when --port is passed explicitly', async () => {
    exitingSpawn();
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      await program.parseAsync(
        ['serve', '--root', workspaceRoot, '--port', '5000'],
        { from: 'user' },
      );
    } finally {
      consoleLog.mockRestore();
    }

    expect(pickStudioPortMock).toHaveBeenCalledWith(5000, { strict: true });
  });

  it('shows the real port and a fallback notice in the banner when 4321 is busy', async () => {
    exitingSpawn();
    pickStudioPortMock.mockResolvedValue({ port: 4322, fallback: true });
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      await program.parseAsync(['serve', '--root', workspaceRoot], { from: 'user' });

      const output = consoleLog.mock.calls.flat().join(' ');
      expect(output).toContain('Port 4321 is in use — using 4322 instead.');
      expect(output).toContain('http://localhost:4322/doks');
      expect(output).not.toContain('http://localhost:4321/doks');
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('fails before printing the banner or spawning when a strict port is busy', async () => {
    pickStudioPortMock.mockRejectedValue(
      new Error('Port 5000 is already in use. Stop the process using it, or pass --port to choose another port.'),
    );
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      await expect(
        program.parseAsync(['serve', '--root', workspaceRoot, '--port', '5000'], {
          from: 'user',
        }),
      ).rejects.toThrow(/already in use/);
      expect(consoleLog).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });
});

describe('serve workspace preflight', () => {
  it('fails before printing the banner when the directory has no workspace', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      await expect(
        program.parseAsync(['serve', '--root', bareRoot], { from: 'user' }),
      ).rejects.toThrow(/no Doklo workspace/i);
      // The banner prints a live URL. Printing it for a run that cannot
      // start sends the user to a port nothing is listening on.
      expect(consoleLog).not.toHaveBeenCalled();
      expect(spawnMock).not.toHaveBeenCalled();
      expect(pickStudioPortMock).not.toHaveBeenCalled();
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('names the directory and the two commands that lead to a Hub', async () => {
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    try {
      const failure = await program
        .parseAsync(['serve', '--root', bareRoot], { from: 'user' })
        .then(() => null, (error: unknown) => error as Error);

      expect(failure).toBeInstanceOf(Error);
      const message = failure?.message ?? '';
      expect(message).toContain(bareRoot);
      expect(message).toContain('doklo init');
      expect(message).toContain('doklo generate');
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('reports the workspace-not-initialized code, not a generic failure', async () => {
    const { toCommandContractError } = await import('../src/lib/command-result.js');
    const { WorkspaceNotInitializedError } = await import('../src/lib/workspace.js');

    const contract = toCommandContractError(
      new WorkspaceNotInitializedError('/nowhere'),
      'serve',
    );

    expect(contract.result.diagnostics[0]?.code).toBe('WORKSPACE_NOT_INITIALIZED');
    expect(contract.result.diagnostics[0]?.nextCommand).toBe('doklo init');
  });
});

describe('serve --open readiness gate', () => {
  it('opens the browser only after the studio answers HTTP', async () => {
    const studio = childStub();
    const opens: string[] = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'open' || cmd === 'xdg-open' || cmd === 'cmd') {
        opens.push(String(args.at(-1)));
        return childStub();
      }
      return studio;
    });
    let releaseReady!: (ready: boolean) => void;
    waitForStudioReadyMock.mockImplementation(
      () =>
        new Promise<boolean>((resolve) => {
          releaseReady = resolve;
        }),
    );
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    const done = program.parseAsync(['serve', '--root', workspaceRoot, '--open'], {
      from: 'user',
    });
    try {
      await vi.waitFor(() =>
        expect(waitForStudioReadyMock).toHaveBeenCalledWith(
          'http://localhost:4321/doks',
          expect.objectContaining({ signal: expect.any(AbortSignal) }),
        ),
      );
      expect(opens).toEqual([]); // still starting up — nothing opened yet

      releaseReady(true);
      await vi.waitFor(() =>
        expect(opens).toEqual(['http://localhost:4321/doks']),
      );

      studio.emit('exit', 0);
      await done;
    } finally {
      consoleLog.mockRestore();
    }
  });

  it('never opens the browser when the studio exits before it is ready', async () => {
    const studio = childStub();
    const opens: string[] = [];
    spawnMock.mockImplementation((cmd: string, args: string[]) => {
      if (cmd === 'open' || cmd === 'xdg-open' || cmd === 'cmd') {
        opens.push(String(args.at(-1)));
        return childStub();
      }
      return studio;
    });
    // Honor the abort contract: resolve false when the caller aborts.
    waitForStudioReadyMock.mockImplementation(
      (_url: string, opts: { signal: AbortSignal }) =>
        new Promise<boolean>((resolve) => {
          opts.signal.addEventListener('abort', () => resolve(false), {
            once: true,
          });
        }),
    );
    const consoleLog = vi.spyOn(console, 'log').mockImplementation(() => {});
    const program = new Command();
    registerServeCommand(program, createContext('en'));

    const done = program.parseAsync(['serve', '--root', workspaceRoot, '--open'], {
      from: 'user',
    });
    try {
      await vi.waitFor(() => expect(waitForStudioReadyMock).toHaveBeenCalled());
      studio.emit('exit', 0); // dies before ever answering HTTP
      await done;
      await new Promise((resolve) => setImmediate(resolve)); // flush open path
      expect(opens).toEqual([]);
    } finally {
      consoleLog.mockRestore();
    }
  });
});
