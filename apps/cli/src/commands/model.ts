// `doklo model [--task <role>]` — pick the model for a role and persist
// it to ~/.config/doklo/config.json. Surfaces benchmark-informed model
// guidance (recommended ★ / warned ⚠ / neutral) — see lib/model-guidance.ts.
//
// Interactive flow is a two-step picker: choose the PROVIDER first (curated
// v1 builtins), then the MODEL within that provider. This avoids a single
// flat autocomplete over 400+ models from every provider in models.dev.
// ESC / Ctrl-C at the model step goes BACK to the provider step.
import type { Command } from 'commander';
import type { CliContext } from '../lib/context.js';
import type { I18nT } from '../lib/i18n.js';
import { loadConfig, saveConfig, setRoleModel as _setRoleModel, BUILTIN_PROVIDERS } from '../lib/config.js';
export { setRoleModel } from '../lib/config.js';
import { loadModelsDb, getCost, type ModelsDb } from '@doklo-beta/generator';
import { modelGuidance } from '../lib/model-guidance.js';
import { CommandContractError } from '../lib/command-result.js';

/** A @clack/prompts select/autocomplete option. */
export interface ModelOption {
  value: string;
  label: string;
  hint?: string;
}

/**
 * Decorate a {title,value} model choice into a picker option, adding
 * benchmark-informed markers: a "★ " prefix + hint for RECOMMENDED refs, a
 * "⚠ " prefix (no hint) for WARNED refs, and no change otherwise. Cost is not
 * needed here — only the curated recommended/warned lists drive picker markers.
 */
export function toModelOption(
  choice: { title: string; value: string },
  t: I18nT,
): ModelOption {
  const g = modelGuidance(choice.value, undefined);
  if (g.tier === 'recommended' && g.messageKey) {
    return { value: choice.value, label: `★ ${choice.title}`, hint: t(g.messageKey) };
  }
  if (g.tier === 'warned') {
    return { value: choice.value, label: `⚠ ${choice.title}` };
  }
  return { value: choice.value, label: choice.title };
}

/**
 * Step 1 choices: one entry per curated builtin provider that actually exists
 * in the models.dev db. value = provider id; title = provider id plus the
 * models.dev display name when available.
 */
export function buildProviderChoices(
  db: ModelsDb,
): Array<{ title: string; value: string }> {
  return Object.keys(BUILTIN_PROVIDERS)
    .filter((pid) => db[pid] !== undefined)
    .map((pid) => {
      const display = db[pid]?.name;
      const title = display !== undefined ? `${pid} (${display})` : pid;
      return { title, value: pid };
    });
}

// Regex to drop image/audio/embedding/TTS/etc. models by id pattern.
// Conservative: only matches when the keyword appears as a whole token
// (bounded by start-of-string, separator chars, or end-of-string).
const NON_TEXT_ID_RE = /(^|[-_/])(image|tts|audio|embedding|whisper|dall-?e|sora|moderation|realtime)([-_]|$)/i;

// Regex to detect dated snapshot suffixes like -20251101.
const DATED_SUFFIX_RE = /-\d{6,8}$/;

/** Strip a trailing " (latest)" (case-insensitive) from a model display name. */
function cleanTitle(name: string): string {
  return name.replace(/\s*\(latest\)\s*$/i, '').trim();
}

/**
 * Step 2 choices: the models under a given provider, filtered to text-output
 * models only, sorted newest-first (release_date desc, then last_updated desc,
 * then id desc as tiebreak; models with no dates sort to the bottom). Each
 * value is "<provider>/<modelId>", title is the model's display name (falling
 * back to its id) with any trailing " (latest)" stripped.
 *
 * Alias/snapshot pairs (same cleaned title, different ids) are deduped:
 * the alias entry (original name contained "(latest)", or id has no dated
 * suffix) is kept; the dated snapshot twin is dropped.
 *
 * Returns [] when the provider (or its models) is missing.
 */
