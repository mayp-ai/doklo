# Feature Consolidation Prompt — English (placeholder)

> **Status:** Not yet wired in. The active prompt is built inside
> `consolidator.ts::buildConsolidationPrompt`. Externalization to per-locale
> .md files is a follow-up task.
>
> When externalized, the consolidator will pick this file vs `consolidate.ko.md`
> based on `workspace.default_locale`.

The current consolidator prompt is in English instructions with English
labels and reasons. To externalize, copy the body of
`buildConsolidationPrompt` here and replace these placeholders:

- `{{projectName}}` — workspace name
- `{{featureGroups}}` — auto-rendered group/feature listing
