<p align="center">
  <img src="./docs/assets/doklo-logo-horizontal.png" alt="Doklo" width="240">
</p>

<p align="center"><strong>Understand what AI built.</strong><br>
Doklo reads AI-built software and turns it into product docs people can read, review, and hand over.</p>

<p align="center">
  <a href="https://www.npmjs.com/package/@mayp/doklo"><img src="https://img.shields.io/npm/v/@mayp/doklo.svg" alt="npm version"></a>
  <a href="./LICENSE"><img src="https://img.shields.io/badge/license-Apache--2.0-blue.svg" alt="License"></a>
  <a href="https://github.com/mayp-ai/doklo/actions/workflows/ci.yml"><img src="https://github.com/mayp-ai/doklo/actions/workflows/ci.yml/badge.svg" alt="CI"></a>
</p>

<p align="center"><a href="README.md">English</a> | <a href="README.ko.md">한국어</a></p>

<p align="center">
  <img src="./docs/assets/studio-tour.gif" alt="Doklo Studio moving from a feature description to screen structure (IA) and role details" width="800">
</p>
<p align="center"><i>Studio: review a feature description, screen structure (IA), and role details from the same Hub.</i></p>

<details>
<summary>View the static feature-description screen</summary>

<p align="center">
  <img src="./docs/assets/studio-review.png" alt="Reviewing the generated Book Detail View description in Doklo Studio" width="800">
</p>
</details>

## Highlights

