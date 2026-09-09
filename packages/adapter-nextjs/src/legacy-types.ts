// Legacy v4 parser types vendored from doklo-cli.
// These describe the *internal* output of scanner / ast / routing / state
// modules. The adapter exposes ProjectIR (from @doklo-beta/core) externally;
// these types are an implementation detail.

import type { RoleSignalIR } from '@doklo-beta/core';

export type ParserStage =
  | 'discovery'
  | 'ast'
  | 'routing'
  | 'state'
  | 'import-graph';

export interface SourceCandidate {
  file: string;
  included: boolean;
  exclusionReason: 'TEST_FILE' | 'GENERATED_DECLARATION' | null;
}

export interface ParserDiagnostic {
  filePath: string;
  stage: ParserStage;
  message: string;
}

export interface ParserFileLedgerEntry {
  file: string;
  status: 'processed' | 'excluded' | 'failed';
  stages: ParserStage[];
  reason: string;
  diagnosticCount?: number;
}

export interface ScanResult {
  rootDir: string;
  files: string[];
  candidates: SourceCandidate[];
  summary: {
    matched: number;
    excluded: number;
    symlinksAudited: number;
  };
}

export interface ParamInfo {
  name: string;
  type: string | null;
  isOptional: boolean;
}

export interface FunctionInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  isAsync: boolean;
  params: ParamInfo[];
  returnType: string | null;
  jsDoc: string | null;
}

export interface RouteInfo {
  filePath: string;
  method: string;
  path: string;
  handlers: string[];
}

export interface PropInfo {
  name: string;
  type: string | null;
  isOptional: boolean;
}

export interface ComponentInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  props: PropInfo[];
  isDefaultExport: boolean;
  hooks: string[];
}

export interface ClassInfo {
  name: string;
  filePath: string;
  startLine: number;
  endLine: number;
  isExported: boolean;
  methods: string[];
  properties: string[];
}

export interface ImportInfo {
  filePath: string;
  imports: {
    moduleSpecifier: string;
    namedImports: string[];
    defaultImport: string | null;
  }[];
}

export interface ParseError {
  filePath: string;
  message: string;
}

export interface ParseResult {
  scanResult: ScanResult;
  functions: FunctionInfo[];
  routes: RouteInfo[];
  components: ComponentInfo[];
  classes: ClassInfo[];
  imports: ImportInfo[];
  roleSignals: RoleSignalIR[];
  errors: ParseError[];
  diagnostics: ParserDiagnostic[];
}
