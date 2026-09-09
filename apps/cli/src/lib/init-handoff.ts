import type { CliContext } from './context.js';
import { runServe, studioOpenUrl } from '../commands/serve.js';
import { DEFAULT_STUDIO_PORT, pickStudioPort } from './studio-port.js';

export type InitHandoffChoice = 'browser' | 'terminal';

export async function runInitHandoff(
  input: { root: string; ctx: CliContext },
  deps: {
    choose: () => Promise<InitHandoffChoice | symbol>;
    serve: typeof runServe;
    write: (message: string) => void;
    /** Port preflight, injected for tests. Defaults to the real picker. */
    pickPort?: typeof pickStudioPort;
  },
): Promise<InitHandoffChoice | 'browser-unavailable' | 'cancelled'> {
  const choice = await deps.choose();
  if (typeof choice === 'symbol') return 'cancelled';

  if (choice === 'terminal') {
    deps.write(input.ctx.t('init.handoff_cli_next'));
    return 'terminal';
  }

  const pickPort = deps.pickPort ?? pickStudioPort;
  try {
    // Pick the port before announcing the URL so the message is truthful —
    // a stale server on 4321 used to crash Studio right after "Opening …".
    const picked = await pickPort(DEFAULT_STUDIO_PORT);
    if (picked.fallback) {
      deps.write(
        input.ctx.t('init.handoff_port_fallback', {
          preferred: DEFAULT_STUDIO_PORT,
          port: picked.port,
        }),
      );
    }
    deps.write(
      input.ctx.t('init.handoff_opening', {
        url: studioOpenUrl(picked.port, '/onboarding'),
      }),
    );
    await deps.serve({
      root: input.root,
      port: picked.port,
      open: true,
      openPath: '/onboarding',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    deps.write(input.ctx.t('init.handoff_failed', { message }));
    deps.write(input.ctx.t('init.handoff_recovery', { path: input.root }));
    return 'browser-unavailable';
  }
  return 'browser';
}
