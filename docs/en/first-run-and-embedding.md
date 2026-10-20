# Plan a run and embed help in your app

These examples describe the current source. Check the installed CLI's `--help` before using new options.

## Choose the workspace and source roots

The workspace root owns `workspace.json`, the Hub and output files. A service's `code_root` selects the source directory inside that workspace. For a repository containing `web/` and `server/`:

```sh
doklo init --root . --code-root web --service-id web --default-locale ko --supported-locales ko --yes
doklo scan --root . --json
```

This keeps Doklo state at the repository root while analyzing `web/`. Next.js App Router receives specialized extraction when detected at that service root. Other code uses generic source analysis, including Python. Generic analysis does not establish that every framework convention or backend behavior was understood. Review the reported source scope, parser and exclusions (`scan --json` includes the exact `includedFiles` paths relative to each service root); sibling services are not included just because they share the repository.

To add the server, append a service to the existing `services` array in `workspace.json`, preserving other fields and services:

```json
{"service_id":"server","type":"backend","framework":"fastapi","code_root":"server"}
```

Then run `doklo scan` again. Source roots must be existing contained relative directories. Parent paths, absolute paths and symlinks that escape the workspace are rejected.

## Agent integration files

By default, `doklo init` installs project-local integration files for Claude Code and Codex without adding another prompt. Human output lists their purpose and every created, unchanged or preserved path. JSON output includes `agentSkillsRequested`, `agentSkillsStatus`, `agentSkillsPurpose` and the per-target `agentSkills` results.

Use `--no-agent-skills` to initialize the workspace without inspecting or changing `.claude` or `.agents`. It also works with noninteractive setup:

```sh
doklo init --root . --code-root web --yes --no-agent-skills
```

Install the files later with `doklo agent setup --target claude-code` and `doklo agent setup --target codex`. Setup is idempotent for exact Doklo-managed content. Customized files are preserved, and symlinked or non-regular paths are refused. A second `doklo init` is still rejected once `workspace.json` exists; use `doklo agent setup` for agent integration changes in an existing workspace.

## Inspect before paying

```sh
doklo generate --dry-run
doklo consolidate --dry-run
doklo consolidate --service web --dry-run
```

A missing consolidation plan is not a zero-document result. Before consolidation, the CLI can show discovered source candidates and grouping scope; the final Dok IDs/count remain unknown until the model groups the features. Consolidation can incur provider charges. `--service` narrows that phase. After consolidation, `generate --only CHAT,CHILD --dry-run` previews specific known Dok IDs.

Token estimates are approximate, not a price quote or provider-enforced ceiling. Inspect the actual phase/model, input estimate, output estimate or unknown value, and separate maximum output allowance. Cache behavior is unknown before the call. Generation's base estimate and its allowance for configured retries have different scopes. Actual results include attempted failures when the provider reports usage; unavailable usage is not zero. Compare estimates and measurements for the same phase and attempted calls. A consolidation group is not a guaranteed Dok count.

Run without `--dry-run` only after reviewing the source/model plan. The normal approval boundary remains in place. The supported backends are `claude-code` and `anthropic-api`; for example:

```sh
doklo generate --llm-backend anthropic-api --dry-run
```

## Review Korean names and canonical terminology

New standard role display names follow the workspace locale; IDs such as `ROLE-USER` remain stable. Existing curated names are preserved. In Studio, edit the existing role's display name rather than deleting and recreating the role. A product term such as “guardian” does not establish a new permission role.

Select Korean customer prose with `formal` (default, 합쇼체: “확인합니다”) or `plain` (해라체: “확인한다”). Use `doklo init --korean-tone formal` during setup, or edit `korean_customer_tone` in an existing `workspace.json`. Generation includes the selected policy in the prompt and records that policy and field-level writing concerns in Dok metadata.

Official Korean help-page rendering checks clear sentence-ending conflicts in the final text after term references and explicit audience substitutions. A policy change since generation also requires review. Correct the prose or selectively regenerate and review it before publishing. `--preview` provides a marked review artifact with warnings and preserves Hub state. Quotes and names or labels are excluded; this conservative check does not guarantee every sentence's grammar or naturalness. Existing English role names, synonyms and sentence endings are never rewritten automatically.

To retain manually corrected prose after changing policy without regeneration, a person must review that Dok's customer wording against the new policy, then add `policy_acknowledgment` to its existing `_meta.writing_review` in `.doklo/hub/doks/<Dok ID>.json`. This example acknowledges `plain`; replace its timestamp with the actual UTC review time. Preserve other fields and the original generation provenance in `_meta.writing_policy`.

