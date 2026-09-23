// `doklo init` — bootstrap a workspace.
//
// runInit() is the non-interactive entrypoint (testable, used by the
// commander wrapper). The CLI registration in this file collects missing
// fields via @clack/prompts and then delegates to runInit.

import { listRecordingBranches, validateRecordingBranch } from '../lib/recording-branch.js';
import { AgentSkillError, manageAgentSkill, type AgentSkillResult, type AgentTarget } from '../lib/agent-skill.js';
import type { Command } from 'commander';
import { access } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import type { Framework, Service, ServiceType } from '@doklo-beta/core';
import { detectFramework } from '../lib/framework.js';
import { bootstrapWorkspace, WorkspaceAlreadyInitializedError } from '../lib/bootstrap.js';
import { workspacePaths, type WorkspacePaths } from '../lib/paths.js';
import type { CliContext } from '../lib/context.js';
import { PROVIDER_ENV, loadConfig, saveConfig, setRoleModel } from '../lib/config.js';
import { buildProviderChoices, buildModelChoices, toModelOption } from './model.js';
import { modelGuidance } from '../lib/model-guidance.js';
import { loadModelsDb, getCost } from '@doklo-beta/generator';
import { authenticateProvider } from '../lib/authenticate.js';
import { runScan } from './scan.js';
import type { runServe } from './serve.js';
import type { runInitHandoff } from '../lib/init-handoff.js';
import {
  assertSupportedRuntimeProject,
} from '../lib/runtime-support.js';
import {
  CommandContractError,
  recordCommandResult,
  requireExplicitApproval,
} from '../lib/command-result.js';

/** Returns provider ids whose env key is set to a non-empty value. */
export function detectConfiguredProviders(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.entries(PROVIDER_ENV)
    .filter(([, k]) => (env[k] ?? '') !== '')
    .map(([provider]) => provider);
}

export interface RunInitOptions {
  root: string;
  workspaceId: string;
  name: string;
  defaultLocale: string;
  supportedLocales: string[];
  serviceId: string;
  /** Optional override; otherwise auto-detected from package.json. */
  framework?: Framework;
  recordingBranch?: string;
}

export interface RunInitResult {
  framework: Framework;
  paths: WorkspacePaths;
  agentSkills: Array<AgentSkillResult | { target: AgentTarget; status: 'failed'; code: string }>;
}

const FRAMEWORK_TYPE: Record<Framework, ServiceType> = {
  // Frontend
  nextjs: 'frontend',
  'react-vite': 'frontend',
  vue: 'frontend',
  nuxt: 'frontend',
  svelte: 'frontend',
  sveltekit: 'frontend',
  angular: 'frontend',
  // Mobile
  'react-native': 'mobile',
  flutter: 'mobile',
  // Backend
  'spring-boot': 'backend',
  nestjs: 'backend',
  express: 'backend',
  fastify: 'backend',
  fastapi: 'backend',
  django: 'backend',
  rails: 'backend',
  aspnet: 'backend',
  // Catch-all — assume frontend (most common starting point).
  unknown: 'frontend',
};

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  const support = await assertSupportedRuntimeProject(opts.root);
  const framework = opts.framework ?? support.framework;

  const service: Service = {
    service_id: opts.serviceId,
    type: FRAMEWORK_TYPE[framework],
    framework,
    code_root: '.',
  };

  if (opts.recordingBranch !== undefined) await validateRecordingBranch(opts.root, opts.recordingBranch);

  await bootstrapWorkspace({
    root: opts.root,
    workspaceId: opts.workspaceId,
    name: opts.name,
    defaultLocale: opts.defaultLocale,
    supportedLocales: opts.supportedLocales,
    services: [service],
    recordingBranch: opts.recordingBranch,
  });

  // Initialization remains usable if a client directory is protected or customized.
  // Report each outcome; never overwrite user-owned skill content.
  const agentSkills: RunInitResult['agentSkills'] = [];
  for (const target of ['claude-code', 'codex'] as const) {
    try {
      agentSkills.push(await manageAgentSkill({ root: opts.root, target, action: 'setup' }));
    } catch (error) {
      agentSkills.push({ target, status: 'failed', code: error instanceof AgentSkillError ? error.code : 'write_failed' });
    }
  }
  return { framework, paths: workspacePaths(opts.root), agentSkills };
}

function printAgentSkills(result: RunInitResult, ctx: CliContext): void {
  for (const skill of result.agentSkills) {
    if (skill.status === 'failed') {
      console.error(ctx.t('init.agent_failed', { target: skill.target, code: skill.code }));
    } else {
      for (const file of skill.files) console.log(ctx.t(`agent.${file.status}`, { path: file.path }));
    }
  }
  console.log(ctx.t('agent.discovery_note'));
}

