// The sync judge's prompt contract: v2 is pinned by digest, and it is the
// benchmark's frozen v1 text plus the intended changes only. The v1 text below
// is a copy of benchmarks/judge-sync/src/prompt.ts; its digest proves the copy
// is the prompt the 2026-10-14 benchmark measured.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  SYNC_JUDGE_PROMPT_DIGEST,
  SYNC_JUDGE_PROMPT_VERSION,
  SYNC_JUDGE_SYSTEM,
  SYNC_JUDGE_USER_TEMPLATE,
  answerLanguageFor,
} from '../src/lib/judge/prompt.js';

const V1_DIGEST = '09f30217c15f75c72ee33149acaba780433a60c2f2703871020c137091cb3180';
const V2_DIGEST = '1a050f3e30c1d3b29a8a9db8771efa32e6c325186bde444df641bd77e4279509';

const V1_SYSTEM = [
  'You are the sync judge for Doklo, a tool that keeps product documents ("Doks") in step with code.',
  'A Dok describes one product feature in business terms: what people and the system do (user_actions), the rules the product enforces (business_rules) and how to verify them (acceptance_criteria). Dok text may be Korean or English.',
  '',
  'A code change touched source files this Dok was generated from, so the Dok may be out of date. Decide whether the Dok must be updated because of THIS change. Do not grade writing quality or style.',
  '',
  'You receive one JSON object:',
  '- "dok": the Dok body (operational metadata removed).',
  '- "diff_base": the commit the Dok was last generated from or confirmed against.',
  '- "changed_files": source files of this Dok whose content changed since diff_base, each with "shown_as": "diff" (in "diff"), "full" (whole current content in "full_files", because a trustworthy diff could not be built) or "withheld" (not sent, may contain secrets).',
  '- "diff": a unified git diff from diff_base to the current code, for the changed files shown as "diff". null when there is none.',
  '- "full_files": whole current content of changed files that could not be diffed.',
  '- "anchors": whole current content of the Dok\'s main source files, as context. They may include changed files.',
  '- "omitted_anchors": anchor files that were not sent (size budget, or unreadable). Do not guess their content.',
  '- "withheld_files": files not sent because they may contain secrets.',
  '',
  'Answer two questions, judging only against the code supplied:',
  '1. Wrong claims. Which Dok statements are contradicted by, or no longer supported by, the current code shown (diff, full_files, anchors)? Give each a "scope": "this_change" when the statement became wrong because of the diff, "pre_existing" when it was already wrong before this change (the evidence is in code the change did not touch).',
  '2. Omissions, about the diff only. Does this change add, remove or alter product behaviour that a Dok at this level of detail should describe: user-visible steps or options, limits and thresholds, permissions and roles, validation, data that is saved or sent? Report only behaviour the diff introduces, removes or alters. Never report behaviour the unchanged code already had. Never report pure implementation details (renamed identifiers, refactors, log text, comments, formatting, types) unless they change what a person or the system observably does.',
  '',
  'Verdict:',
  '- "needs_update": at least one wrong claim or omission.',
  '- "accurate": the change affects nothing the Dok says or should say. Then "checked" must name what you verified: the Dok statements closest to the change and the files that show they still hold.',
  '- "uncertain": the material supplied is not enough to decide (for example, the deciding code is in an omitted anchor).',
  '',
  'Severity of a wrong claim: "critical" for security, authorization, persistence, destructive actions, payments or external side effects; "major" for a rule, limit, step or option people rely on; "minor" for a detail.',
  'Evidence: every "evidence_files" entry must be a path exactly as given in changed_files or anchors (never with the a/ or b/ prefix of a diff header). Cite at least one file for every item.',
  '',
  'Return only one JSON object, with no Markdown fences and no text before or after it:',
  '{"verdict":"accurate"|"needs_update"|"uncertain","errors":[{"severity":"critical"|"major"|"minor","claim_path":"<JSON path in the Dok, e.g. business_rules.rules[1].description>","claim":"<the Dok statement>","evidence_files":["<path>"],"reason":"<why it is wrong>","scope":"this_change"|"pre_existing"}],"omissions":[{"what":"<behaviour the Dok should now describe>","evidence_files":["<path>"],"reason":"<why the Dok needs it>"}],"checked":[{"claim_path":"<JSON path in the Dok>","evidence_files":["<path>"],"reason":"<what you verified>"}],"summary":"<one English sentence a reviewer could approve: what the Dok must now say, or why it still holds>"}',
  'Use [] for an empty list. "checked" may be empty unless the verdict is "accurate".',
].join('\n');

