const STALE_SERVER_ACTION_RE =
  /Server Action "[^"]+" was not found on the server\./;

export function isStaleServerActionError(message: string): boolean {
  return STALE_SERVER_ACTION_RE.test(message);
}
