/**
 * Typed engine errors per spec §12.
 * Each error carries a stable `code` for CLI exit-code mapping and
 * machine-readable LivedocManifest.errors[] entries.
 */

export type EngineErrorCode =
  | 'TEMPLATE_NOT_FOUND'
  | 'INVALID_MANIFEST'
  | 'MISSING_HUB_LAYER'
  | 'ENGINE_VERSION_MISMATCH'
  | 'TEMPLATE_COMPILE_ERROR'
  | 'SELECTOR_EMPTY'
  | 'UNREVIEWED_DOK'
  | 'KOREAN_TONE_CONFLICT'
  | 'KOREAN_WRITING_POLICY_CHANGED'
  | 'UNRESOLVED_TRANSLATABLE'
  | 'MISSING_STRINGS_KEY'
  | 'WRITER_FAILURE'
  | 'OUTPUT_EXISTS'
  | 'OUTPUT_FORMAT_REQUIRED'
  | 'OUTPUT_FORMAT_REJECTED'
  | 'INVALID_TEMPLATE_VARIABLE'
  | 'STABLE_COPY_UNSAFE'
  | 'STABLE_LINT_FAILED';

export interface EngineErrorDetail {
  code: EngineErrorCode;
  message: string;
  dokId?: string;
  field?: string;
  path?: string;
}

export class EngineError extends Error {
  public readonly code: EngineErrorCode;
  public readonly dokId?: string;
  public readonly field?: string;
  public readonly path?: string;

  constructor(detail: EngineErrorDetail) {
    super(detail.message);
    this.name = 'EngineError';
    this.code = detail.code;
    this.dokId = detail.dokId;
    this.field = detail.field;
    this.path = detail.path;
  }
}
