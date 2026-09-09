# Choosing a model

Doklo's current production generation has a strict runtime trust gate. Its configured model reference must be **`anthropic/claude-sonnet-5`**, through one of two routes:

| Route | Authentication | Runtime constraint |
| --- | --- | --- |
| Direct Anthropic | Anthropic API credential from the keychain or environment | Accepts the configured Doklo reference, removes the `anthropic/` prefix, and sends `claude-sonnet-5` over the default Anthropic transport; no custom base URL or fetch override |
| Local Claude Code | Your locally authenticated Claude Code session | Runs the installed CLI with `--model sonnet`; no Doklo-managed API key. Claude Code controls which concrete model its moving `sonnet` alias resolves to |

An unsupported configured model reference or route fails closed before paid work with `RUNTIME_TRUST_MODEL_REQUIRED` or `RUNTIME_TRUST_ROUTE_REQUIRED`. The direct route is version-gated; the local route is configuration-gated but not an immutable underlying-model pin because it delegates to Claude Code's `sonnet` alias. The picker may show benchmark guidance for other model references, but selecting one does **not** mean the current production `generate` command will accept it.

Interactive `doklo init` records and authenticates a picker choice; it does not filter the catalog to the two executable production routes. To choose the local route explicitly, use:

```bash
doklo generate --llm-backend claude-code --model anthropic/claude-sonnet-5
```

## Picker guidance tiers

In `doklo init` or `doklo model`, benchmark labels describe research evidence, not the current runtime support matrix:

| Tier | Marker | Meaning |
| --- | --- | --- |
| **Recommended** | `★` | Measured well on real projects — a safe default. |
| **Unverified** | — | Not in the benchmark; no quality claim. This does not imply current runtime support. |
| **Warned** | `⚠` | Measured *poorly* on real projects — expect quality problems. |

The tier is shown as a hint in the picker and as a one-line note after you pick. The runtime gate above remains authoritative.

## Benchmark research (not current runtime routes)

| Measured model | Research finding | Current production generation |
| --- | --- | --- |
| `anthropic/claude-sonnet-5` | Best overall quality/cost balance in the recorded benchmark | **Accepted as the configured reference** through either route above; direct Anthropic resolves it to the transport model ID `claude-sonnet-5` |
| `anthropic/claude-opus-4-8` | Strong benchmark quality | Not accepted by the current runtime gate |
| `openai/gpt-5.6-sol` | Strong benchmark quality | Not accepted by the current runtime gate |
| `openai/gpt-5.6-luna` | Strong benchmark value | Not accepted by the current runtime gate |

### Warned

- **`anthropic/claude-haiku-4-5`** — on 300+ file projects it hit a high schema-failure rate and produced confident hallucinations. It is also not accepted by the current runtime gate.

## How the evidence is produced

The recommended/warned lists come from a multi-model × multi-project benchmark measuring completion rate, cost, and judged output quality — not intuition. To reproduce or refresh it:

```bash
pnpm bench:models
```

See [`benchmarks/README.md`](../../benchmarks/README.md) for the suite, and `docs/decisions.md` for the recorded results. The lists live in `apps/cli/src/lib/model-guidance.ts` and should only change when a new benchmark run says so.
