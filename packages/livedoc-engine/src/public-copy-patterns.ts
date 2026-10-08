const APPLICATION_ROUTE_SEGMENT = String.raw`(?:[a-z][a-z0-9_-]*|\[[A-Za-z_$][A-Za-z0-9_$]*\]|\{[\p{L}_$][\p{L}\p{N}_$-]*\}|:[A-Za-z_$][A-Za-z0-9_$]*)`;
const APPLICATION_ROUTE_START = String.raw`(?<![A-Za-z0-9._:/-])\/(?!(?:Users|home|private|var|tmp|opt|workspace|packages|apps|src)(?:\/|$))`;
const APPLICATION_ROUTE_END = String.raw`(?![A-Za-z0-9_/-]|\.[A-Za-z0-9])`;

export const APPLICATION_ROUTE_PATTERN_SOURCE = `${APPLICATION_ROUTE_START}${APPLICATION_ROUTE_SEGMENT}(?:\\/${APPLICATION_ROUTE_SEGMENT})*${APPLICATION_ROUTE_END}`;

/** Alternatives that end in a greedy run to the next space: linear as regular expressions. */
const SOURCE_PATH_PREFIXED = String.raw`\b(?:packages|apps|src)[\\/][^\s<>"']+|(?:^|[\s(])\/(?:Users|home|private|var|tmp|opt|workspace)\/[^\s<>"']+|\b[A-Za-z]:\\[^\s<>"']+|(?:^|[\s(])\.doklo[\\/][^\s<>"']+`;
const SOURCE_FILE_PATH = String.raw`\b(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|swift|kt|cs))\b`;

/**
 * What the public-copy rules treat as a source path, in priority order:
 * prefixed paths, a relative file path, then an application route. This
 * expression is the definition; {@link findSourcePaths} is how it is run.
 */
export const SOURCE_PATH_PATTERN_SOURCE = `${SOURCE_PATH_PREFIXED}|${SOURCE_FILE_PATH}|${APPLICATION_ROUTE_PATTERN_SOURCE}`;

export type PatternMatch = { index: number; text: string };

/*
 * Why matchers instead of the expressions.
 *
 * The file-path and route alternatives can begin at almost every position of
 * one long run ("a.a.a…", "a/a/a…", "/[a]/[a]…_"), and from each start the
 * engine reads to the end of the run before failing: quadratic, about a second
 * per 30,000 characters of text a workspace writes. Both alternatives are a
 * chain of pieces joined by one separator, and the outcome from a start depends
 * only on the chain after it. So each chain is read once and the outcome of
 * every start in it is derived from that, while the expressions still make
 * every local decision (character classes, word boundaries, case folding, line
 * ends). Differential tests hold the result to `matchAll` of the expression.
 */

const FLAGS = 'imuy';
const FILE_PATH_SEGMENT = /[A-Za-z0-9_.-]+/giu;
const FILE_PATH_FINAL = new RegExp(String.raw`[A-Za-z0-9_.-]+\.(?:ts|tsx|js|jsx|java|py|go|rs|swift|kt|cs)\b`, FLAGS);
const WORD_BOUNDARY = new RegExp(String.raw`\b`, FLAGS);
const ROUTE_UNIT = new RegExp(`\\/${APPLICATION_ROUTE_SEGMENT}`, FLAGS);
const ROUTE_START = new RegExp(APPLICATION_ROUTE_START, FLAGS);
const ROUTE_END = new RegExp(APPLICATION_ROUTE_END, FLAGS);
const PREFIXED = new RegExp(SOURCE_PATH_PREFIXED, 'gimu');

/** End of a sticky match of `pattern` at `index`, or -1. */
function matchesAt(pattern: RegExp, value: string, index: number): number {
  pattern.lastIndex = index;
  return pattern.test(value) ? pattern.lastIndex : -1;
}

/**
 * Start and end of every relative file path. A path is a chain of segments
 * joined by single separators. From a start inside segment k it succeeds iff
 * a later segment of the chain begins a file name, and the greedy match ends
 * at the last such one, so all starts in a chain share one answer.
 */
function filePaths(value: string): Array<[number, number]> {
  const segments: Array<{ start: number; end: number }> = [];
  FILE_PATH_SEGMENT.lastIndex = 0;
  for (let match = FILE_PATH_SEGMENT.exec(value); match; match = FILE_PATH_SEGMENT.exec(value)) {
    segments.push({ start: match.index, end: match.index + match[0].length });
  }
  const found: Array<[number, number]> = [];
  for (let first = 0; first < segments.length;) {
    let last = first;
    while (last + 1 < segments.length
      && segments[last + 1]!.start === segments[last]!.end + 1
      && (value[segments[last]!.end] === '/' || value[segments[last]!.end] === '\\')) {
      last += 1;
    }
    let finalSegment = -1;
    let finalEnd = -1;
    for (let j = last; j > first && finalSegment < 0; j -= 1) {
      finalEnd = matchesAt(FILE_PATH_FINAL, value, segments[j]!.start);
      if (finalEnd >= 0) finalSegment = j;
    }
    for (let k = first; k < finalSegment; k += 1) {
      for (let start = segments[k]!.start; start < segments[k]!.end; start += 1) {
        if (matchesAt(WORD_BOUNDARY, value, start) >= 0) found.push([start, finalEnd]);
      }
    }
    first = last + 1;
  }
  return found;
}