export function buildModelChoices(
  db: ModelsDb,
  provider: string,
): Array<{ title: string; value: string }> {
  const models = db[provider]?.models;
  if (models === undefined) return [];
  const sorted = Object.values(models)
    .filter((m) => {
      // Drop models whose id looks like a non-text/media model.
      if (NON_TEXT_ID_RE.test(m.id)) return false;
      // Keep models that can output text. If modalities.output is undefined we
      // are permissive and keep the model. Only exclude when it's defined and
      // does NOT include 'text' (embeddings, TTS, audio-output, image-only…).
      const out = m.modalities?.output;
      if (out === undefined) return true;
      return out.includes('text');
    })
    .slice()
    .sort((a, b) => {
      // Newest-first: models with a release_date/last_updated beat undated ones.
      const aDate = a.release_date ?? a.last_updated;
      const bDate = b.release_date ?? b.last_updated;
      if (aDate !== undefined && bDate !== undefined) {
        // Both dated: compare release_date desc, fallback last_updated desc, then id desc.
        const relCmp = (b.release_date ?? '').localeCompare(a.release_date ?? '');
        if (relCmp !== 0) return relCmp;
        const updCmp = (b.last_updated ?? '').localeCompare(a.last_updated ?? '');
        if (updCmp !== 0) return updCmp;
        return b.id.localeCompare(a.id);
      }
      if (aDate !== undefined) return -1; // a dated, b not → a first
      if (bDate !== undefined) return 1; // b dated, a not → b first
      // Both undated: sort by id desc as final tiebreak
      return b.id.localeCompare(a.id);
    });

  // Dedupe alias/snapshot pairs by cleaned title.
  // Group models sharing the same cleaned title; from each group keep one.
  // Track whether each stored entry is an alias so we can upgrade it if needed.
  const seen = new Map<string, { title: string; value: string; isAlias: boolean }>();
  for (const m of sorted) {
    const rawTitle = m.name || m.id;
    const title = cleanTitle(rawTitle);
    // An entry is an "alias" if: (a) its original name contained "(latest)", OR
    // (b) its id does NOT end in a dated suffix.
    const thisIsAlias =
      /\(latest\)/i.test(rawTitle) || !DATED_SUFFIX_RE.test(m.id);
    if (!seen.has(title)) {
      // First entry for this cleaned title.
      seen.set(title, { title, value: `${provider}/${m.id}`, isAlias: thisIsAlias });
    } else {
      // Duplicate cleaned title. Only replace the stored entry if it is NOT
      // an alias but the current one IS (prefer alias over dated snapshot).
      const stored = seen.get(title)!;
      if (thisIsAlias && !stored.isAlias) {
        seen.set(title, { title, value: `${provider}/${m.id}`, isAlias: true });
      }
    }
  }

  return Array.from(seen.values()).map(({ title, value }) => ({ title, value }));
}

export function registerModelCommand(program: Command, ctx: CliContext): void {
  program
    .command('model')
    .description('Pick the model for a task (writes ~/.config/doklo/config.json)')
    .option('--task <role>', 'Task role (default|generate|consolidate|lexicon|evaluate)', 'default')
    .option('--set <ref>', 'Set "provider/model-id" non-interactively')
    .option('--provider <id>', 'Pre-pick the provider (skips the provider prompt)')
    .action(async (opts) => {
      const { intro, outro, isCancel, select, autocomplete, log } = await import('@clack/prompts');
      const { default: chalk } = await import('chalk');
      const role = opts.task as string;
      const config = await loadConfig();

      // Single db load, reused for both picker steps and the cost lookup.
      const db = await loadModelsDb();

      let ref = opts.set as string | undefined;
      if (!ref) {
        intro(ctx.t('model.pick', { role }));

        // State machine: 'provider' → 'model'. ESC at model goes back to 'provider'.
        let step: 'provider' | 'model' = opts.provider ? 'model' : 'provider';
        let provider = opts.provider as string | undefined;

        loop: while (true) {
          if (step === 'provider') {
            const picked = await select({
              message: ctx.t('model.pick_provider', { role }),
              options: buildProviderChoices(db).map((c) => ({ value: c.value, label: c.title })),
            });
            if (isCancel(picked)) {
              throw new CommandContractError({
                schema_version: 1,
                command: 'model',
                status: 'cancelled',
                data: null,
                diagnostics: [
                  { code: 'COMMAND_CANCELLED', message: 'Model selection was cancelled.' },
                ],
              });
            }
            provider = picked as string;
            step = 'model';
          }

          // step === 'model' (always reached after provider is set)
          const prov = provider as string;
          const choice = await autocomplete({
            message: `${prov} · ${ctx.t('model.pick_model', { provider: prov })} ${ctx.t('common.esc_back')}`,
            options: buildModelChoices(db, prov).map((c) => toModelOption(c, ctx.t)),
            placeholder: 'type to search',
          });
          if (isCancel(choice)) {
            // ESC at model step → go back to provider
            step = 'provider';
            continue loop;
          }
          ref = choice as string;
          break loop;
        }
      }
      if (!ref) throw new Error('No model selected.');

      const guidance = modelGuidance(ref, getCost(db, ref));
      if (guidance.tier === 'warned' && guidance.messageKey) {
        // Measured-poor: yellow warning (same visual as the old weak warning).
        log.warn(ctx.t(guidance.messageKey, { model: ref }));
      } else if (guidance.tier === 'recommended' && guidance.messageKey) {
        // Benchmark pick: subtle dim/green confirmation line.
        log.success(chalk.dim(ctx.t(guidance.messageKey)));
      } else if (guidance.messageKey === 'model.weak_warning') {
        // Unmeasured but cheap: price-proxy fallback warning.
        log.warn(ctx.t(guidance.messageKey, { model: ref }));
      }

      await saveConfig(_setRoleModel(config, role, ref));
      outro(ctx.t('model.set_ok', { role, model: ref }));
    });
}
