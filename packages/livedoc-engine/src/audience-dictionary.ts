import { lstat, readFile } from 'node:fs/promises';
import { resolveContainedPath } from '@doklo-beta/core';
import type { AudienceDictionary } from './helpers/audience-text.js';

export interface WorkspaceAudienceDictionaryResult {
  dictionary?: AudienceDictionary;
  /** The dictionary was read but is not parseable as the expected JSON shape. */
  malformed?: boolean;
  /**
   * A dictionary entry exists but was refused before being opened — it escapes
   * the workspace, or it is not a regular file. Distinct from `malformed`,
   * which can only be reached by parsing.
   */
  rejected?: boolean;
}

const DICTIONARY_RELATIVE_PATH = '.doklo/audience-text.json';

/**
 * Load the project's audience dictionary, proving containment before the open.
 *
 * This file is not an ordinary read. Whatever it parses becomes substitution
 * rules applied to generated document text, so following a symlink out of the
 * workspace is both an out-of-root read and a content-injection primitive: the
 * foreign file's replacements land in the rendered output.
 *
 * Refusal is reported rather than swallowed. A missing dictionary is the
 * ordinary case and stays silent, but a dictionary that exists and is refused
 * surfaces as `rejected` so an operator who symlinked the file learns why their
 * terms stopped applying, instead of watching them silently vanish. Renders
 * still complete — the dictionary is optional, and failing the whole command
 * would punish a plausible monorepo layout rather than the attack.
 */
export async function loadWorkspaceAudienceDictionary(
  workspaceRoot: string,
  locale: string,
  primaryLocale?: string,
): Promise<WorkspaceAudienceDictionaryResult> {
  let path: string;
  try {
    path = await resolveContainedPath(workspaceRoot, DICTIONARY_RELATIVE_PATH, {
      rejectSymlinkLeaf: true,
    });
  } catch (error) {
    if (isMissingPathError(error)) return {};
    return { rejected: true };
  }

  // A FIFO leaf would block readFile until a writer appeared, hanging the
  // render instead of failing it; a directory would fail obscurely.
  try {
    if (!(await lstat(path)).isFile()) return { rejected: true };
  } catch (error) {
    if (isMissingPathError(error)) return {};
    return { rejected: true };
  }

  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    if (isMissingPathError(error)) return {};
    return { rejected: true };
  }

  try {
    const parsed = JSON.parse(raw) as Record<string, Record<string, string>>;
    const map = parsed?.[locale] ?? (primaryLocale ? parsed?.[primaryLocale] : undefined);
    if (!map || typeof map !== 'object' || Array.isArray(map)) return {};
    return {
      dictionary: Object.entries(map).map(([pattern, replacement]) =>
        [String(pattern), String(replacement)] as const),
    };
  } catch {
    return { malformed: true };
  }
}

function isMissingPathError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null || !('code' in error)) return false;
  const code = (error as { code?: unknown }).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}
