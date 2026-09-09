# @doklo-beta/cost

Cost-control infrastructure: Anthropic prompt caching, incremental generation via `logic_hash`, and cost telemetry rendered as time-saved equivalent.

**Status:** stub.

## Goals

- Reduce per-run cost by ~10× via the 5 techniques in the v5 design doc:
  prompt caching, incremental generation, tier'd model selection (Haiku for L1-L2),
  embedding-based retrieval, prompt compression
- Surface cost as time-saved (e.g., "$4 = ₩620,000 PM-equivalent saved")
- Drive the Cost Dashboard CLI output
