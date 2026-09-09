# @doklo-beta/evaluator

Golden-dataset regression scoring for Dok generation quality.

**Status:** stub. To be vendored from `doklo-cli/scripts/evaluate.ts`.

## Categories (5 × 100 points = 500 max)

To be filled when vendoring. Categories were defined in the legacy doklo-cli prompt evaluator.

## Inputs

- Generated Dok set (path to `.doklo/hub/doks/` or in-memory array)
- Golden dataset reference (e.g., a vendored real-world `*.dok.json` golden set)

## Outputs

- Per-category scores
- Per-Dok diff against golden (missing fields, hallucinated content, structural mismatches)
- CSV report for trend tracking
