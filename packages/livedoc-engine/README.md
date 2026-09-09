# @doklo-beta/livedoc-engine

Handlebars-based template engine that turns a Doklo v5 Hub into **Live Docs**.

- **Base engine design:** [`2026-05-29-livedoc-template-engine-design.md`](../../docs/superpowers/specs/2026-05-29-livedoc-template-engine-design.md)
- **Base engine implementation plan:** [`2026-05-29-livedoc-template-engine.md`](../../docs/superpowers/plans/2026-05-29-livedoc-template-engine.md)
- **Current format-specific output contract:** [`2026-07-29-livedocs-format-specific-outputs-design.md`](../../docs/superpowers/specs/2026-07-29-livedocs-format-specific-outputs-design.md)
- **Current format-specific output implementation plan:** [`2026-07-29-livedocs-format-specific-outputs.md`](../../docs/superpowers/plans/2026-07-29-livedocs-format-specific-outputs.md)
- **Release status:** 16 built-in templates: **7 stable** (`feature-matrix`, `github-onboarding`, `help-index`, `help-page`, `keep-a-changelog`, `permission-gap`, and `release-digest`) and **9 experimental**. The default catalog exposes the stable set.

The engine accepts `(template, hub_data, locale) → outputs`. Templates are directory or single-file definitions anyone (PM, engineer, designer) can author and share. A Template may support multiple final formats, with either a shared natural source or a format-specific entry. A saved Publication selects exactly one of those final formats.

## 1-minute quickstart

From any v5 workspace:

```bash
# Stable customer help page from one reviewed Dok
doklo live-docs render help-page --format markdown \
  --dok ADMIN-BANN --locale ko

# Stable templates only (default), or the complete experimental catalog
doklo template list
doklo template list --experimental

# Show what a template needs
doklo template info help-page

# Start a brand-new template type
doklo template scaffold my-doc --scope per_dok

# Save, render, manually publish, and export a repeatable help set
doklo live-docs publication create product-help \
  --template help-page --status active --format markdown --locale en \
  --destination docs/help
doklo live-docs publication render product-help
doklo live-docs publication publish product-help
doklo live-docs publication export product-help

```

