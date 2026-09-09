# @doklo-beta/studio

Web UI for Dok review and editing — the human-friendly editing surface that obviates the need for raw JSON editing.

**Status:** stub. To be scaffolded as a Next.js app after the CLI MVP works end-to-end.

## Why

Per the v5 design, Dok storage is JSON (per-file under `.doklo/hub/doks/`), but PMs and designers should never need to edit raw JSON. Studio renders the same Dok state as forms and tables, with structured fields for `intent / outcome / variants / business_rules / acceptance_criteria`.

## Running Studio in development

Studio always renders the workspace at `DOKLO_WORKSPACE_ROOT`, and nothing else.
There is no implicit fallback: point it at a real project, the way `doklo serve`
does.

```bash
DOKLO_WORKSPACE_ROOT=/path/to/your/project pnpm dev
```

The bundled sample workspace under `demo/` is for development and acceptance
tests only. It never ships (the release build drops it and a content guard fails
the build if it reappears), and it now opens only when asked for by name:

```bash
pnpm dev:demo   # opens demo/, permanently labelled "Demo data" in the UI
```