/** Best-effort post-init scan: runs the deterministic scan and returns
 * aggregate counts, or null if scanning fails (init must still succeed — the
 * workspace/hub is already written by bootstrap). */
export async function postInitScan(
  root: string,
  deps: { runScan?: typeof runScan } = {},
): Promise<{ services: number; routes: number; components: number } | null> {
  const scan = deps.runScan ?? runScan;
  try {
    const res = await scan({ root });
    let routes = 0;
    let components = 0;
    for (const r of res.results) {
      routes += r.counts.routes;
      components += r.counts.components;
    }
    return { services: res.results.length, routes, components };
  } catch {
    return null;
  }
}

/** Runs `postInitScan` and prints the summary (or a best-effort warning),
 * unless the user passed `--no-scan`. Shared by the --yes and interactive
 * paths below. */
async function maybePrintScanSummary(
  root: string,
  scanOpt: boolean,
  ctx: CliContext,
  machine = false,
): Promise<void> {
  if (scanOpt === false) return;
  const { default: chalk } = await import('chalk');
  const summary = await postInitScan(root);
  if (machine) return;
  if (summary) {
    console.log(
      '  ' +
        chalk.green('✓') +
        ' ' +
        ctx.t('init.scan_summary', {
          services: summary.services,
          routes: summary.routes,
          components: summary.components,
        }),
    );
  } else {
    console.error('  ' + chalk.yellow('!') + ' ' + ctx.t('init.scan_failed'));
  }
}

// ───────── Interactive wrapper (commander) ──────────────────────────

export interface RegisterInitCommandDeps {
  handoff?: typeof runInitHandoff;
  serve?: typeof runServe;
}

