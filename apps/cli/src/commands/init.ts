// `doklo init` — bootstrap a workspace.
//
// runInit() is the non-interactive entrypoint (testable, used by the
// commander wrapper). The CLI registration in this file collects missing
// fields via @clack/prompts and then delegates to runInit.

import { listRecordingBranches, validateRecordingBranch } from '../lib/recording-branch.js';
import { AgentSkillError, manageAgentSkill, type AgentSkillResult, type AgentTarget } from '../lib/agent-skill.js';
import { Option, type Command } from 'commander';
import { access, stat } from 'node:fs/promises';
import { constants as FS } from 'node:fs';
import { basename, relative, resolve, sep } from 'node:path';
import type { Framework, KoreanCustomerTone, Service, ServiceType } from '@doklo-beta/core';
import { bootstrapWorkspace, WorkspaceAlreadyInitializedError } from '../lib/bootstrap.js';
import { workspacePaths, type WorkspacePaths } from '../lib/paths.js';
import type { CliContext } from '../lib/context.js';
import { PROVIDER_ENV, loadConfig, saveConfig, setRoleModel } from '../lib/config.js';
import { buildProviderChoices, buildModelChoices, toModelOption } from './model.js';
import { modelGuidance } from '../lib/model-guidance.js';
import { loadModelsDb, getCost, resolveContainedPath } from '@doklo-beta/generator';
import { authenticateProvider } from '../lib/authenticate.js';
import { formatScanAnalysis, runScan, type ScanAnalysis } from './scan.js';
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
  /** Existing service directory, relative to the workspace root. Defaults to '.'. */
  codeRoot?: string;
  koreanCustomerTone?: KoreanCustomerTone;
  /** Optional override; otherwise auto-detected from package.json. */
  framework?: Framework;
  recordingBranch?: string;
  /** Install project-local Claude Code and Codex skill files. Defaults to true. */
  installAgentSkills?: boolean;
}

type InitAgentSkillResult =
  | AgentSkillResult
  | { target: AgentTarget; status: 'preserved'; code: 'conflict' | 'unsafe_path'; path: string }
  | { target: AgentTarget; status: 'failed'; code: string; path?: string };

export interface RunInitResult {
  framework: Framework;
  codeRoot: string;
  serviceRoot: string;
  paths: WorkspacePaths;
  agentSkillsRequested: boolean;
  agentSkillsStatus: 'completed' | 'skipped';
  agentSkillsPurpose: string;
  agentSkills: InitAgentSkillResult[];
}

const AGENT_SKILLS_PURPOSE = 'Expose existing Doklo Doks as project context to Claude Code and Codex.';

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

export class InvalidCodeRootError extends Error {
  readonly code = 'INVALID_CODE_ROOT' as const;

  constructor(codeRoot: string, cause?: unknown) {
    super(`Invalid code root ${JSON.stringify(codeRoot)}. Use an existing directory relative to the workspace root, without '..', absolute paths, or symlinks. Example: doklo init --root . --code-root web --yes`, { cause });
    this.name = 'InvalidCodeRootError';
  }
}

async function resolveInitCodeRoot(root: string, requested: string): Promise<{ codeRoot: string; serviceRoot: string }> {
  try {
    if (!requested.trim()) throw new Error('Code root is empty.');
    const serviceRoot = await resolveContainedPath(root, requested);
    if (!(await stat(serviceRoot)).isDirectory()) throw new Error('Code root is not a directory.');
    const codeRoot = relative(resolve(root), resolve(root, requested)).split(sep).join('/') || '.';
    return { codeRoot, serviceRoot };
  } catch (cause) {
    throw new InvalidCodeRootError(requested, cause);
  }
}

