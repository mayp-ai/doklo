# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.3.1] - 2026-09-25

### Added
- Contained `init --code-root` selection for monorepos, with scan strategy,
  included source paths and analysis limits reported for each service.
- Sanitized help-page HTML fragments with configurable heading levels and
  namespaced IDs for embedding multiple articles in an application.
- A shared Korean customer writing policy for generation and official help-page
  rendering, with explicit review of policy changes and sentence-ending conflicts.

### Fixed
- Distinguish missing consolidation plans from real zero-item generation plans.
  Show source candidates before paid work, separate estimates from output limits,
  and retain reported consolidation usage after later cancellation or failure.
- Recognize public image-format names without relaxing internal Dok ID checks.
- Localize new standard role names while preserving existing curated names, and
  use only confirmed terminology as canonical generation instructions.
- Explain workspace output boundaries and supported Publication/export paths.

### Upgrade notes
- Existing documents, curated role names and literal prose are not automatically
  rewritten or approved. Review terminology and writing policy before selectively
  regenerating drafts; consolidation and generation may incur model costs.
- Official Korean help-page output can stop on a clear writing-policy conflict.
  Correct and review the source prose or use marked draft previews for inspection.
  The conservative check does not certify grammar or documentation accuracy.
- HTML fragments preserve draft notices and require host-page styling. Output
  containment, sanitization and Publication review safeguards remain enabled.

## [0.3.0] - 2026-09-24

### Added
- Bounded generation retries for malformed JSON and truncated responses, with
  attempt/token reporting and selected-ID recovery through `--only`.
- Stable Markdown/HTML draft previews through `live-docs render --preview`, with
  visible draft notices and preserved Hub review status. Customer-copy checks
  remain enabled; previews cannot become official saved Publication evidence.
- Separate service-root product intent and private model content-review metadata,
  with diagnostics for reported concerns. Model review does not approve a Dok.

### Fixed
- Preserve existing documents when explicitly requested regeneration fails, and
  report partial generation failure through the command exit result.
- Exclude auxiliary-only style, asset and configuration units from new feature
  candidates while retaining source inventory and unconnected-source review.
- Narrow Next.js cross-screen helper evidence to required declarations and
  executing module initialization. Retain full dependencies for drift detection
  and reject outdated source ranges or source changed during generation.
- Reject the reported internal invitation-address storage wording in customer
  Live Docs output.

### Upgrade notes
- Retry defaults allow one extra attempt; `--retries 0` disables retries and
  `--retries 2` permits up to two. Retry usage is included in consent and token
  limits and may incur additional model charges.
- Existing caches need a new scan and consolidation for the improved source
  boundaries. Consolidation may incur model costs. Existing Hub documents are
  not automatically rewritten, deleted or approved.
- Static reachability and model content concerns are review aids, not guarantees
  of complete extraction or accurate documentation. The package remains a
  developer preview.

## [0.2.1] - 2026-09-23

### Changed
- Separate supported features, existing-document tracking recovery, and current
  limitations in the English and Korean npm READMEs.
- Clarify that ordinary sync preserves human-edited documents, while
  `doklo sync --force` overwrites their edits without automatic merging.
- Distinguish the available local Dok review UI from the Live Review integration
  that is not included in this preview. This release changes documentation only;
  runtime behavior and existing limits are unchanged.

## [0.2.0] - 2026-09-23

### Added
- Generic source analysis, Dok generation, and change detection for projects
  without a dedicated framework parser, including projects without package.json.
  Next.js App Router retains its specialized route and dependency extraction.
- Korean installation, review, and coding-agent guidance in the repository and
  the published package.

### Fixed
- Revalidate source permissions for cached analysis, framework detection, change
  checks, and prepared generation inputs. Files excluded after generation
  approval are checked again before model access.
- Preserve separate dependency versions in the installed Studio bundle so Dok
  and Live Docs pages can load their required modules.

### Changed
- The default npm installation uses the `latest` channel for 0.2.0. The package
  remains a developer preview, with generated drafts requiring human review.
- Generic analysis excludes known sensitive paths, ignored files, dependencies,
  build output, binary files, and files over 1 MiB. Feature source above 192,000
  characters is rejected rather than silently truncated.

## [0.1.0] - 2026-09-09

### Security
- Live Docs Publication renders now prove containment on the output directory
  *and* on the `publication-evidence.json` inside it before either is opened.
  A symlink at the output directory, at any segment above it, or at the
  evidence file itself previously let a render read a file outside the
  workspace; the resulting parse error also echoed the file's leading bytes
  back to the caller. Such a render now fails with
  `PUBLICATION_OUTPUT_DIR_INVALID` or `PUBLICATION_EVIDENCE_INVALID`, and no
  evidence diagnostic carries file contents any more — including for files
  that are genuinely inside the workspace.
- `.doklo/audience-text.json` is now resolved under the workspace and required
  to be a regular file before it is opened. A symlinked dictionary previously
  let `doklo live-docs render` parse a file outside the workspace and apply its
  substitution rules to generated document text. Such a dictionary is now
  skipped and reported as `AUDIENCE_TEXT_REJECTED`; renders still succeed,
  since the dictionary is optional.
- Known limitation: path containment cannot detect a **hard link** to a file
  outside the workspace, because a hard link is indistinguishable from the file
  itself at the path layer. Treat write access to a workspace as trust in it.

### Fixed
- `doklo live-docs publication render` no longer fails permanently with a
  `retryable` `PATH_IDENTITY_CHANGED` when the output directory already exists
  but is empty; the empty directory is replaced atomically.
