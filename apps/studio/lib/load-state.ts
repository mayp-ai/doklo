import { createHash } from 'node:crypto';
import type { Dok } from '@doklo-beta/core';

export type LoadState<T> =
  | { kind: 'missing'; path: string }
  | { kind: 'empty'; path: string; data: T; revision: string }
  | { kind: 'invalid'; path: string; message: string }
  | { kind: 'unreadable'; path: string; message: string }
  | { kind: 'ready'; path: string; data: T; revision: string };

export interface DokCatalogData {
  doks: Dok[];
  revisions: Record<string, string>;
  paths: Record<string, string>;
}

export function revisionOf(contents: string): string {
  return createHash('sha256').update(contents, 'utf-8').digest('hex');
}

export function isMissingError(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