Screenshot capture is experimental and currently unavailable. Its direct command stays disabled until output publication satisfies the documented Doklo-exclusive [single-writer contract](../../docs/livedocs-publications-plan.md#41-dry-run과-렌더-증거) and an actual app → capture → stable document E2E is release-gated.

## Built-in templates — 16

Seven templates are stable release contracts. The other nine built-ins require explicit experimental discovery and emit an experimental warning when rendered directly or through a saved Publication. Stable workspace templates skip an unsafe Dok with `SKIPPED_STABLE_DOK` and continue with safe Doks, but fail when none are safe.

| Name | Stability | Scope | Outputs | Use case |
|---|---|---|---|---|
| `help-page` | stable | per_dok | `markdown`, `html` | Customer help article |
| `compliance-audit` | experimental | workspace | `markdown`, `html` | Compliance review draft |
| `feature-matrix` | stable | workspace | `markdown`, `html` | Product feature overview |
| `github-devguide` | experimental | per_dok | `markdown` | Engineering guide draft |
| `github-onboarding` | stable | workspace | `markdown`, `html` | Onboarding guide |
| `help-index` | stable | workspace | `markdown`, `html` | Product-navigation table of contents for a selected help set |
| `keep-a-changelog` | stable | workspace | `markdown` | Changelog |
| `korean-public-ppt` | experimental | per_dok | `pptx` | Public manual slide deck |
| `lean-arc42` | experimental | workspace | `markdown`, `html` | Architecture draft |
| `openapi-3.1` | experimental | workspace | `yaml`, `json` | OpenAPI draft |
| `ops-manual` | experimental | workspace | `markdown`, `hwpx` | Operations manual draft |
| `permission-gap` | stable | workspace | `markdown`, `html` | Permission review sheet |
| `release-digest` | stable | workspace | `markdown`, `html` | Evidence-based customer release digest |
| `rtm-trace` | experimental | workspace | `xlsx` | Traceability matrix |
| `saas-prd` | experimental | per_dok | `markdown`, `html` | PRD draft |
| `why-blocked` | experimental | workspace | `markdown`, `html` | Support troubleshooting index |

PPTX, XLSX, and HWPX rendering code is present, but those outputs are **experimental**, not stable. No official consumer-app validator is connected to the release gate. PDF and DOCX are not supported.

Saved Publications keep their selected Dok IDs frozen until an explicit `publication create --overwrite`. Evidence records both the requested `selected_dok_ids` and the `rendered_dok_ids` retained after stable public-copy checks; only retained Doks become the next `dok_snapshots` baseline. `release-digest` compares the refreshed selection with that prior successful baseline to classify added, changed, and retired Doks, and filters unsafe retired snapshot copy; it does not update itself. `help-index` projects selected Doks onto IA v2 route trees and falls back deterministically when no mapped tree is available.

`publication publish` manually copies only verified render outputs to a workspace-relative `repo_path` destination. Its destination ledger allows Doklo to replace or remove only files it previously published; foreign files and collisions remain untouched. `publication export` writes a deterministic sibling ZIP containing verified outputs, the manifest, and `publication-evidence.json`. Neither command provides automatic re-rendering, hosting, or CMS delivery.

## Authoring a template

**Full guide:** [`docs/livedoc-templates-authoring.md`](../../docs/livedoc-templates-authoring.md).

Fastest start — scaffold a complete, valid starter:

```bash
doklo template scaffold my-doc --scope per_dok
# → .doklo/templates/my-doc/{doklo-template.json, template.md.tpl, assets/style.css, README.md}
doklo template validate .doklo/templates/my-doc
doklo live-docs render my-doc --format markdown --dok DOK --locale ko
```

Or build by hand. A template is a directory with at minimum:

```
my-template/
  doklo-template.json   # manifest
  template.md.tpl       # Handlebars body
```

`doklo-template.json` (minimal shared-source Template):

```json
{
  "$schema": "https://doklo.dev/template-manifest-v2.json",
  "name": "my-template",
  "version": "1.0.0",
  "default_format": "markdown",
  "outputs": {
    "markdown": {
      "entry": "template.md.tpl",
      "output_path": "{{dok.dok_id}}.md",
      "source": "markdown"
    },
    "html": {
      "entry": "template.md.tpl",
      "output_path": "{{dok.dok_id}}.html",
      "source": "markdown"
    }
  },
  "scope": "per_dok",
  "supported_locales": ["en", "ko"],
  "default_locale": "en",
  "strings": {
    "en": { "intro": "Intro" },
    "ko": { "intro": "소개" }
  }
}
```

`template.md.tpl` (body):

```handlebars
# {{translate dok.name}}

## {{t "intro"}}

{{translate dok.description}}

{{#each dok.user_actions.steps}}
{{add @index 1}}. **{{actor_label this.actor}}** — {{translate this.intent}}
{{/each}}
```

Install it locally:

```bash
# Workspace-scoped (committed alongside the project)
cp -r my-template .doklo/templates/

# Or fetch from a git repo into ~/.doklo/templates/
doklo template add https://github.com/you/my-doklo-template
```

Then render:

```bash
doklo live-docs render my-template --format markdown --locale en
```

## Output recipes

Canonical manifest v2 uses `default_format` plus an `outputs` map keyed by final
format. Every recipe owns its `output_path` and `source`; directory text recipes
also own an `entry`. `default_format` is required for multiple outputs and must
name one of them. A single-output Template can omit it.

Final format and source syntax are separate contracts. `markdown` (normally a
`.md` file), `html`, `yaml`, `json`, `text`, `hwpx`, `pptx`, and `xlsx` are final
formats. `markdown`, `html`, `yaml`, `json`, `text`, and `binary` are source
syntaxes produced before the final writer runs.

| Final format | Allowed source syntax |
|---|---|
| `markdown` | `markdown` |
| `html` | `markdown`, `html` |
| `yaml` | `yaml`, `json` |
| `json` | `yaml`, `json` |
| `text` | `text` |
| `hwpx` | `markdown` |
| `pptx` | `binary` |
| `xlsx` | `binary` |

Share an entry when it is a natural intermediate representation. For example,
one Markdown entry can produce both Markdown and HTML, and one YAML entry can
produce YAML and JSON. Split entries when the presentation structure differs:

```json
{
  "default_format": "markdown",
  "outputs": {
    "markdown": {
      "entry": "template.md.tpl",
      "output_path": "{{dok.dok_id}}.md",
      "source": "markdown"
    },
    "html": {
      "entry": "template.html.tpl",
      "output_path": "{{dok.dok_id}}.html",
      "source": "html"
    }
  }
}
```

An HTML-heavy Template that promises Markdown must provide native Markdown. It
must not pass presentation HTML to the Markdown writer and call the raw HTML
file a `.md` output. Keep Hub interpretation in shared helpers, partials,
localized strings, and variables; keep format-specific presentation in the
entries.

Directory text recipes require `entry`. Binary PPTX/XLSX recipes use
`source: "binary"` and omit it. A single-file frontmatter Template cannot
declare entries; every compatible output shares its one body.

### Direct rendering

Direct multi-output rendering requires explicit intent:

```bash
# Exactly one declared final format
doklo live-docs render my-template --format html --locale en

# Every declared final format
doklo live-docs render my-template --all-formats --locale en
```

A sole-output Template may render without either selector. A multi-output
Template without one fails before writing. `--format`, `--all-formats`, and
legacy `--no-html` are mutually exclusive. `--no-html` remains only as
deprecated compatibility behavior for the former “all declared formats except
HTML” fan-out; new integrations should not use it.

Saved Publications do not fan out. Each Publication stores one final `format`.
Create two Publications when Markdown and HTML need independent official
delivery definitions.

### Legacy manifest normalization

The parser still accepts top-level `output_formats`, `entry`, and `output_path`
and immediately normalizes them into recipes when one source family is
unambiguous:

- `markdown` / `html` / `hwpx` use Markdown source;
- `yaml` / `json` use YAML source;
- `text` uses text source;
- `pptx` / `xlsx` use binary source.

Cross-family legacy combinations such as `["markdown", "json"]` are rejected
with a request to define explicit output recipes. New and built-in Templates
must use canonical manifest v2. Renderer invariants still apply:
`renderer: "pptx"` permits only a sole `pptx` output with `scope: "per_dok"`,
and `renderer: "xlsx"` permits only a sole `xlsx` output.

## Helpers (v1)

All available in any template body.

| Helper | Purpose |
|---|---|
| `translate value` | `Translatable` → active locale string |
| `t "key"` | frontmatter `strings` lookup |
| `actor_label actor` | `Actor` union → label (role / system / external) |
| `role_label "ROLE-X"` | role_id → translated role.name |
| `service_label "web"` | service_id → display label |
| `surface_label ref` | v1 stub (returns ref); v1.1 ia.json path |
| `format_date iso` | locale-aware long form |
| `markdown text` | inline Markdown → HTML |
| `add`, `sub`, `eq`, `ne`, `gt`, `lt`, `gte`, `lte`, `len`, `join`, `default` | basics Handlebars omits |

Standard Handlebars built-ins (`each`, `if`, `unless`, `with`, `lookup`, `@index`, partials) work as normal.

## 3-source distribution

Templates are resolved in this precedence order:

1. **Workspace** — `<workspaceRoot>/.doklo/templates/<name>/` (committed with the project)
2. **User** — `~/.doklo/templates/<name>/` (installed via `template add`)
3. **Built-in** — shipped with this package

Override with `--source workspace|user|builtin`. `doklo template list` shows stable templates only; use `doklo template list --experimental` for the complete catalog.

## Selector model — subset-of-Doks templates

For per_dok templates that target only a slice of the Hub (e.g., tutorial-tagged Doks), declare a `selector` in the manifest:

```json
{
  "name": "user-tutorial",
  "version": "1.0.0",
  "default_format": "markdown",
  "outputs": {
    "markdown": {
      "entry": "template.md.tpl",
      "output_path": "{{dok.dok_id}}.md",
      "source": "markdown"
    }
  },
  "scope": "selected_doks",
  "supported_locales": ["en"],
  "default_locale": "en",
  "selector": {
    "include_tags": ["tutorial"],
    "include_statuses": ["active"],
    "explicit_ids": ["DOK-SPECIAL"],
    "exclude_tags": ["internal"]
  }
}
```

Semantics: fields AND across categories, arrays OR within; `explicit_ids` is unconditional (force-include). CLI `--dok <id>` overrides the selector entirely.

## Output flow

1. **Template source** — one shared or format-specific entry plus
   `doklo-template.json`.
2. **Declared source syntax** — validated according to the selected recipe.
3. **Final artifact** — serialized by the selected final-format writer.

PPTX, XLSX, and HWPX are accepted only for experimental templates until official consumer validation exists. PDF and DOCX are rejected.

## Programmatic API

```ts
import { renderLivedoc } from '@doklo-beta/livedoc-engine';

const { outputs, manifest } = await renderLivedoc({
  workspaceRoot: '/path/to/workspace',
  templateRef: 'help-page',
  locale: 'ko',
  outDir: '/tmp/out',
  dokIds: ['AUTH'],             // optional override
  format: 'markdown',           // required for a multi-output Template
});
```

Public surface: `renderLivedoc`, `listTemplates`, `resolveTemplate`, `parseTemplate`, `parseTemplateManifest`, `selectDoks`, `EngineError`, `ENGINE_VERSION`. See `src/index.ts`.

## Manifest report

Every render writes `<outDir>/livedoc-manifest.json` (spec §10) with translation telemetry, warnings, and output records. CI assertions or Studio integrations can read it to surface unresolved terms or selector counts.
