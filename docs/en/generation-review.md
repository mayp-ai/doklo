# Generation recovery and draft review

For source-root selection, preflight estimates, canonical terminology, HTML fragments and output placement, see [Plan a run and embed help](first-run-and-embedding.md).

This guide describes the current source. Check your installed release's `doklo generate --help` and `doklo live-docs render --help` for available options.

## Recover failed documents

`generate` retries malformed JSON or truncated model responses once by default. Use `--retries 0` to disable retries or `--retries 2` for up to two additional attempts. Retries participate in execution consent and token caps and may incur additional provider charges. Results include attempts, retry usage and final failures. Partial failure does not return a successful exit status.

```sh
doklo generate --only CHAT
doklo generate --only CHAT,CHILD --retries 0
```

Existing Doks are skipped by default. Use `--only CHAT --force` only to intentionally regenerate that existing document; failure preserves its original contents. If source identity changed, run `doklo scan` and `doklo consolidate` before retrying. Consolidation may require a paid model call.

## Preview drafts

```sh
doklo live-docs render help-page --dok CHAT --format html --preview
```

Preview supports stable Markdown and HTML templates. Output defaults to `.doklo/output/preview/` and carries an unreviewed-draft notice. Hub status and approval history remain unchanged. Normal rendering still requires reviewed documents, and customer-copy checks remain enabled in previews. Preview output cannot serve as official saved Publication publish/export evidence.

## Review scope and wording

New scans and consolidation exclude auxiliary-only style, asset and configuration units from feature candidates while retaining source inventory. Source candidates without page-import reachability require review. Static import analysis does not prove all dynamic or framework wiring. Existing Hub documents are not automatically removed.

For Next.js cross-screen helper imports, evidence includes required declarations, dependencies and executing module initialization. The full dependency closure remains available for drift detection. Older caches require `doklo scan` followed by `doklo consolidate` to acquire these source boundaries. Review existing documents before selectively regenerating with `--only <ID> --force`.

An inventoried `PRODUCT.md` or `VISION.md` at the selected service source root is supplied separately as product intent. Parent-repository, example and archived briefs are not automatically included. Intent does not establish implementation: planned features must not become claims of implemented behavior.

Model-reported scope conflicts, implementation details and missing evidence are stored in `_meta.content_review`. Nonempty concerns produce `CONTENT_REVIEW_REQUIRED` CLI diagnostics. `reported: false` means the model did not submit its review result; even an empty concern list is neither an accuracy guarantee nor approval. Review customer wording for actions and outcomes instead of internal storage conventions.