- **Drafts from code.** Doklo reads your code and writes a description of each feature: what it does, the steps a user takes, the rules, and the checks. Every description links to the source files it came from.
- **People approve, not the model.** A generated description stays `draft` until a person reviews it in Studio and marks it `active`. Stable help pages are built from active descriptions only.
- **Ships as help pages and team docs.** Approved descriptions become customer help pages, a help index, onboarding notes, a [changelog](#record-what-changed), and more, published into your own app or repository.
- **Your coding agent reads the same thing.** Claude Code, Cursor, and Claude Desktop query the descriptions over MCP, with each one's review status and freshness. `doklo sync --check` lists the descriptions whose source files changed; `doklo sync` regenerates them.

## Install

```bash
npm install -g @mayp/doklo
```

Node.js 20.9+. One project per workspace. See [current framework support](#what-to-know-before-you-start) before running Doklo on your project.

Version `0.2.0` adds generic source analysis alongside the specialized Next.js App Router parser. Doklo remains a developer preview; review generated drafts and the limitations below before relying on them.

## Quickstart

```bash
doklo init                 # checks the project, records model/branch choices, installs agent skills,
                           # scans the code and prints the next CLI command
doklo generate             # writes one draft description per feature
doklo serve --open         # review and approve drafts in Doklo web
doklo sync --check         # after code changes: which descriptions to re-check
```

Initialization stays in the CLI. Open Doklo web with `serve` after generating drafts to review them.

Before generation, the CLI summarizes the Doks selected for this run by domain and feature; `--plan-details` expands every Dok ID. Large plans can be split by a conservative safety limit: the preview distinguishes this run from deferred Doks, which never run automatically. The preview shows rough input/output token estimates separately from the maximum output allowance. The result includes failed responses in measured token usage and compares estimates over the same attempted calls; missing provider usage is explicitly unmeasured. Existing Doks are skipped unless `--force` is supplied.

Generation uses the model and credentials you selected, and selected source excerpts are sent to that model provider. See the [model guide](./docs/en/models.md) for route-by-route details.

To connect a coding agent, see [Use it from your AI agent (MCP)](#use-it-from-your-ai-agent-mcp) below.

## What to know before you start

- **Framework support:** Generic source analysis works without a framework-specific parser or package.json. Next.js App Router adds specialized route and dependency extraction; more parsers can be registered over time. Other source files remain available for analysis, including in mixed-language projects.
- `doklo sync` regenerates through a supported model and an authenticated profile you select; the credential-free local Claude Code route is `generate`-only.
- Generic analysis keeps projects with up to 24 readable UTF-8 files together for model review; larger inventories are grouped by directory. It conservatively tracks the discovered source inventory. Known credential/config paths (including `.env`, private keys, `.properties`, and application credential configuration), dependency/build output and Git-ignored paths are excluded before source reads. Binary files and files over 1 MiB are also excluded. Path rules cannot recognize secrets embedded in arbitrarily named application source; exclude those paths with `.gitignore` before analysis. Rescan after adding files. With a specialized parser, tracking follows static import declarations within a bounded depth. Dynamic imports and runtime wiring may be absent. Unresolved internal imports stop the scan. Older tracking is reported as unknown until it is rebuilt and reviewed.
- A feature whose combined source exceeds 192,000 characters is rejected before generation rather than silently truncated. Split large services or feature groups before retrying.
- Descriptions may be wrong or incomplete. "Fresh" means the tracked source files have not changed, not that the text is correct.
- In stable help docs, a description that still contains internal identifiers is skipped and reported. Terms listed in `workspace.json` under `stable_public_terms` are not treated as identifiers (exact match only).

## Publish a Live Doc

The built-in catalog contains 16 templates: **7 stable** templates (`feature-matrix`, `github-onboarding`, `help-index`, `help-page`, `keep-a-changelog`, `permission-gap`, and `release-digest`) and **9 experimental** templates. The default list exposes the stable set; opt in with `--experimental` to inspect the rest.

```bash
# Show the stable contract, then render one active, human-reviewed Dok.
doklo template list
doklo live-docs render help-page --dok AUTH-SIGNUP --locale en

# Save the same selection so it can be inspected and rendered after restart.
doklo live-docs publication create signup-help \
  --template help-page --dok-id AUTH-SIGNUP \
  --format markdown --locale en
doklo live-docs publication render signup-help --dry-run
doklo live-docs publication render signup-help
```

Experimental templates are labeled in direct renders and saved Publication commands. PPTX, XLSX, and HWPX outputs remain experimental because no official consumer-app validation is connected to the release gate. Screenshot capture is experimental and currently unavailable: it stays disabled until output publication satisfies the documented Doklo-exclusive [single-writer contract](docs/livedocs-publications-plan.md#41-dry-run과-렌더-증거) and an actual app → capture → stable document E2E is part of the gate. Live Docs are snapshots: run render again to include later Hub changes.

Every generated Dok is written with `status: "draft"`. A person must explicitly review and promote it to `active` in Studio before a stable renderer accepts it. Without an explicit selection, stable renderers include only active Doks; explicitly selecting a draft, planned, deprecated, or archived Dok fails closed with `UNREVIEWED_DOK`. For stable workspace templates, one unsafe active Dok is skipped with `SKIPPED_STABLE_DOK` while the remaining safe Doks still render; the render fails if none are safe.

## Put the documents where people read them

Rendered outputs land under `.doklo/output/` by default. A saved Publication can also carry a workspace-relative `--destination`, and `publish` copies the last rendered outputs into that folder. `publish` only places files on your disk: open them through your app's dev server to check them, and deploy your app as usual to put them online. In 0.1.0 your app and your repository do the hosting: this CLI's `publish` includes no upload to or hosting by Doklo Cloud.

```bash
# Customer help: turn the reviewed (active) Doks into HTML articles under
# public/help/.
# In this Next.js example, the app serves public/help/<DOK-ID>.html at /help/<DOK-ID>.html, so after
# `next dev` the article opens at http://localhost:3000/help/<DOK-ID>.html.
doklo live-docs publication create customer-help \
  --template help-page --status active --format html --locale en \
  --destination public/help
doklo live-docs publication render customer-help
doklo live-docs publication publish customer-help --dry-run
doklo live-docs publication publish customer-help

# Team documents: Markdown that GitHub renders. Give each Publication its
# own folder under docs/ — one folder belongs to exactly one Publication.
doklo live-docs publication create team-onboarding \
  --template github-onboarding --status active --format markdown --locale en \
  --destination docs/doklo/onboarding
doklo live-docs publication render team-onboarding
doklo live-docs publication publish team-onboarding

doklo live-docs publication create team-permissions \
  --template permission-gap --status active --format markdown --locale en \
  --destination docs/doklo/permissions
doklo live-docs publication render team-permissions
doklo live-docs publication publish team-permissions
```

After each `render`, check the generated files and exclusion warnings: a `SKIPPED_STABLE_DOK` diagnostic names a Dok that was excluded for containing internal identifiers.

`publish` follows four rules:

- It never replaces a file it did not write. A hand-edited or unrelated file with the same name stops the publish with `PUBLICATION_PUBLISH_BLOCKED`, and nothing in the destination changes.
- Publishing outputs that did not change writes nothing and reports them as `unchanged`.
- One destination folder belongs to one Publication. A second Publication aimed at the same folder is blocked with `PUBLICATION_PUBLISH_BLOCKED`, so give each one its own folder. To ship a help index with its articles, publish the articles one folder below the index and point the index at them with `link_prefix`:

  ```bash
  # 1. Articles: render, then read rendered_dok_ids from the result (a Dok the
  #    stable lint skipped is selected but not rendered).
  doklo live-docs publication create help-articles \
    --template help-page --status active --format html --locale en \
    --destination public/help/pages
  doklo live-docs publication render help-articles --json   # note "rendered_dok_ids"
  doklo live-docs publication publish help-articles

  # 2. Index: select exactly those rendered Doks with --dok-id, one folder up.
  #    With rendered_dok_ids = ["HOME"] the index selects HOME only; add one
  #    --dok-id per additional rendered article.
  doklo live-docs publication create help-index \
    --template help-index --dok-id HOME --format html --locale en \
    --var link_prefix=./pages/ --destination public/help
  doklo live-docs publication render help-index
  doklo live-docs publication publish help-index
  # /help/help-index.html now links only to articles that exist at /help/pages/<DOK-ID>.html
  ```

  Selecting the index by status instead would also list a Dok the article render skipped (`SKIPPED_STABLE_DOK`), and that entry would be a dead link. When the set of rendered articles changes, refresh the index definition and its render: `publication create help-index --overwrite ...` replaces the saved definition, `publication render help-index --overwrite` replaces this Publication's own files under `.doklo/output/`, and `publish` then applies the usual rules to the destination (it still never touches files it did not write).
- A `doklo-publish.json` ledger (publication name, definition hash, published file paths with hashes, and the publish time) is written next to the outputs so the next publish can tell its own files from yours. Under `public/` that ledger is served with your site, so keep that in mind when you name Publications.

## Record what changed

Each description keeps a change history in its Dok file (`_meta.history`), versioned with your repository. Doklo adds an entry only when a person acts in Studio; `doklo generate` and `doklo sync` never write one. Each entry carries a date and, when available, the author's name from `DOKLO_AUTHOR` or your git `user.name`.

- **Regeneration stages a proposal.** When `doklo sync` regenerates a description that already exists, the description returns to `draft` with a short summary of what changed, such as `Updated the description; added 2 steps.` The summary is a rule-based comparison, not a model's output: it reports a rename and changes to the description, steps, rules, and acceptance criteria, and nothing is staged when the content is unchanged. `doklo sync --judge` can stage the judge's sentence instead ([see below](#let-a-judge-decide-what-to-regenerate)). A staged proposal is not history yet and appears in no Live Doc.
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

**Cost.** A check sends about as much as one regeneration, and its tokens count toward the same limits as generation (`DOKLO_MAX_TOKENS_PER_RUN`, `DOKLO_MAX_TOKENS_TOTAL`; see [Token limits](#token-limits-and-agent-skills)). A description that does need an update pays for a check and a regeneration: the judge saves review work, not model spend.

**Confirm what the judge kept.** A description the judge called still accurate stays stale until a person confirms it in the web app with **Still accurate**. Until then, `doklo sync --check` still lists it (and exits 1) with a note that it was judged accurate and is unconfirmed, `doklo show <ID>` prints the same note, MCP keeps returning `is_stale: true`, and the `doklo sync --judge` run that kept it ends as partial (exit code 1). Confirming changes neither the text nor the status and records no history entry; the description then reads fresh until its tracked files change again. A plain `doklo sync` regenerates it instead.

**Limits.**

- Both checks need facts that generation now records: a normalized hash for the form-only check, and per-file hashes and a base commit for the judge, so the judge needs a git repository. Descriptions generated by an earlier version of Doklo do not have them: until they are regenerated once, form-only edits still make them stale and `--judge` sends them to regeneration without asking.
- Descriptions that show `unknown` after upgrading to 0.3.2 never go stale; run `doklo scan --repair-tracking` to rebuild their tracking.
- Descriptions a person edited are still skipped without `--force`.
- Drafts, descriptions with a tracked file that is gone or unreadable, and descriptions whose tracking was repaired regenerate without the judge, as do descriptions beyond `--judge-max`, over the 240,000-character input, or whose changes cannot be shown to the judge.

## Use it from your AI agent (MCP)

Doklo exposes the Hub to AI agents (Claude Code, Claude Desktop, Cursor, etc.) as a read-only stdio MCP server. The server runs locally and makes no model-provider or Doklo-cloud calls; it returns requested Hub data to the MCP client you connect. Generation is a separate, explicit operation: after approval, selected source excerpts are sent through direct Anthropic or your local Claude Code session.

Register the same JSON with Claude Code, Claude Desktop, and Cursor (`.cursor/mcp.json`):

```json
{ "mcpServers": { "doklo": { "command": "doklo", "args": ["mcp"] } } }
```

MCP clients don't guarantee a working directory, so pass your project root explicitly:

```json
{ "mcpServers": { "doklo": { "command": "doklo", "args": ["mcp", "--root", "/path/to/your/project"] } } }
```

| Tool | Input | Returns |
| --- | --- | --- |
| `search_doks` | `query` | `query`, `total`, and `results[]`: `dok_id`, `name`, optional `description`, `status`, `is_stale`, `matched_on` |
| `get_dok` | `dok_id` | `dok_id`, `name`, `description`, `status`, `tags`, `surfaces`, `user_actions`, `business_rules`, `acceptance_criteria`, `source_anchors`, `is_stale` |
| `list_doks` | `status?` / `service?` / `stale?` | `total` and `doks[]`: `dok_id`, `name`, `status`, `tags`, `is_stale`. An `unknown` Dok matches neither boolean stale filter |

These tools can return Doks in any lifecycle state. Inspect `status`: `draft` is AI-generated and pending human review; only `active` means it has crossed the explicit review transition. Freshness is a separate signal and never certifies semantic correctness.

`is_stale` is tri-state on all three successful payloads: `true` means a tracked source file is missing or its recomputed hash differs; `false` means the stored hash still matches, or the tracked sources changed in form only (comments, whitespace, line endings); `"unknown"` means the Dok has no stored hash or its tracking was generated by an unverified older extractor. Recovered tracking that still needs document review is stale. If the workspace cannot be resolved, read, or parsed, the tool call returns an MCP error instead of a successful `unknown` payload. This detects source drift only — `false` does not verify that a Dok is factually correct or complete.

### For coding agents

Before changing a feature, use `search_doks` and `get_dok` through the read-only Doklo MCP server. Pass the project root explicitly when configuring the server. Without MCP, use `doklo show` to find a Dok and `doklo show <ID> --json` to inspect it from the project directory.

Check both lifecycle and freshness. A `draft` has not been reviewed by a person. An `active` Dok has crossed the review transition, but may still be stale or incomplete. `is_stale: false` only means the tracked source hash matches; `unknown` does not mean fresh. Compare claims with source code when accuracy matters and report conflicts.

Use existing Doks during development. After integration on the configured recording branch, run `doklo sync --check --json` from its clean checkout when the recording workflow is authorized. Read the final JSONL result and diagnostics as well as the exit code. Do not request recording on every development commit or silently regenerate, force-overwrite human edits, or mark a Dok active to make a check pass.

When the user requests new documentation, initialize with `doklo init --yes --json`, then generate drafts using the approved model route. Generation can send selected source excerpts to a model provider. After generation or regeneration, direct the user to `doklo serve --open` to review drafts in Studio. Execution consent does not approve the resulting document.

The current keyless Claude Code route is available for `generate`; do not assume `sync` supports the same route. If the required route is unavailable, report the limitation instead of silently switching providers.

Before running `generate` or `sync`, show the person the source files to be sent, model route, token estimates, and safety limits, and get consent for that run. Use non-interactive `-y` only to carry that consent.

The same guidance is included in the published package as [`AGENT_GUIDE.md`](./AGENT_GUIDE.md).

## How it works

Doklo builds a **Hub** — a small set of JSON files that capture what your product does, kept in your repo:

1. **scan** — extract a deterministic intermediate representation (IR) of your code (routes, components, state, roles).
2. **consolidate** — group scattered code into coherent business features.
3. **generate** — an LLM writes one source-grounded **Dok** per feature with `status: "draft"` (intent, user actions, business rules, acceptance criteria), with provenance anchors back to source files. A person explicitly promotes the draft to `active` before treating it as reviewed product context.

The Hub is written to `.doklo/hub/`; tracked workspace state also includes root `workspace.json`, `.doklo/.gitignore`, and `.doklo/livedocs/` Publication definitions. Derived caches, debug traces, renders, and screenshots stay ignored by default. Review drafts in **Studio**, query Hub data through **MCP**, and render any of the 7 stable Live Docs; 9 additional templates remain explicitly experimental.

## Documentation

- [Plan a run and embed help in your app](./docs/en/first-run-and-embedding.md): service roots, token scope, Korean terminology, public format names, HTML fragments and output boundaries.

- English: [docs/en/](./docs/en/)
- 한국어: [docs/ko/](./docs/ko/) · [README.ko.md](./README.ko.md)
- [Changelog](./CHANGELOG.md) · [License](./LICENSE) (Apache-2.0)

## Notes

Installing needs network access: the published package declares its runtime dependencies (23 direct, 349 packages resolved) instead of bundling them, so npm has to reach the registry. Once installed, `init`, `scan`, `serve`, `mcp`, `live-docs render`, and `sync --check` run with no network at all. Only `generate` and a regenerating `sync` (which, with `--judge`, first asks a judge model) call a model provider.

`npx @mayp/doklo` re-checks its cache on every invocation and costs roughly 5-8 seconds each time; install globally if you are going to keep using it.

Rendered HTML help pages `@import` the Pretendard webfont from a CDN. With no internet access the page still renders and the font falls back to the system stack.

## License

License: **Apache-2.0**. Licensed under the Apache License, Version 2.0. See [LICENSE](./LICENSE) and [NOTICE](./NOTICE). Separate Doklo Cloud services and third-party components retain their own licensing terms.

### Product recording branch

See [Generation recovery and draft review](docs/en/generation-review.md) for scoped retries, draft previews and source-evidence boundaries.

Choose a branch during interactive `doklo init`, or pass `doklo init --recording-branch main`.
For an existing workspace, use `doklo recording --branch main`; `doklo recording --json` shows the setting.
The choice is stored in `workspace.json` and preserves existing Hub documents. Non-interactive init without
this option and existing unconfigured workspaces retain current-folder behavior.

Once configured, run scan, consolidate, generate and sync from a **clean checkout of that local branch**.
Doklo stops on another branch, detached HEAD or source changes; it never checks out, stashes or fetches for you.
Update your local branch from the release remote yourself before recording. `workspace.json` and `.doklo/`
changes are allowed so generated documents can be reviewed. Read-only Dok lookup remains available on work branches.

Old caches are not assumed to belong to the selected branch. Run `doklo scan`, then `doklo consolidate`
(with its normal model consent), before generation when prompted. Cache provenance binds the branch, source tree,
workspace configuration and cache bytes; it also records the commit. Documentation-only commits do not invalidate it. `doklo sync --check --json` remains a free, read-only check and
reports the recording branch and commit. Branch configuration does not enable automatic CI or Live Review.

### Token limits and agent skills

LLM execution plans and results use tokens, without monetary estimates. Defaults are 1,000,000 tokens per authorized run and 5,000,000 cumulative tokens per workspace token ledger (not a monthly reset). Cached input counts once alongside other input and output tokens. Missing usage keeps its conservative reservation.

```sh
DOKLO_MAX_TOKENS_PER_RUN=2000000 DOKLO_MAX_TOKENS_TOTAL=10000000 doklo generate
```

The preview shows the run cap, workspace usage/remaining tokens, and deferred work. Reservations use UTF-8 prompt bytes plus the output allowance; displayed input estimates use bytes / 4. These are estimates, not provider-enforced hard limits. Exceeding a configured cap stops subsequent calls. Legacy accounting files are preserved separately and cannot establish historical token totals. Existing Doks are skipped unless `--force` is requested.

`doklo init` installs project-local skills for Claude Code and Codex without editing AGENTS.md or CLAUDE.md. Claude Code also gets `.claude/rules/doklo.md`, a startup rule that directs feature investigations to the Doklo skill before source searches. Installation results are printed (or included in `data.agentSkills` with `--json`); conflicts are preserved and reported without undoing workspace initialization. For an existing workspace, preview, repair or remove the connection with:

```sh
doklo agent setup --target claude-code --preview
doklo agent setup --target claude-code
# or: doklo agent setup --target codex
doklo agent remove --target claude-code
```

Start a new client session to discover the skill. Automatic selection depends on the client and must be checked in a real session. Existing or modified skill files are preserved. Read-only Dok use is available before review; draft is not human approval, and active does not guarantee freshness. Review and approval currently use `doklo serve --open`; there is no CLI approval command. Drafts do not need approval before `sync --check` or regeneration. Human-edited Doks are protected from ordinary sync; approval, including bulk web approval, does not mark a Dok as edited.
