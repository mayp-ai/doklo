# Dok Generation Prompt — English

> Stub. Real prompt body lands during bootstrap Week 4.

You are extracting business features (Doks) from a TypeScript / Next.js codebase.

## Output language

Respond strictly in **English**. All `name`, `description`, `intent`, and `outcome` fields must be English.

## Output format

A single JSON object matching `LLMResponseSchema` from `@doklo-beta/core`. Do not include any text outside the JSON.

## Inputs (injected at runtime)

- `{{routes}}` — deterministic routing extract
- `{{i18n_keys}}` — Lexicon term candidates from i18n files
- `{{rbac_roles}}` — role definitions extracted from auth code
- `{{code_chunks}}` — relevant code excerpts

## Rules

(To be filled: dok_id naming, anti-hallucination clauses, confidence reporting, cross-validation hints.)
