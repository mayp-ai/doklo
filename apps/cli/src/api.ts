// Library entry point for embedding the CLI's command runners in other
// apps (e.g. Studio's onboarding wizard) WITHOUT triggering the CLI.
//
// `./index.ts` is the bin entry — importing it runs `main()` and parses
// argv. This module re-exports only the pure `run*` functions and their
// types, which have no top-level side effects, so a host app can call
// them directly from a server action / route handler.
//
// Keep LLM-backed command *values* out of this entry point. `generate` /
// `consolidate` pull credential resolution code, which depends on the native
// @napi-rs/keyring package. If Studio imports this API from a Next server
// action just to call scan/evaluate, exporting those runners here makes webpack
// parse that native `.node` binary. Studio should spawn the CLI for LLM-backed
// flows instead of importing those runners.
//
// Exposed via the `@doklo-beta/cli/api` subpath export (see package.json).

import { join } from 'node:path';

export {
  CommandContractError,
  commandExitCode,
  emitCommandResult,
  requireExplicitApproval,
  toCommandContractError,
} from './lib/command-result.js';
export type {
  CommandDiagnostic,
  CommandResult,
  CommandStatus,
  EmitResultOptions,
} from './lib/command-result.js';

export {
  ParserLedgerIncompleteError,
  runScan,
  scanCachePath,
} from './commands/scan.js';
export type {
  ParserLedgerFailureDetails,
  ParserLedgerIncompleteDetails,
  RunScanOptions,
  RunScanResult,
  ScanWarning,
  ScanServiceResult,
  ScanSkip,
} from './commands/scan.js';

export type {
  RunConsolidateOptions,
  RunConsolidateResult,
  ConsolidateServiceResult,
  ConsolidateSkip,
} from './commands/consolidate.js';

export type {
  RunGenerateOptions,
  RunGenerateResult,
  GenerateProgressEvent,
  GenerateOneResult,
  GenerateOneFailure,
  GeneratePlanItem,
} from './commands/generate.js';

export { runEvaluate, NoDoksFoundError } from './commands/evaluate.js';
export type {
  RunEvaluateOptions,
  RunEvaluateResult,
  DokLoadProblem,
  EvaluateReviewSummary,
} from './commands/evaluate.js';

export function consolidatedCachePath(cacheDir: string, serviceId: string): string {
  return join(cacheDir, `${serviceId}.consolidated.json`);
}
