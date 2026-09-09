// Parser: generic axis-scored JSON verdicts (axis list + max injected; reused by livedocs rubric).

export interface GenericAxisScore {
  axis: string;
  score: number;
  reason: string;
}

export interface ParsedVerdict {
  axes: GenericAxisScore[];
  flags: string[];
}

export function parseJudgeVerdict(
  content: string,
  expectedAxes: readonly string[],
  maxPerAxis: number,
): ParsedVerdict {
  const start = content.indexOf('{');
  const end = content.lastIndexOf('}');
  if (start === -1 || end <= start) throw new Error('no JSON object in judge response');
  const raw = JSON.parse(content.slice(start, end + 1)) as { axes?: unknown; flags?: unknown };
  if (!Array.isArray(raw.axes)) throw new Error('judge response missing axes[]');
  const items = raw.axes as Array<Record<string, unknown>>;
  const axes = expectedAxes.map((axis) => {
    const found = items.find((a) => a.axis === axis);
    if (!found) throw new Error(`judge response missing axis: ${axis}`);
    const score = Number(found.score);
    if (!Number.isFinite(score) || score < 0 || score > maxPerAxis) {
      throw new Error(`axis ${axis} score out of range (0-${maxPerAxis}): ${String(found.score)}`);
    }
    return { axis, score: Math.round(score), reason: String(found.reason ?? '') };
  });
  const flags = Array.isArray(raw.flags) ? (raw.flags as unknown[]).map(String) : [];
  return { axes, flags };
}