```json
{"policy_acknowledgment":{"locale":"ko","tone":"plain","acknowledged_at":"2026-09-25T00:00:00.000Z"}}
```

The manual record resolves the policy-change diagnostic only when it matches the current policy. Remaining sentence-ending conflicts still block output, and the Dok's approval status stays unchanged. Editing prose or approving a Dok in Studio does not create this record automatically. Regeneration clears the previous acknowledgment, so review the new output again.

In Studio, promote reviewed Dok text to a term through its text editor, then inspect and edit the term in Lexicon. After consolidated features or Doks exist, optionally preview `doklo lexicon-suggest --dry-run`, then approve a separate paid suggestion run. Accept or edit suggestions in Studio before treating them as canonical. Pending suggestions are not canonical generation instructions. Approved owned/constant display text and explicit TermRefs are supported; i18n bindings are not currently resolved directly. After confirming terms, selectively regenerate affected drafts with `doklo generate --only CHAT --force`, inspect the changes, and review before publishing. Acceptance alone does not rewrite existing literal prose.

For explicit, reviewed corrections to existing customer output, `.doklo/audience-text.json` supports locale-specific text replacements:

```json
{"ko":{"취소한다":"취소합니다"}}
```

This is a render-only substitution, not a lexicon approval or a change to the source Dok. Inspect the result; broad replacements can affect unintended sentences. Prefer correcting the original draft and using explicit term references for durable terminology.

## Public file formats

JPEG, PNG, WebP, HEIC and HEIF are recognized public format names. If another public product name matches an identifier pattern, add it to the existing root `workspace.json`:

```json
{"stable_public_terms":["ExampleCompany"]}
```

Merge this field into the workspace; do not replace the whole file. Entries match exactly and affect only identifier-pattern lint. Internal Dok IDs, source paths, implementation details, unfinished copy and unsupported freshness claims remain checked. Allowing `WebP` does not allow `WebPEncoder`.

## Embed multiple help articles

```sh
doklo live-docs render help-page --dok CHAT --format html --locale ko \
  --var html_fragment=true --var heading_level=2 \
  --out-dir .doklo/output/help-fragments
```

Add `--preview` for draft review. The unreviewed notice remains in the fragment and the Hub stays unchanged. Preview artifacts cannot serve as official Publication evidence.

Fragment output is a semantic article without a document shell, scripts or embedded stylesheets. Screenshot coordinates and the persistent preview notice can retain inline style attributes. It retains `lang`, heading/section IDs, accessible label references and the `help-*` class names. Article IDs include the full Dok identity. Use a distinct `--var id_prefix=sidebar` if the same Dok appears twice in one page. Set `heading_level` to an integer from 1 to 5; the sections use the following level. Place articles below the host page's title and use the emitted IDs for navigation links.

Apply your app tokens through scoped selectors:

```css
.doklo-help { color: var(--text-color, #202124); }
.doklo-help .help-title { font: inherit; font-size: 1.5rem; }
.doklo-help .help-section-title { font-size: 1.125rem; }
.doklo-help:focus, .doklo-help :focus { outline: 2px solid currentColor; outline-offset: 3px; }
```

Default full-document rendering remains available when `html_fragment` is omitted. Do not import its page-wide reset stylesheet into your host application. After composing articles, check duplicate IDs, heading order and keyboard navigation in the actual app.

## Place outputs safely

`--out-dir` is resolved against the workspace root and must remain inside it, including all path components. It is not relative to the service's `code_root`, and the workspace is not automatically the repository root. An absolute path inside the workspace is supported; a sibling/outside destination or symlinked output path is not.

For an in-workspace app, a saved Publication can publish reviewed HTML directly into a dedicated directory:

```sh
doklo live-docs publication create customer-help --template help-page \
  --status active --format html --locale ko --destination web/public/help
doklo live-docs publication render customer-help
doklo live-docs publication publish customer-help --dry-run
doklo live-docs publication publish customer-help
```

If the workspace itself is `web/`, use `public/help`. Publish preserves its existing ownership and overwrite checks. To deliver to a sibling application, first publish to a dedicated staging directory inside the workspace, inspect it, and copy the intended customer files to a **new, nonexisting versioned directory** in the destination app. Reject symlinked destination components, do not merge into an existing directory, and inspect the app before switching its reference to the new version. This explicit external copy is an application deployment step outside Doklo's output boundary.

`doklo live-docs publication export customer-help --zip-path .doklo/output/customer-help.zip` creates a verified ZIP inside the workspace. The ZIP also contains manifests and evidence: extract it to private staging and copy only intended customer assets into `public/`.
