// The sync judge's prompt and request contract (judge-gated sync design §4.3,
// §6; benchmark report 2026-10-14 §8–§11).
//
// DECISION FOR THE FOUNDER TO CONFIRM (design §8 item 9, the ring boundary):
// the sync judge's prompt and response contract live here, in the CLI — the
// ring of the code that calls the judge — while golden data and evaluation
// assets (datasets, release-quality runs, the grounded judge) stay in
// packages/evaluator (Ring 3). This module was copied from the benchmark
// harness (benchmarks/judge-sync/src/prompt.ts), not linked to it: the product
// never imports the benchmark.
//
// sync-judge-v2 is the frozen sync-judge-v1 text the 2026-10-14 benchmark
// measured (digest 09f30217c15f75c72ee33149acaba780433a60c2f2703871020c137091cb3180)
// plus two changes:
//  1. Answer language. The request names `answer_language` (the workspace
//     default_locale: "Korean" for ko, "English" otherwise), and every
//     human-read field — summary, every reason, every omission's what — must be
//     written in it. v1 asked for an English summary only; GPT-6 Luna answered
//     in Korean anyway, and the summary becomes a staged proposal (report
//     §11.4, §11.8).
//  2. Exact paths. Evidence must be copied character for character from a path
//     the request gave — a bare file name made one Sonnet verdict `uncertain`
//     under post-rule R2 (report §2.4).
// Sending line-range anchors (design §8 item 4: `source_anchors` ranges when
// present) also required the anchors line to say an anchor may be an excerpt,
// and each anchor to carry `lines`; v1 described anchors as whole files only.
import { createHash } from 'node:crypto';

export const SYNC_JUDGE_PROMPT_VERSION = 'sync-judge-v2';

export const SYNC_JUDGE_SYSTEM = [
  'You are the sync judge for Doklo, a tool that keeps product documents ("Doks") in step with code.',
  'A Dok describes one product feature in business terms: what people and the system do (user_actions), the rules the product enforces (business_rules) and how to verify them (acceptance_criteria). Dok text may be Korean or English.',
  '',
  'A code change touched source files this Dok was generated from, so the Dok may be out of date. Decide whether the Dok must be updated because of THIS change. Do not grade writing quality or style.',
  '',
  'You receive one JSON object:',
  '- "answer_language": the language every human-read field of your answer must be written in.',
  '- "dok": the Dok body (operational metadata removed).',
  '- "diff_base": the commit the Dok was last generated from or confirmed against.',
  '- "changed_files": source files of this Dok whose content changed since diff_base, each with "shown_as": "diff" (in "diff"), "full" (whole current content in "full_files", because a trustworthy diff could not be built) or "withheld" (not sent, may contain secrets).',
  '- "diff": a unified git diff from diff_base to the current code, for the changed files shown as "diff". null when there is none.',
  '- "full_files": whole current content of changed files that could not be diffed.',
  '- "anchors": current content of the Dok\'s main source files, as context: the whole file when "lines" is null, otherwise only the lines "lines" names (1-based, inclusive). They may include changed files.',
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
  'Evidence: copy every "evidence_files" entry character for character from a "path" in changed_files or anchors: the full path exactly as given, never a bare file name or a shortened path, never with the a/ or b/ prefix of a diff header. A path you were not given makes the whole answer unusable. Cite at least one file for every item.',
  'Language: write "summary", every "reason" and every "what" in answer_language, whatever language the Dok or the code uses. "claim" quotes the Dok statement as the Dok words it.',
  '',
  'Return only one JSON object, with no Markdown fences and no text before or after it:',
  '{"verdict":"accurate"|"needs_update"|"uncertain","errors":[{"severity":"critical"|"major"|"minor","claim_path":"<JSON path in the Dok, e.g. business_rules.rules[1].description>","claim":"<the Dok statement>","evidence_files":["<path>"],"reason":"<why it is wrong>","scope":"this_change"|"pre_existing"}],"omissions":[{"what":"<behaviour the Dok should now describe>","evidence_files":["<path>"],"reason":"<why the Dok needs it>"}],"checked":[{"claim_path":"<JSON path in the Dok>","evidence_files":["<path>"],"reason":"<what you verified>"}],"summary":"<one sentence in answer_language a reviewer could approve: what the Dok must now say, or why it still holds>"}',
  'Use [] for an empty list. "checked" may be empty unless the verdict is "accurate".',
].join('\n');

/**
 * The user prompt is exactly `JSON.stringify(payload)` with the keys below, in
 * this order. The template is part of the digest, so a change of shape or
 * order changes the digest.
 */
export const SYNC_JUDGE_USER_TEMPLATE =
  '{"answer_language":"Korean"|"English",' +
  '"dok":<Dok body without _meta, TermRefs resolved>,' +
  '"diff_base":<sha>,' +
  '"changed_files":[{"path":<path>,"shown_as":"diff"|"full"|"withheld"}],' +
  '"diff":<unified diff>|null,' +
  '"full_files":[{"path":<path>,"content":<text>}],' +
  '"anchors":[{"path":<path>,"lines":"<start>-<end>"|null,"content":<text>}],' +
  '"omitted_anchors":[<path>],' +
  '"withheld_files":[<path>]}';

/** Fingerprint of the prompt contract (version, system text, user template). */
export const SYNC_JUDGE_PROMPT_DIGEST = createHash('sha256')
  .update(`${SYNC_JUDGE_PROMPT_VERSION}\n${SYNC_JUDGE_SYSTEM}\n\n${SYNC_JUDGE_USER_TEMPLATE}`)
  .digest('hex');

export type AnswerLanguage = 'Korean' | 'English';

/**
 * The language the judge answers in: the language Doks are written in, which
 * is the workspace `default_locale` (generation writes every Dok in it).
 * Doklo's supported locales are en and ko; any other locale answers in English.
 */
export function answerLanguageFor(locale: string): AnswerLanguage {
  return locale.trim().toLowerCase().split(/[-_]/u)[0] === 'ko' ? 'Korean' : 'English';
}
