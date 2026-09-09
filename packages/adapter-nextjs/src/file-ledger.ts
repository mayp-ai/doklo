import type {
  ParserDiagnostic,
  ParserFileLedgerEntry,
  ParserStage,
  SourceCandidate,
} from './legacy-types.js';

const PARSER_STAGE_ORDER: ParserStage[] = [
  'discovery',
  'ast',
  'routing',
  'state',
  'import-graph',
];

export function buildFileLedger(
  candidates: readonly SourceCandidate[],
  diagnostics: readonly ParserDiagnostic[],
  executedStagesByFile: ReadonlyMap<string, readonly ParserStage[]> = new Map(),
): ParserFileLedgerEntry[] {
  return candidates.map((candidate) => {
    if (!candidate.included) {
      return {
        file: candidate.file,
        status: 'excluded',
        stages: ['discovery'],
        reason: candidate.exclusionReason ?? 'EXCLUDED',
      };
    }

    const failures = diagnostics.filter(
      (diagnostic) => diagnostic.filePath === candidate.file,
    );
    if (failures.length > 0) {
      return {
        file: candidate.file,
        status: 'failed',
        stages: [...new Set(failures.map((diagnostic) => diagnostic.stage))],
        reason: failures[0]!.message,
        diagnosticCount: failures.length,
      };
    }

    return {
      file: candidate.file,
      status: 'processed',
      stages: PARSER_STAGE_ORDER.filter((stage) =>
        (executedStagesByFile.get(candidate.file) ?? ['discovery']).includes(stage),
      ),
      reason: 'OK',
    };
  });
}
