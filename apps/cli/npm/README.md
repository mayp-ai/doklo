# Doklo — developer preview

Doklo reads supported application code and creates feature-document drafts for people to review. This Apache-2.0 preview provides a local CLI, a review UI, and a read-only MCP server.

## Install

```bash
npm install -g @mayp/doklo
```

Version 0.4.1 requires Node.js 20.9 or newer, with one project per workspace.

## Start in your project

```bash
doklo init
doklo generate
doklo serve --open
doklo sync --check
```

Initialization records your model and branch choices, scans the project, and prints the next command. Review the selected source files and model route before generation: source excerpts can be sent to your selected model provider, whose usage costs are separate. Generation creates drafts; a person reviews and promotes them to active in the local UI.

For command options, run `doklo --help` or `doklo <command> --help`. Coding agents can connect through `doklo mcp`; configure the project root explicitly. The installed package includes `AGENT_GUIDE.md` and Korean documentation in `README.ko.md`.

## Supported features

- **Generic source analysis:** Groups readable UTF-8 source files for model review without requiring a framework-specific parser or package.json. Next.js App Router adds specialized route and dependency extraction; other frameworks use generic source evidence.
- **Source exclusions:** Known sensitive paths, Git-ignored files, dependencies, and build output are excluded before source reads. Binary files, non-UTF-8 files, and files over 1 MiB are also excluded.
- **Change detection and edit protection:** `doklo sync --check` reports tracked source changes. Ordinary `doklo sync` preserves human-edited documents by skipping them.

## Record what changed

Each description keeps a change history in its Dok file (`_meta.history`), versioned with your repository. Doklo adds an entry only when a person acts in Studio; `doklo generate` and `doklo sync` never write one. Each entry carries a date and, when available, the author's name from `DOKLO_AUTHOR` or your git `user.name`.

- **Regeneration stages a proposal.** When `doklo sync` regenerates a description that already exists, the description returns to `draft` with a short summary of what changed, such as `Updated the description; added 2 steps.` The summary is a rule-based comparison, not a model's output: it reports a rename and changes to the description, steps, rules, and acceptance criteria, and nothing is staged when the content is unchanged. `doklo sync --judge` can stage the judge's sentence instead (see the next section). A staged proposal is not history yet and appears in no Live Doc.
- **Approval records it.** Studio shows the proposal as `Proposed: …`. Activating the description, one at a time or in bulk, records it in the history and clears it.
- **Notes and status changes are recorded too.** A note typed in `What changed? (optional)` is recorded when you save, under Changed unless you pick another category; typed when you activate, it replaces the proposal. Status changes such as activate, deprecate, or archive are recorded without a note; text edits are recorded only with one.

Approving a description, one at a time or in bulk, does not stop `doklo sync` from regenerating it: after a code change, it returns to `draft` with a new proposal to approve. Without `--force`, `doklo sync` skips a description whose text you edited in Studio, or whose status you moved to or from planned, deprecated, or archived; `--force` regenerates it as a new draft and overwrites those changes. Descriptions approved with an earlier version of Doklo are still marked as edited, so the first time each one goes stale it needs `doklo sync --force`, or `doklo sync --dok <ID> --force` to leave descriptions you really edited alone; after that, the loop runs without it. Descriptions whose tracking predates 0.3.2 show as `unknown` and never go stale: run `doklo scan --repair-tracking` first, which rebuilds their tracking and marks them stale for review, so the next `doklo sync` regenerates them (with `--force` for those still marked as edited). To stage your own sentence instead of the comparison:

```bash
# Applies to every description this run regenerates. --category requires --note,
# and --note cannot be combined with --check.
doklo sync --note "Checkout accepts gift cards" --category added
```

`keep-a-changelog` lists the recorded changes of the active descriptions it includes, grouped by date and Keep a Changelog category; a description's first activation appears under Added, and a description with nothing recorded is not listed. `release-digest` counts a description as changed only when its tracked source changed since the previous render, then states the notes and approved proposals recorded since that render, or a generic line when there are none. The MCP tools do not return history.

## Let a judge decide what to regenerate

Not every code change makes a description wrong. Two checks keep changes that do not matter from sending a description back to `draft`.

**Form-only changes are not drift.** If the only change in a description's tracked JavaScript or TypeScript files is to comments, whitespace, or line endings, the description is not stale. There is nothing to turn on, and there is no model call or cost: `doklo sync` reports how many descriptions changed in form only, `doklo show <ID>` says so on its freshness line, and MCP returns `is_stale: false`. Other files, and files that do not parse, are still compared byte for byte.

**Ask a judge before regenerating.** For descriptions that are still stale, `doklo sync --judge` asks a model whether each one still holds before regenerating it:

