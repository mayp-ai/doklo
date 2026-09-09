// Redaction for provider output that is about to be written to an explicitly
// authorized debug file. Both backends (Claude Code CLI, AI SDK) funnel their
// provider detail through here so credentials and local paths are scrubbed in
// exactly one place.

const MAX_DETAIL_LENGTH = 800;

/** Header names whose value is a credential and must never be persisted. */
const CREDENTIAL_HEADERS = new Set([
  'authorization',
  'proxy-authorization',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
  'cookie',
  'set-cookie',
]);

/**
 * Scrub secrets and local filesystem roots out of free-form provider output,
 * then cap it so a runaway body can't bloat the record.
 */
export function sanitizeProviderDetail(detail: string): string {
  let sanitized = detail.slice(0, MAX_DETAIL_LENGTH);
  const knownRoots = [
    { value: process.cwd(), replacement: '[REDACTED_CWD]' },
    { value: process.env['HOME'], replacement: '[REDACTED_HOME]' },
    { value: process.env['USERPROFILE'], replacement: '[REDACTED_HOME]' },
  ]
    .filter((entry): entry is { value: string; replacement: string } =>
      typeof entry.value === 'string' && entry.value.length > 0)
    .sort((a, b) => b.value.length - a.value.length);
  for (const root of knownRoots) {
    sanitized = sanitized.split(root.value).join(root.replacement);
  }
  return sanitized
    .replace(/\bsk-ant-[A-Za-z0-9_-]{8,}\b/giu, '[REDACTED]')
    .replace(/\b(api[_-]?key|token|secret)\s*[:=]\s*[^\s;]+/giu, '$1=[REDACTED]');
}

/**
 * Replace credential header values wholesale and sanitize what remains.
 * Header names are compared lowercased — providers are inconsistent about case.
 */
export function redactHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    out[name] = CREDENTIAL_HEADERS.has(name.toLowerCase())
      ? '[REDACTED]'
      : sanitizeProviderDetail(String(value));
  }
  return out;
}