export async function runInit(opts: RunInitOptions): Promise<RunInitResult> {
  // Validate before bootstrap creates the Hub, workspace, or agent files.
  const { codeRoot, serviceRoot } = await resolveInitCodeRoot(opts.root, opts.codeRoot ?? '.');
  const support = await assertSupportedRuntimeProject(serviceRoot);
  const framework = opts.framework ?? support.framework;

  const service: Service = {
    service_id: opts.serviceId,
    type: FRAMEWORK_TYPE[framework],
    framework,
    code_root: codeRoot,
  };

  if (opts.recordingBranch !== undefined) await validateRecordingBranch(opts.root, opts.recordingBranch);

  await bootstrapWorkspace({
    root: opts.root,
    workspaceId: opts.workspaceId,
    name: opts.name,
    defaultLocale: opts.defaultLocale,
    koreanCustomerTone: opts.koreanCustomerTone,
    supportedLocales: opts.supportedLocales,
    services: [service],
    recordingBranch: opts.recordingBranch,
  });

  // Initialization remains usable if a client directory is protected or customized.
  // Report each outcome; never overwrite user-owned skill content.
  const agentSkillsRequested = opts.installAgentSkills !== false;
  const agentSkills: RunInitResult['agentSkills'] = [];
  if (agentSkillsRequested) {
    for (const target of ['claude-code', 'codex'] as const) {
      try {
        agentSkills.push(await manageAgentSkill({ root: opts.root, target, action: 'setup' }));
      } catch (error) {
        if (error instanceof AgentSkillError && (error.code === 'conflict' || error.code === 'unsafe_path')) {
          agentSkills.push({ target, status: 'preserved', code: error.code, path: error.path });
        } else {
          agentSkills.push({
            target,
            status: 'failed',
            code: error instanceof AgentSkillError ? error.code : 'write_failed',
            ...(error instanceof AgentSkillError ? { path: error.path } : {}),
          });
        }
      }
    }
  }
  return {
    framework,
    codeRoot,
    serviceRoot,
    paths: workspacePaths(opts.root),
    agentSkillsRequested,
    agentSkillsStatus: agentSkillsRequested ? 'completed' : 'skipped',
    agentSkillsPurpose: AGENT_SKILLS_PURPOSE,
    agentSkills,
  };
}

function onboardingGuidance(locale: string): string {
  return locale === 'ko'
    ? '제품 용어: doklo lexicon-suggest --dry-run으로 검토합니다(모델 호출 없음). 선택 사항인 lexicon-suggest 실행은 유료 모델을 호출할 수 있습니다. 제안을 사람이 검토한 뒤 Studio Lexicon에서 확정하고, doklo generate --only <Dok ID> --force로 선택 재생성합니다(유료). 생성된 draft를 사람이 검토·승인한 뒤 doklo live-docs render로 렌더합니다. 한국어 말투는 --korean-tone formal(기본 합쇼체: ~합니다) 또는 plain(해라체: ~한다)으로 선택합니다. 기존 workspace.json의 korean_customer_tone으로도 설정합니다. 생성은 선택 정책과 필드별 충돌을 기록하며, 정식 help-page 렌더는 명확한 어미 충돌이나 생성 이후 정책 변경을 차단합니다. --preview로 표시된 검토용 미리보기를 확인한 뒤 문구를 수정하거나 선택 재생성하세요. 인용·이름은 말투 검사에서 제외되며 일반 문자열의 어미·동의어는 자동 변경하지 않습니다. 확정 용어는 owned/constant 표시 텍스트와 TermRef로 적용하며 i18n 바인딩은 현재 직접 해석하지 않습니다.'
    : 'Product terms: inspect doklo lexicon-suggest --dry-run (no model call). Optional lexicon-suggest execution can call a paid model. Review suggestions, confirm them in Studio Lexicon, then selectively regenerate with doklo generate --only <Dok ID> --force (paid). Review and approve the generated drafts before doklo live-docs render. Select --korean-tone formal (default, 합쇼체: ~합니다) or plain (해라체: ~한다); existing workspaces use korean_customer_tone in workspace.json. Generation records the selected policy and field-level conflicts. Official help-page rendering blocks clear ending conflicts and policy changes since generation; --preview produces a marked review artifact. Review and edit or selectively regenerate. Quotes and labels are excluded; prose endings and synonyms are never rewritten automatically. Approved owned/constant display text and TermRefs apply canonical terms; i18n bindings are not currently resolved directly.';
}

