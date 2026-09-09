# @doklo-beta/cli

`doklo` command-line tool.

**Status:** implemented local-first CLI. Mutating commands use workspace containment and atomic writes; generation remains BYOK and requires explicit provider consent.

## Runtime support

| Contract | Supported |
|---|---|
| Framework | Next.js |
| Router | App Router only |
| App roots | `app`, `src/app` |
| Source extensions | `.ts`, `.tsx`, `.js`, `.jsx` |
| Node.js | `>=20.9.0` |

`init`, `scan`, and generate auto-scan/consolidation reject Pages Router-only
and non-Next.js projects before mutating or extracting project data.

## Network scope

Installation needs the network: the published package declares its runtime
dependencies (23 direct, 349 packages resolved) instead of bundling them.

After installation, `init`, `scan`, `serve`, `mcp`, and `live-docs render` need
no network; `generate` is the only command that calls a model provider.

`npx @mayp/doklo` re-checks its cache on every invocation (~5-8s per call).
Install globally for repeated use.

HTML renders `@import` the Pretendard webfont from a CDN, so on a machine with
no internet access the page renders and the font falls back to the system stack.

## Main commands

- `doklo init` — initialize a workspace, ask language preferences, detect framework
- `doklo scan` — analyze code without generating Doks (preview)
- `doklo generate` — full pipeline: extract → LLM → write Hub
- `doklo serve` — launch Doklo Studio UI on localhost
- `doklo live-docs render help-page --dok <DOK-ID>` — render the stable customer help-page
- `doklo live-docs publication create|list|inspect|render` — persist and reproduce a selected Live Doc
- `doklo template list` — show 7 stable templates; add `--experimental` to inspect all 16 built-ins

## Live Docs release boundary

The built-in catalog contains **16 templates: 7 stable** (`feature-matrix`, `github-onboarding`, `help-index`, `help-page`, `keep-a-changelog`, `permission-gap`, and `release-digest`) and **9 experimental**. Stable templates accept only active reviewed Doks; a stable workspace render skips unsafe Doks with `SKIPPED_STABLE_DOK` and continues when at least one Dok is safe. Direct experimental renders and Publication create/list/inspect/render results expose `EXPERIMENTAL_TEMPLATE` diagnostics instead of presenting them as stable output.

PPTX, XLSX, and HWPX are experimental because the release gate has no official consumer-app validation. Screenshot capture is experimental and currently unavailable; it stays disabled until output publication is race-safe and an actual app → capture → stable document E2E is connected. Live Docs are snapshots; rerun `render` to include later Hub changes.

## Language

CLI output language is controlled by `DOKLO_LANG` env var (`en` default, `ko` available).