const V1_TEMPLATE =
  '{"dok":<Dok body without _meta, TermRefs resolved>,' +
  '"diff_base":<sha>,' +
  '"changed_files":[{"path":<path>,"shown_as":"diff"|"full"|"withheld"}],' +
  '"diff":<unified diff>|null,' +
  '"full_files":[{"path":<path>,"content":<text>}],' +
  '"anchors":[{"path":<path>,"content":<text>}],' +
  '"omitted_anchors":[<path>],' +
  '"withheld_files":[<path>]}';

const sha256 = (text: string): string => createHash('sha256').update(text).digest('hex');

describe('sync-judge prompt v2', () => {
  it('pins the v2 digest (version, system text and user template)', () => {
    expect(SYNC_JUDGE_PROMPT_VERSION).toBe('sync-judge-v2');
    expect(SYNC_JUDGE_PROMPT_DIGEST).toBe(V2_DIGEST);
    expect(sha256(`${SYNC_JUDGE_PROMPT_VERSION}\n${SYNC_JUDGE_SYSTEM}\n\n${SYNC_JUDGE_USER_TEMPLATE}`)).toBe(V2_DIGEST);
  });

  it('the v1 text kept here for traceability is the benchmark’s frozen prompt', () => {
    expect(sha256(`sync-judge-v1\n${V1_SYSTEM}\n\n${V1_TEMPLATE}`)).toBe(V1_DIGEST);
  });

  it('is v1 plus the answer language, exact paths and line-range anchors — nothing else moved', () => {
    const v1 = V1_SYSTEM.split('\n');
    const v2 = SYNC_JUDGE_SYSTEM.split('\n');
    const removed = v1.filter((line) => !v2.includes(line));
    const added = v2.filter((line) => !v1.includes(line));
    expect(removed.map((line) => line.slice(0, 30))).toEqual([
      '- "anchors": whole current con',
      'Evidence: every "evidence_file',
      '{"verdict":"accurate"|"needs_u',
    ]);
    expect(added.map((line) => line.slice(0, 40))).toEqual([
      '- "answer_language": the language every ',
      '- "anchors": current content of the Dok\'',
      'Evidence: copy every "evidence_files" en',
      'Language: write "summary", every "reason',
      '{"verdict":"accurate"|"needs_update"|"un',
    ]);
    // The unchanged lines keep their order.
    expect(v2.filter((line) => v1.includes(line))).toEqual(v1.filter((line) => v2.includes(line)));
  });

  it('asks for every human-read field in the requested language, not English', () => {
    expect(SYNC_JUDGE_SYSTEM).toContain('Language: write "summary", every "reason" and every "what" in answer_language');
    expect(SYNC_JUDGE_SYSTEM).toContain('"summary":"<one sentence in answer_language a reviewer could approve');
    expect(SYNC_JUDGE_SYSTEM).not.toContain('one English sentence');
    expect(SYNC_JUDGE_USER_TEMPLATE.startsWith('{"answer_language":"Korean"|"English",')).toBe(true);
  });

  it('asks for evidence paths copied exactly, never a bare file name', () => {
    expect(SYNC_JUDGE_SYSTEM).toContain('copy every "evidence_files" entry character for character');
    expect(SYNC_JUDGE_SYSTEM).toContain('never a bare file name or a shortened path');
  });

  it('describes anchors that may be line-range excerpts', () => {
    expect(SYNC_JUDGE_SYSTEM).toContain('the whole file when "lines" is null, otherwise only the lines "lines" names');
    expect(SYNC_JUDGE_USER_TEMPLATE).toContain('"anchors":[{"path":<path>,"lines":"<start>-<end>"|null,"content":<text>}]');
  });

  it('names the answer language from the workspace default locale', () => {
    expect(answerLanguageFor('ko')).toBe('Korean');
    expect(answerLanguageFor('ko-KR')).toBe('Korean');
    expect(answerLanguageFor('KO_kr')).toBe('Korean');
    expect(answerLanguageFor('en')).toBe('English');
    expect(answerLanguageFor('ja')).toBe('English');
  });
});