```bash
doklo sync --judge                 # ask about every stale description first
doklo sync --judge --judge-max 10  # ask about at most 10; the rest regenerate as usual
```

The judge reads the description, what changed in its tracked files since the commit the description was generated from (a git diff, or the whole file when a reliable diff cannot be built), and the description's source anchors, up to 240,000 characters per check. Files Doklo never sends to a model, such as credentials, are named but not sent. It answers one of three ways:

- **Still accurate:** the description is not regenerated and keeps its status. The verdict is cached under `.doklo/cache/judge/`, so while the code, the base commit, and the text stay the same, the next `doklo sync --judge` reuses it without a call.
- **Needs an update:** the description is regenerated, and the judge's one sentence on what the description must now say is staged as the change proposal that approval records. A `--note`, or a proposal you wrote and have not approved yet, takes precedence. If the regeneration comes out unchanged, nothing is staged and sync names the description so you can edit it yourself.
- **Unsure:** the description is regenerated as it would be without `--judge`. A failed call, an answer not in the required form, evidence from a file the judge was not given, and a "still accurate" without evidence all count as unsure.

A verdict is an opinion with cited evidence, never an approval. The judge writes in the workspace's default language (Korean for `ko`, English otherwise). `doklo sync --judge` asks for consent twice: first for the judge's calls, then for the regenerations that are still needed; `--yes` approves both. `--judge` cannot be combined with `--check`, which never calls a model.

**Which model judges.** The judge follows the provider of your regeneration model: Claude Sonnet 5 with an Anthropic API key (the default), GPT-6 Luna with a ChatGPT (Codex) login. To pin one, run `doklo model --task judge --set anthropic/claude-sonnet-5` or `doklo model --task judge --set openai/gpt-6-luna`; no other model is accepted. GPT-6 Luna also judges with an OpenAI API key (`doklo auth --provider openai` with the API-key method, or `OPENAI_API_KEY`); to use it that way, pin it with the second command. The default reaches GPT-6 Luna only from a ChatGPT login, because generation never runs on an OpenAI API key. Calls with the API key are sent with `store: false`. In our benchmark both caught every change that needed an update; GPT-6 Luna was much cheaper and faster but raised a few false alarms on unrelated descriptions and changed some verdicts between runs, while Sonnet 5 raised none. The benchmark measured GPT-6 Luna through the ChatGPT (Codex) login; the API-key endpoint was only smoke-tested.

**Cost.** A check sends about as much as one regeneration, and its tokens count toward the same limits as generation (`DOKLO_MAX_TOKENS_PER_RUN`, `DOKLO_MAX_TOKENS_TOTAL`). A description that does need an update pays for a check and a regeneration: the judge saves review work, not model spend.

**Confirm what the judge kept.** A description the judge called still accurate stays stale until a person confirms it in the web app with **Still accurate**. Until then, `doklo sync --check` still lists it (and exits 1) with a note that it was judged accurate and is unconfirmed, `doklo show <ID>` prints the same note, MCP keeps returning `is_stale: true`, and the `doklo sync --judge` run that kept it ends as partial (exit code 1). Confirming changes neither the text nor the status and records no history entry; the description then reads fresh until its tracked files change again. A plain `doklo sync` regenerates it instead.

**Limits.**

- Both checks need facts that generation now records: a normalized hash for the form-only check, and per-file hashes and a base commit for the judge, so the judge needs a git repository. Descriptions generated by an earlier version of Doklo do not have them: until they are regenerated once, form-only edits still make them stale and `--judge` sends them to regeneration without asking.
- Descriptions that show `unknown` after upgrading to 0.3.2 never go stale; run `doklo scan --repair-tracking` to rebuild their tracking.
- Descriptions a person edited are still skipped without `--force`.
- Drafts, descriptions with a tracked file that is gone or unreadable, and descriptions whose tracking was repaired regenerate without the judge, as do descriptions beyond `--judge-max`, over the 240,000-character input, or whose changes cannot be shown to the judge.

## Document languages in 0.4.1

Doks can be written in English, Korean, Japanese, Simplified or Traditional Chinese, French, Spanish, German, or Portuguese (`en`, `ko`, `ja`, `zh-Hans`, `zh-Hant`, `fr`, `es`, `de`, `pt`). `doklo init` proposes the language from the code: i18n configuration first, then the text a visitor reads, then a single message catalog, then `<html lang>`. When the code says nothing, it proposes the CLI's language. Pass `--default-locale` to choose; loosely written tags such as `ko_KR` or `zh-TW` are stored in their canonical form. `doklo scan --json` reports the detected language for each service.

Each Dok records the language it was written in (`_meta.locale`). To change the language, set `default_locale` in `workspace.json` and regenerate.