function onboardingNextStep(locale: string, tone: KoreanCustomerTone = 'formal'): string {
  return locale === 'ko'
    ? `용어 제안 → 사람 검토·확정 → 선택 재생성 → draft 검토·승인 → 렌더: doklo init --help에서 확인하세요. 제안·재생성은 유료일 수 있으며 한국어 말투는 ${tone === 'formal' ? '합쇼체' : '해라체'}입니다.`
    : `Terms: propose → human review and confirmation → selective regeneration → draft review and approval → render. See doklo init --help. Suggestion and generation calls may be paid; Korean customer tone: ${tone}.`;
}

function printInitScope(result: RunInitResult): void {
  console.log(`  Workspace root: ${result.paths.root}`);
  console.log(`  Service code root: ${result.codeRoot} → ${result.serviceRoot} (framework metadata: ${result.framework})`);
}

function printAgentSkills(result: RunInitResult, ctx: CliContext): void {
  console.log(ctx.t('agent.purpose'));
  if (!result.agentSkillsRequested) {
    console.log(ctx.t('agent.skipped'));
    return;
  }
  for (const skill of result.agentSkills) {
    if (skill.status === 'preserved') {
      console.error(ctx.t(`agent.${skill.code}`, { path: skill.path }));
    } else if (skill.status === 'failed') {
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
): Promise<{ services: number; routes: number; components: number; analysis?: ScanAnalysis[] } | null> {
  const scan = deps.runScan ?? runScan;
  try {
    const res = await scan({ root });
    let routes = 0;
    let components = 0;
    for (const r of res.results) {
      routes += r.counts.routes;
      components += r.counts.components;
    }
    const analysis = res.results.flatMap(result => result.analysis ? [result.analysis] : []);
    return { services: res.results.length, routes, components, ...(analysis.length > 0 ? { analysis } : {}) };
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
): ReturnType<typeof postInitScan> {
  if (scanOpt === false) return null;
  const { default: chalk } = await import('chalk');
  const summary = await postInitScan(root);
  if (machine) return summary;
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
    for (const analysis of summary.analysis ?? []) {
      for (const line of formatScanAnalysis(analysis)) console.log(`  ${line}`);
    }
  } else {
    console.error('  ' + chalk.yellow('!') + ' ' + ctx.t('init.scan_failed'));
  }
  return summary;
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
    .option('-r, --root <dir>', 'Workspace root (workspace.json and .doklo are written here)', process.cwd())
    .option('--code-root <dir>', 'Existing service directory relative to --root (default: .; no parent paths or symlinks)')
    .option('-y, --yes', 'Accept all defaults (non-interactive)', false)
    .option('--json', 'Emit JSONL only', false)
    .option('--recording-branch <branch>', 'Branch used for product records (explicit; no automatic checkout)')
    .option('--name <name>', 'Workspace display name')
    .option('--workspace-id <id>', 'Workspace id (kebab-case)')
    .option('--service-id <id>', 'Service id', 'web')
    .option('--default-locale <locale>', 'Default locale for business text (en|ko)')
    .addOption(new Option('--korean-tone <tone>', 'Korean customer prose: formal (~합니다, default) or plain (~한다)').choices(['formal', 'plain']))
    .option(
      '--supported-locales <list>',
      'Comma-separated list of UI locales (e.g., en,ko)',
    )
    .option('--model <ref>', 'Model to set as default (provider/model-id)')
    .option('--no-agent-skills', 'Skip project-local Claude Code and Codex integration files')
    .option('--no-scan', 'Skip the automatic code scan after init', true)
    .addHelpText('after', '\nSource scope: --root is the workspace; --code-root selects the service (e.g. doklo init --root . --code-root web --yes). Next.js App Router has a specialist; other projects, including FastAPI source, use generic text-file analysis without guaranteed framework semantics. Scan reports the actual strategy, file count, and exclusions. Add other services explicitly to workspace.json.\n\n' + onboardingGuidance(ctx.locale))
    .action(async (opts) => {
      const { intro, outro, cancel, isCancel, text, select, autocomplete, log } =
        await import('@clack/prompts');
      const { default: chalk } = await import('chalk');

      const root = resolve(opts.root as string);
      const machine = opts.json === true;

      // Fail fast before the interactive wizard: if the workspace already
      // exists, bootstrapWorkspace would throw anyway — but only after the
      // user has filled out every prompt. Surface it up front instead.
      const workspaceFile = workspacePaths(root).workspaceFile;
      if (await fileExists(workspaceFile)) {
        throw new WorkspaceAlreadyInitializedError(workspaceFile);
      }

      requireExplicitApproval({
        command: 'doklo init',
        yes: opts.yes === true,
        isTTY: !machine && process.stdin.isTTY === true,
      });

      let requestedCodeRoot = opts.codeRoot as string | undefined;
      if (!opts.yes) {
        intro(ctx.t('init.welcome'));
        if (requestedCodeRoot === undefined) {
          const pickedRoot = await text({
            message: ctx.locale === 'ko' ? '서비스 코드 경로 (workspace 기준 상대 경로)' : 'Service code root (relative to workspace)',
            initialValue: '.',
            validate: value => value?.trim() ? undefined : 'Code root cannot be empty.',
          });
          if (isCancel(pickedRoot)) {
            cancel(ctx.t('common.cancelled'));
            throw commandCancelled('init');
          }
          requestedCodeRoot = String(pickedRoot);
        }
      }
      const selectedRoot = await resolveInitCodeRoot(root, requestedCodeRoot ?? '.');
      const detected = (await assertSupportedRuntimeProject(selectedRoot.serviceRoot)).framework;

      const defaults = {
        name: opts.name ?? guessName(root),
        workspaceId: opts.workspaceId ?? (toKebab(opts.name ?? guessName(root)) || 'doklo-workspace'),
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
          koreanCustomerTone: opts.koreanTone,
          supportedLocales: defaults.supportedLocales.split(',').map((s: string) => s.trim()).filter(Boolean),
          serviceId: defaults.serviceId,
          codeRoot: selectedRoot.codeRoot,
          framework: detected,
          recordingBranch: opts.recordingBranch,
          installAgentSkills: opts.agentSkills !== false,
        });

        if (modelDefaultRef) {
          await saveConfig(setRoleModel(await loadConfig(), 'default', modelDefaultRef));
        }

        if (!machine) printInitScope(result);
        const scan = await maybePrintScanSummary(root, opts.scan as boolean, ctx, machine);

        if (!machine) {
          printAgentSkills(result, ctx);
          outro(ctx.t('init.complete', { path: result.paths.workspaceFile }));
          log.info(ctx.t('init.next_step_cli'));
          log.info(onboardingNextStep(defaults.defaultLocale, opts.koreanTone));
        }
        recordCommandResult(program, {
          schema_version: 1,
          command: 'init',
          status: 'success',
          data: { ...result, scan },
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
        koreanCustomerTone: opts.koreanTone,
        supportedLocales,
        serviceId: serviceId as string,
        codeRoot: selectedRoot.codeRoot,
        framework: detected,
        recordingBranch,
        installAgentSkills: opts.agentSkills !== false,
      });

      // Persist chosen model to ~/.config/doklo/config.json (outside runInit
      // so existing runInit tests are unaffected).
      if (pickedModel) {
        await saveConfig(setRoleModel(await loadConfig(), 'default', pickedModel));
      }

      if (!machine) printInitScope(result);
      const scan = await maybePrintScanSummary(root, opts.scan as boolean, ctx, machine);

      if (!machine) {
        printAgentSkills(result, ctx);
        outro(ctx.t('init.complete', { path: result.paths.workspaceFile }));
        log.info(ctx.t('init.next_step_cli'));
        log.info(onboardingNextStep(String(defaultLocale), opts.koreanTone));
      }
      recordCommandResult(program, {
        schema_version: 1,
        command: 'init',
        status: 'success',
        data: { ...result, scan },
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
  return basename(root) || 'doklo-workspace';
}

function toKebab(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