- `doklo sync` and `doklo generate` no longer print the AI SDK warning about
  system-role messages to the terminal.

### Changed
- Korean generation: when the workspace `default_locale` is `ko`, Dok text is
  requested in the formal polite register (합쇼체), without intention formulas
  ("~하고자 한다"), without commas after connective endings, and without code
  names inside Korean sentences.
- The public CLI, local web workbench, and analysis packages are licensed
  under Apache-2.0. Existing third-party notices are preserved.
- Unsupported projects now receive `UNSUPPORTED_FRAMEWORK` guidance that names
  a detected framework when available, states the current Next.js App Router
  boundary, and points to the planned NestJS, Express, and AI-draft paths.
- `resolveTheme` now returns the canonical (symlink-resolved) path for
  `logo.asset` and `cover.background_image` instead of a lexically rebuilt one.
  Callers that compare these values against a hand-joined path must compare
  against the canonical form.
- **Lexicon is now a domain-term dictionary.** Categories narrowed to
  `concept`/`role`; UI-string categories
  (`navigation`/`button`/`error`/`label`/`message`) are no longer valid.
  Rebuild existing lexicons via `doklo lexicon-suggest`.
- `doklo generate` now extracts lexicon term candidates *before* per-Dok
  generation (one extra LLM call, skipped when terms already exist) and
  injects them into the generation prompt so Dok texts use consistent
  terminology. Opt out with `--no-lexicon`.
- `doklo lexicon-suggest` picks its corpus automatically (Dok bodies when
  Doks exist, consolidated features + i18n values otherwise); force with
  `--corpus doks|code`, inspect with `--dry-run`.

### Removed
- `doklo lexicon` (i18n-key dump). i18n display values now feed the
  suggester as corpus material instead of becoming terms directly.

### Added

**CLI**

- `help-index` template variable `link_prefix` (default `./`) so an index can be published one folder above its articles (`--var link_prefix=./pages/`).
- `workspace.json` field `stable_public_terms`: customer-facing proper nouns that the stable identifier lint publishes verbatim instead of skipping the Dok.

- `doklo init` — bootstrap a workspace: auto-detect your framework, record and authenticate a model choice, scan your code, and write the Hub skeleton to `.doklo/` with a `.gitignore` allowlist (commit the Hub, ignore derived output). The picker is a broader research catalog; `generate` still enforces the current production trust gate.
- `doklo scan` — extract a deterministic intermediate representation (IR) of every service (routes, components, state, roles).
- `doklo consolidate` — group scattered code into coherent business features.
- `doklo generate` — write one source-grounded `draft` Dok per feature; previews cost before running and auto-runs scan + consolidate when needed. The current production route accepts `anthropic/claude-sonnet-5` through direct Anthropic or an explicitly selected local Claude Code backend.
- `doklo show` — pretty-print a Dok by id, or list every Dok in the Hub.
- `doklo roles` — suggest RBAC role candidates from the scan.
- `doklo lexicon-suggest` — have the LLM nominate domain terms for review from the automatically selected Dok or code corpus.
- `doklo evaluate` — score generated Doks against the quality criteria.
- `doklo model` / `doklo auth` — choose the model for a task and store provider keys (BYOK); sign in with ChatGPT for OpenAI.

**Studio**

- `doklo serve` — launch Doklo Studio, a local web workbench to review and edit Doks, roles, and lexicon; runs the packaged build or a dev server, with `--open` to jump straight into onboarding.

**MCP**

- `doklo mcp` — serve the Hub to AI agents (Claude Code, Cursor, and others) over a read-only stdio MCP server: `search_doks`, `get_dok`, and `list_doks`, each carrying lifecycle `status` and an `is_stale` freshness signal. Consumers must treat only explicitly human-promoted `active` Doks as reviewed.

**Live Docs**

- `doklo live-docs render` — render Live Docs from the Hub. The stable public contract now covers `feature-matrix`, `github-onboarding`, `help-index`, `help-page`, `keep-a-changelog`, `permission-gap`, and `release-digest`. Stable templates accept only `active` Doks; explicitly selecting a non-active Dok fails with `UNREVIEWED_DOK`. Stable workspace renders skip an unsafe Dok with `SKIPPED_STABLE_DOK` and continue with the remaining safe Doks, but fail when none are safe. The other nine templates and all binary formats remain experimental.
- Stable Publication evidence now distinguishes the requested `selected_dok_ids` from the `rendered_dok_ids` that survived public-copy checks. Only rendered Doks become the next change-classification baseline, and unsafe retired snapshots are skipped before a stable release document is written.
- Stable public-copy checks now reject angle-bracket placeholders, raw role identifiers, and generator-confidence provenance. Repository onboarding omits guessed setup commands and exposes localized role names without internal IDs or scan metadata.
- `doklo live-docs capture` is experimental and currently unavailable. Its hidden direct command fails closed before browser or filesystem access until output publication is race-safe and an app → capture → stable document E2E is release-gated.
- `doklo template` — list, inspect, validate, scaffold, add, and remove Live Doc templates across built-in, user, and workspace sources.

[0.3.0]: https://github.com/mayp-ai/doklo/compare/v0.2.1...v0.3.0
[0.2.1]: https://github.com/mayp-ai/doklo/compare/v0.2.0...v0.2.1
[0.2.0]: https://github.com/mayp-ai/doklo/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/mayp-ai/doklo/releases/tag/v0.1.0
