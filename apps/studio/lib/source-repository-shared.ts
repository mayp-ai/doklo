export interface SourceRepository {
  repository: string;
  commit: string;
  workspacePrefix: string;
}

function safePath(file: string): string | null {
  const normalized = file.replace(/\\/g, '/').replace(/^\.\//, '');
  if (!normalized || normalized.startsWith('/') || normalized.includes('://') || normalized.split('/').includes('..')) return null;
  return normalized.split('/').filter((segment) => segment && segment !== '.').join('/');
}

export function githubSourceUrl(metadata: SourceRepository, file: string, startLine?: number | null, endLine?: number | null): string | null {
  const safeFile = safePath(file);
  if (safeFile === null) return null;
  const joined = [metadata.workspacePrefix, safeFile].filter(Boolean).join('/');
  const path = joined.split('/').map(encodeURIComponent).join('/');
  const lines = startLine == null ? '' : endLine != null && endLine !== startLine ? `#L${startLine}-L${endLine}` : `#L${startLine}`;
  return `https://github.com/${metadata.repository}/blob/${metadata.commit}/${path}${lines}`;
}
