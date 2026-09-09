# @doklo-beta/generator

LLM-based Dok generation from Doklo IR.

**Status:** stub.

## Responsibilities

- Load prompt template (`prompts/dok.<locale>.md`) per workspace `default_locale`
- Inject deterministic extracts (routes, i18n, RBAC) into prompt
- Call Anthropic with prompt caching enabled
- Validate LLM output against `LLMResponseSchema`
- Emit cost telemetry via `@doklo-beta/cost`