Source written in another language does not change the Dok's language. On-screen wording is quoted exactly only when it is already in the Dok's language; otherwise the Dok says what it means and adds the original once in parentheses. A Dok that still comes back in another script is not saved: generation retries it once, then reports `DOK_LANGUAGE_MISMATCH` with the command to regenerate it.

Korean customer prose is always written in 합쇼체 (`formal`). `doklo init` no longer asks; `--korean-tone` is accepted and ignored with a warning. A workspace that needs plain prose sets `korean_customer_tone: plain` in `workspace.json`.

The sync judge and the Live Docs templates still write in English or Korean.

## Live Docs improvements in 0.3.2

Help articles have a revised reading layout and section navigation that also
works when several articles are embedded together. Stable copy checks handle
long input without the previous excessive scanning time. Renderer integrations
can supply a stored document baseline for change summaries. The experimental
HWPX toolchain remains optional. Existing documents are not rewritten or approved.

## First-run planning and embedded help in 0.3.1

- Select a contained service directory with `init --code-root web`; scan results
  explain the analysis strategy, included source paths and exclusions.
- Preview source candidates with `generate --dry-run` or `consolidate --dry-run`
  before paid work. Missing plans are distinguished from zero-item plans, token
  estimates are separated from output limits, and reported usage survives later
  cancellation or failure. Estimates are not provider price guarantees.
- Embed sanitized help-page HTML fragments using `--var html_fragment=true`,
  `--var heading_level=2` and, when needed, a distinct `--var id_prefix=sidebar`.
  Apply host-page styles and keep outputs inside the workspace.
- New standard role names follow the workspace locale; curated names remain
  unchanged. Generation uses confirmed terms and a shared Korean customer tone
  (`formal`, or `plain` set in `workspace.json`). Official Korean help-page output reports and
  blocks clear tone conflicts or an unreviewed policy change. Review and correct
  the prose, or use a marked draft preview; existing prose is not rewritten.
- Public image-format names such as WebP no longer trigger identifier-pattern
  warnings. Internal Dok IDs and other customer-copy checks remain enforced.

Generated documents still require human review. See the
[first-run and embedding guide](https://github.com/mayp-ai/doklo/blob/v0.3.1/docs/en/first-run-and-embedding.md)
for examples, terminology review and output delivery paths.

## Generation recovery and draft previews in 0.3.0

Malformed JSON or truncated model responses are retried once by default. Set
`--retries 0` to disable retries or `--retries 2` for up to two extra attempts.
Retries count toward execution consent and token limits and may add provider
costs. Partial failures return a failing exit status and identify failed Doks.

```bash
doklo generate --only CHAT
doklo live-docs render help-page --dok CHAT --format html --preview
```

`--only` limits recovery to selected IDs. Existing documents are skipped unless
you explicitly use `--force`; a failed regeneration preserves the original.
Stable Markdown/HTML previews keep the Hub's draft status and show an
unreviewed-draft notice. Customer-copy checks remain enabled, and preview output
cannot be used as official saved Publication evidence.

New scans and consolidation exclude auxiliary-only feature candidates and narrow
Next.js cross-screen helper evidence. Existing caches require `doklo scan` and
`doklo consolidate` to acquire these boundaries; consolidation may incur model
costs. Existing Hub documents are not automatically rewritten or removed.
Product briefs describe intent, not proof of implementation. Model-reported
content concerns still require human review.

## Recover tracking for existing documents

Documents created with older tracking are reported as `unknown`. Rebuild their source tracking with:

```bash
doklo scan --repair-tracking
```

Recovery preserves existing document content and history. Repaired documents still need review; repairing their tracking does not certify their content.

## Current limitations

- Framework detection and generic source analysis do not guarantee complete route or behavior extraction.
- Path rules cannot recognize secrets embedded in arbitrarily named application source. Exclude those files with `.gitignore` before analysis. Rescan after adding files.
- Combined source over 192,000 characters per feature is rejected before generation. Split large services or feature groups; source is not silently truncated.
- Specialized static import tracking has a bounded depth. Runtime wiring and dynamic imports may be absent. Unresolved internal imports stop the scan.
- Freshness means tracked source hashes match, not that a document is accurate or complete.
- **`doklo sync --force` regenerates human-edited documents and overwrites their edits. It does not automatically merge those edits.**
- The credential-free Claude Code route supports generation, not sync. Do not silently switch providers.
- Local Live Review integration is not included in this preview. The local UI for reviewing Dok drafts is available through `doklo serve --open`.

## License

Apache-2.0. See the installed `LICENSE` and `NOTICE`. Third-party components retain their own licenses. Separate Doklo Cloud services have their own terms.