export function registerInitCommand(
  program: Command,
  ctx: CliContext,
  _deps: RegisterInitCommandDeps = {},
): void {

  program
    .command('init')
    .description('Initialize a new doklo workspace in the current directory')
    .option('-r, --root <dir>', 'Project root', process.cwd())
    .option('-y, --yes', 'Accept all defaults (non-interactive)', false)
    .option('--json', 'Emit JSONL only', false)
    .option('--recording-branch <branch>', 'Branch used for product records (explicit; no automatic checkout)')
    .option('--name <name>', 'Workspace display name')
    .option('--workspace-id <id>', 'Workspace id (kebab-case)')
    .option('--service-id <id>', 'Service id', 'web')
    .option('--default-locale <locale>', 'Default locale for business text (en|ko)')
    .option(
      '--supported-locales <list>',
      'Comma-separated list of UI locales (e.g., en,ko)',
    )
    .option('--model <ref>', 'Model to set as default (provider/model-id)')
    .option('--no-scan', 'Skip the automatic code scan after init', true)
    .action(async (opts) => {
      const { intro, outro, cancel, isCancel, text, select, autocomplete, log } =
        await import('@clack/prompts');
      const { default: chalk } = await import('chalk');

      const root = opts.root as string;
      const machine = opts.json === true;

      // Fail fast before the interactive wizard: if the workspace already
      // exists, bootstrapWorkspace would throw anyway — but only after the
      // user has filled out every prompt. Surface it up front instead.
      const workspaceFile = workspacePaths(root).workspaceFile;
      if (await fileExists(workspaceFile)) {
        throw new WorkspaceAlreadyInitializedError(workspaceFile);
      }

      const detected = await detectFramework(root);
      // A monorepo root carries no `next` dependency, so detection fails here
      // while the app sits one directory down. Name the apps instead of
      // leaving the user at "framework unknown".
      await assertSupportedRuntimeProject(root);
      requireExplicitApproval({
        command: 'doklo init',
        yes: opts.yes === true,
        isTTY: !machine && process.stdin.isTTY === true,
      });

      const defaults = {
        name: opts.name ?? guessName(root),
        workspaceId: opts.workspaceId ?? toKebab(opts.name ?? guessName(root)),
        defaultLocale: opts.defaultLocale ?? ctx.locale,
        supportedLocales:
          opts.supportedLocales ?? `${ctx.locale},${ctx.locale === 'en' ? 'ko' : 'en'}`,
        serviceId: opts.serviceId ?? 'web',
      };

      const modelDefaultRef = opts.model as string | undefined;

      // ── Non-interactive path (--yes or CI) ───────────────────────
      // Deliberately ahead of the models.dev registry load below: `--yes`
      // shows no picker, so it must not depend on the network. An offline or
      // firewalled machine still gets a workspace.
      if (opts.yes) {
        const result = await runInit({
          root,
          workspaceId: defaults.workspaceId,
          name: defaults.name,
          defaultLocale: defaults.defaultLocale,
          supportedLocales: defaults.supportedLocales.split(',').map((s: string) => s.trim()).filter(Boolean),
          serviceId: defaults.serviceId,
          framework: detected,
          recordingBranch: opts.recordingBranch,
        });

        if (modelDefaultRef) {
          await saveConfig(setRoleModel(await loadConfig(), 'default', modelDefaultRef));
        }

        await maybePrintScanSummary(root, opts.scan as boolean, ctx, machine);

        if (!machine) {
          printAgentSkills(result, ctx);
          outro(ctx.t('init.complete', { path: result.paths.workspaceFile }));
          log.info(ctx.t('init.next_step_cli'));
        }
        recordCommandResult(program, {
          schema_version: 1,
          command: 'init',
          status: 'success',
          data: result,
          diagnostics: [],
        });
        return;
      }

      // ── Interactive path ─────────────────────────────────────────
      // Two-step model picker (provider first, then model). Choices come from
      // the models.dev db; load it once and reuse for both steps. Only the
      // interactive path needs it, so the fetch lives here.
      // The registry is metadata, not a dependency of initialization: a
      // total failure (no network *and* no cached copy) degrades the model
      // step instead of failing the command.
      const db = await loadModelsDb().catch(() => null);
      const providerChoices = db === null ? [] : buildProviderChoices(db);
      // Preselect the first env-configured provider when present.
      const detectedProviders = detectConfiguredProviders();
      const autoProvider = detectedProviders.find((p) =>
        providerChoices.some((c) => c.value === p),
      );

      intro(ctx.t('init.welcome'));

      log.info(ctx.t('init.framework_detected', { framework: detected }));

      // 1. Workspace name
      const name = await text({
        message: ctx.t('init.workspace_name'),
        initialValue: defaults.name,
        validate: (v) => (!v?.trim() ? 'Name cannot be empty.' : undefined),
      });
      if (isCancel(name)) {
        cancel(ctx.t('init.welcome'));
        throw commandCancelled('init');
      }

      // 2. Workspace ID
      const workspaceId = await text({
        message: ctx.t('init.workspace_id'),
        initialValue: defaults.workspaceId,
        validate: (v) =>
          v && /^[a-z0-9][a-z0-9-]*$/.test(v) ? undefined : 'kebab-case (a-z, 0-9, hyphen)',
      });
      if (isCancel(workspaceId)) {
        cancel(ctx.t('init.welcome'));
        throw commandCancelled('init');
      }

      // 3. Default locale
      const defaultLocale = await select({
        message: ctx.t('init.default_locale'),
        options: [
          { value: 'en', label: 'en (English)' },
          { value: 'ko', label: 'ko (Korean)' },
        ],
        initialValue: defaults.defaultLocale === 'ko' ? 'ko' : 'en',
      });
      if (isCancel(defaultLocale)) {
        cancel(ctx.t('init.welcome'));
        throw commandCancelled('init');
      }

      // 4. Supported locales
      const supportedLocalesRaw = await text({
        message: ctx.t('init.supported_locales'),
        initialValue: defaults.supportedLocales,
        validate: (v) => (!v?.trim() ? 'At least one locale is required.' : undefined),
      });
      if (isCancel(supportedLocalesRaw)) {
        cancel(ctx.t('init.welcome'));
        throw commandCancelled('init');
      }

      // 5. Service ID
      const serviceId = await text({
        message: ctx.t('init.service_id'),
        initialValue: defaults.serviceId,
        validate: (v) => (!v?.trim() ? 'Service ID cannot be empty.' : undefined),
      });
      if (isCancel(serviceId)) {
        cancel(ctx.t('init.welcome'));
        throw commandCancelled('init');
      }

      // 6. Model picker — Step A: provider
      let pickedModel: string | undefined = modelDefaultRef;
      let pickedProvider: string | undefined;

      if (db === null) {
        // Both picker steps are driven by the registry, so without it there
        // is no honest list to choose from and no provider worth
        // authenticating. Initialization is not blocked by that: the
        // workspace is what `init` promises, and the model is configurable
        // afterwards.
        log.warn(ctx.t('init.model_registry_unavailable'));
      } else {
        const providerInitialIdx = autoProvider
          ? providerChoices.findIndex((c) => c.value === autoProvider)
          : 0;

        // Three-step state machine: 'provider' → 'model' → 'auth'.
        //   ESC at model        → back to provider
        //   ESC at auth method  → back to model  (authenticateProvider returns null)
        let wizardStep: 'provider' | 'model' | 'auth' = 'provider';
        wizardLoop: while (true) {
          if (wizardStep === 'provider') {
            const prov = await select({
              message: ctx.t('init.pick_provider'),
              options: providerChoices.map((c) => ({ value: c.value, label: c.title })),
              initialValue:
                providerInitialIdx >= 0
                  ? providerChoices[providerInitialIdx]?.value
                  : providerChoices[0]?.value,
            });
            if (isCancel(prov)) {
              cancel(ctx.t('init.welcome'));
              throw commandCancelled('init');
            }
            pickedProvider = prov as string;
            wizardStep = 'model';
          }

          if (wizardStep === 'model') {
            const prov = pickedProvider as string;
            const modelRef = await autocomplete({
              message: `${prov} · ${ctx.t('init.pick_model')} ${ctx.t('common.esc_back')}`,
              options: buildModelChoices(db, prov).map((c) => toModelOption(c, ctx.t)),
              placeholder: 'type to search',
              initialValue: pickedModel ?? modelDefaultRef,
            });
            if (isCancel(modelRef)) {
              // ESC at model → back to provider
              wizardStep = 'provider';
              continue wizardLoop;
            }
            pickedModel = modelRef as string;
            wizardStep = 'auth';
          }

          // wizardStep === 'auth'
          // pickedProvider is always set when we reach this step.
          const provForAuth = pickedProvider as string;
          log.step(ctx.t('init.auth_intro', { provider: provForAuth }));
          const authResult = await authenticateProvider(provForAuth, {
            profile: 'default',
            ctx,
          });
          if (authResult === null) {
            // ESC at auth method step → back to model picker
            wizardStep = 'model';
            continue wizardLoop;
          }
          break wizardLoop;
        }

        // pickedProvider is always set after the wizard loop breaks.
        if (!pickedProvider) throw new Error('invariant: pickedProvider is undefined after wizard loop');

        // Benchmark-informed model guidance (shown after model+auth are confirmed)
        if (pickedModel) {
          const guidance = modelGuidance(pickedModel, getCost(db, pickedModel));
          if (guidance.tier === 'warned' && guidance.messageKey) {
            log.warn(ctx.t(guidance.messageKey, { model: pickedModel }));
          } else if (guidance.tier === 'recommended' && guidance.messageKey) {
            log.success(chalk.dim(ctx.t(guidance.messageKey)));
          } else if (guidance.messageKey === 'model.weak_warning') {
            log.warn(ctx.t(guidance.messageKey, { model: pickedModel }));
          }
        }
      }

      let recordingBranch = opts.recordingBranch as string | undefined;
      if (recordingBranch === undefined) {
        const branches = await listRecordingBranches(root);
        if (branches.length > 0) {
          const picked = await select({
            message: ctx.t('recording.choose'),
            options: [
              ...branches.map(branch => ({ value: branch, label: branch })),
              { value: '', label: ctx.t('recording.later') },
            ],
          });
          if (isCancel(picked)) { cancel(ctx.t('common.cancelled')); return; }
          recordingBranch = String(picked) || undefined;
        }
      }

      // ── Bootstrap workspace ──────────────────────────────────────
      const supportedLocales = String(supportedLocalesRaw)
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);

      const result = await runInit({
        root,
        workspaceId: workspaceId as string,
        name: name as string,
        defaultLocale: defaultLocale as string,
        supportedLocales,
        serviceId: serviceId as string,
        framework: detected,
        recordingBranch,
      });

      // Persist chosen model to ~/.config/doklo/config.json (outside runInit
      // so existing runInit tests are unaffected).
      if (pickedModel) {
        await saveConfig(setRoleModel(await loadConfig(), 'default', pickedModel));
      }

      await maybePrintScanSummary(root, opts.scan as boolean, ctx, machine);

      if (!machine) {
        printAgentSkills(result, ctx);
        outro(ctx.t('init.complete', { path: result.paths.workspaceFile }));
        log.info(ctx.t('init.next_step_cli'));
      }
      recordCommandResult(program, {
        schema_version: 1,
        command: 'init',
        status: 'success',
        data: result,
        diagnostics: [],
      });
    });
}

function commandCancelled(command: string): CommandContractError {
  return new CommandContractError({
    schema_version: 1,
    command,
    status: 'cancelled',
    data: null,
    diagnostics: [{ code: 'COMMAND_CANCELLED', message: `${command} was cancelled.` }],
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await access(path, FS.F_OK);
    return true;
  } catch {
    return false;
  }
}

function guessName(root: string): string {
  const parts = root.split('/').filter(Boolean);
  return parts[parts.length - 1] ?? 'doklo-workspace';
}

function toKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
