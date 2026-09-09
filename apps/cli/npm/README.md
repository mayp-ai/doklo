# Doklo — developer preview

Doklo reads supported application code and creates feature-document drafts for people to review. This Apache-2.0 preview provides a local CLI, a review UI, and a read-only MCP server.

## Install

```bash
npm install -g @mayp/doklo@preview
```

Requires Node.js 20.9 or newer. This preview supports Next.js App Router, with one project per workspace. The release acceptance exercise covered the BTV upload feature; broad framework coverage and improvements to AI answer quality have not been demonstrated.

## Start in your project

```bash
doklo init
doklo generate
doklo serve --open
doklo sync --check
```

Initialization records your model and branch choices, scans the project, and prints the next command. Review the selected source files and model route before generation: source excerpts can be sent to your selected model provider, whose usage costs are separate. Generation creates drafts; a person reviews and promotes them to active in the local UI.

For command options, run `doklo --help` or `doklo <command> --help`. Coding agents can connect through `doklo mcp`; configure the project root explicitly. The installed package includes `AGENT_GUIDE.md` and Korean documentation in `README.ko.md`.

## Preview limits

- Static import tracking has a bounded depth. Runtime wiring and dynamic imports may be absent. Unresolved internal imports stop the scan.
- Older tracking is unknown until repaired and reviewed. `doklo scan --repair-tracking` repairs source tracking while preserving existing document content and history; repaired documents still need review.
- Freshness means tracked source hashes match, not that a document is accurate or complete.
- Ordinary sync preserves human-edited documents by skipping them. Automatic merging under forced regeneration has not been validated.
- The credential-free Claude Code route supports generation, not sync. Do not silently switch providers.
- Local Live Review integration discussed for future work is not included in this preview.

## License

Apache-2.0. See the installed `LICENSE` and `NOTICE`. Third-party components retain their own licenses. Separate Doklo Cloud services have their own terms.
