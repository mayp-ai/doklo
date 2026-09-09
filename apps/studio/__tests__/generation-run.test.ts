import { describe, expect, it } from 'vitest';
import {
  GenerationAlreadyRunningError,
  acquireGenerationRun,
  isGenerationActive,
} from '../lib/generation-run';

describe('shared generation run lease', () => {
  it('excludes every endpoint for the same root and service, then permits reacquisition', () => {
    const first = acquireGenerationRun('/workspace', 'web');
    expect(() => acquireGenerationRun('/workspace', 'web')).toThrow(GenerationAlreadyRunningError);
    expect(isGenerationActive('/workspace', 'web')).toBe(true);
    first.release();
    first.release();
    expect(acquireGenerationRun('/workspace', 'web')).toBeTruthy();
  });
});
