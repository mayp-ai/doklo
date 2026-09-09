export interface ResolveHistoryAuthorOptions {
  env: Record<string, string | undefined>;
  /** Injected `git <args>` runner returning stdout. Absent = no git lookup. Errors are swallowed. */
  git?: (args: string[]) => Promise<string | undefined>;
}

/** Best-effort author: DOKLO_AUTHOR → git config user.name → undefined. Never throws. */
export async function resolveHistoryAuthor(
  opts: ResolveHistoryAuthorOptions,
): Promise<string | undefined> {
  const fromEnv = opts.env['DOKLO_AUTHOR']?.trim();
  if (fromEnv) return fromEnv;
  if (!opts.git) return undefined;
  try {
    const name = (await opts.git(['config', 'user.name']))?.trim();
    return name ? name : undefined;
  } catch {
    return undefined;
  }
}
