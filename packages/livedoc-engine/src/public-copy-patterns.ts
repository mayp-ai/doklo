const APPLICATION_ROUTE_SEGMENT = String.raw`(?:[a-z][a-z0-9_-]*|\[[A-Za-z_$][A-Za-z0-9_$]*\]|\{[\p{L}_$][\p{L}\p{N}_$-]*\}|:[A-Za-z_$][A-Za-z0-9_$]*)`;

export const APPLICATION_ROUTE_PATTERN_SOURCE = String.raw`(?<![A-Za-z0-9._:/-])\/(?!(?:Users|home|private|var|tmp|opt|workspace|packages|apps|src)(?:\/|$))${APPLICATION_ROUTE_SEGMENT}(?:\/${APPLICATION_ROUTE_SEGMENT})*(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])`;

export const SOURCE_PATH_PATTERN_SOURCE = String.raw`\b(?:packages|apps|src)[\\/][^\s<>"']+|(?:^|[\s(])\/(?:Users|home|private|var|tmp|opt|workspace)\/[^\s<>"']+|\b[A-Za-z]:\\[^\s<>"']+|(?:^|[\s(])\.doklo[\\/][^\s<>"']+|\b(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|swift|kt|cs))\b|${APPLICATION_ROUTE_PATTERN_SOURCE}`;

export function containsSourcePath(value: string): boolean {
  return new RegExp(SOURCE_PATH_PATTERN_SOURCE, 'imu').test(value);
}

export function replaceApplicationRoutes(value: string, replacement: string): string {
  return value.replace(new RegExp(APPLICATION_ROUTE_PATTERN_SOURCE, 'gimu'), replacement);
}