/**
 * Start and end of every application route. A route is a chain of
 * "/segment" units read greedily; every slash inside a chain begins a unit, so
 * a later start reads a suffix of the same chain. When the end condition fails
 * after the whole chain the engine gives characters back from the right.
 * Giving back a whole unit leaves a slash next, which the condition refuses,
 * so the answer is the rightmost shorter segment end it accepts.
 */
function applicationRoutes(value: string): Array<[number, number]> {
  const found: Array<[number, number]> = [];
  for (let slash = value.indexOf('/'); slash >= 0;) {
    const units: Array<{ start: number; end: number }> = [];
    for (let at = slash, end = matchesAt(ROUTE_UNIT, value, at); end >= 0; at = end, end = matchesAt(ROUTE_UNIT, value, at)) {
      units.push({ start: at, end });
    }
    if (units.length === 0) {
      slash = value.indexOf('/', slash + 1);
      continue;
    }
    const chainEnd = units[units.length - 1]!.end;
    const wholeChain = matchesAt(ROUTE_END, value, chainEnd) >= 0;
    // shorterFrom[u]: the rightmost acceptable shorter end in unit u or later.
    const shorterFrom = new Array<number>(units.length).fill(-1);
    let shorter = -1;
    for (let u = units.length - 1; u >= 0; u -= 1) {
      const { start, end } = units[u]!;
      const kind = value[start + 1];
      // Bracketed and braced segments end at a fixed closing character. The
      // shortest letter segment is one character after the slash; the shortest
      // parameter segment is the colon and one more.
      const shortest = kind === '[' || kind === '{' ? end : kind === ':' ? start + 3 : start + 2;
      for (let at = end - 1; shorter < 0 && at >= shortest; at -= 1) {
        if (matchesAt(ROUTE_END, value, at) >= 0) shorter = at;
      }
      shorterFrom[u] = shorter;
    }
    for (let u = 0; u < units.length; u += 1) {
      const start = units[u]!.start;
      if (matchesAt(ROUTE_START, value, start) < 0) continue;
      const end = wholeChain ? chainEnd : shorterFrom[u]!;
      if (end >= 0) found.push([start, end]);
    }
    slash = value.indexOf('/', chainEnd);
  }
  return found;
}

/**
 * The matches `matchAll` reports: the leftmost start that matches, the
 * earlier alternative at a tied start, then on from that match's end.
 */
function leftmost(value: string, alternatives: Array<Array<[number, number]>>, prefixed: boolean): PatternMatch[] {
  const matches: PatternMatch[] = [];
  const cursors = alternatives.map(() => 0);
  let nextPrefixed: { index: number; end: number } | null | undefined;
  let position = 0;
  while (position <= value.length) {
    if (prefixed && (nextPrefixed === undefined || (nextPrefixed !== null && nextPrefixed.index < position))) {
      PREFIXED.lastIndex = position;
      const match = PREFIXED.exec(value);
      nextPrefixed = match ? { index: match.index, end: match.index + match[0].length } : null;
    }
    let chosen = prefixed && nextPrefixed ? nextPrefixed : null;
    for (let which = 0; which < alternatives.length; which += 1) {
      const list = alternatives[which]!;
      while (cursors[which]! < list.length && list[cursors[which]!]![0] < position) cursors[which]! += 1;
      const candidate = list[cursors[which]!];
      if (candidate && (!chosen || candidate[0] < chosen.index)) chosen = { index: candidate[0], end: candidate[1] };
    }
    if (!chosen) break;
    matches.push({ index: chosen.index, text: value.slice(chosen.index, chosen.end) });
    position = chosen.end;
  }
  return matches;
}

/** `matchAll` of {@link SOURCE_PATH_PATTERN_SOURCE} with flags `gimu`, in linear time. */
export function findSourcePaths(value: string): PatternMatch[] {
  return leftmost(value, [filePaths(value), applicationRoutes(value)], true);
}

/** `matchAll` of {@link APPLICATION_ROUTE_PATTERN_SOURCE} with flags `gimu`, in linear time. */
export function findApplicationRoutes(value: string): PatternMatch[] {
  return leftmost(value, [applicationRoutes(value)], false);
}

export function containsSourcePath(value: string): boolean {
  return findSourcePaths(value).length > 0;
}

/** Replaces every application route with `replacement`, taken literally. */
export function replaceApplicationRoutes(value: string, replacement: string): string {
  let result = '';
  let position = 0;
  for (const match of findApplicationRoutes(value)) {
    result += value.slice(position, match.index) + replacement;
    position = match.index + match.text.length;
  }
  return result + value.slice(position);
}
