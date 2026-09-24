# Doklo — developer preview

Doklo reads supported application code and creates feature-document drafts for people to review. This Apache-2.0 preview provides a local CLI, a review UI, and a read-only MCP server.

## Install

```bash
npm install -g @mayp/doklo
```

Version 0.3.1 requires Node.js 20.9 or newer, with one project per workspace.

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
  (`formal` by default, or `plain`). Official Korean help-page output reports and
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
