import type { StaleReason } from '@doklo-beta/core';
import type { DokConfirmErrorCode } from './actions';
import type { DokDriftBlock } from './dok-drift';

// Copy for source drift in Studio: the editor's stale panel with the sync
// judge's unconfirmed verdict and the "Still accurate" confirmation, and the
// Doks list's bulk confirmation. English is canonical; Korean follows the
// workspace locale, as the bulk review copy does.

export interface DokDriftCopy {
  /** Accessible name of the editor's drift panel. */
  panelLabel: string;
  staleLabel: string;
  title: string;
  reason: (reason: StaleReason | undefined) => string;
  /** Regeneration stays a CLI step: Studio offers no regenerate button. */
  syncHint: string;
  verdictTitle: string;
  verdictModel: (model: string) => string;
  verdictUnconfirmed: string;
  evidenceTitle: string;
  confirm: string;
  confirming: string;
  confirmHint: string;
  blocked: (block: DokDriftBlock) => string;
  pendingEdits: string;
  confirmed: string;
  failure: (code: DokConfirmErrorCode, error: string) => string;
  reload: string;
  bulkEntry: string;
  bulkChecking: string;
  bulkCancel: string;
  /** The one warning line the bulk confirmation carries. */
  bulkWarning: string;
  bulkSelectedActions: string;
  bulkSelectAll: string;
  bulkSelectAllLabel: string;
  bulkSelected: (count: number) => string;
  bulkConfirm: (count: number) => string;
  bulkLimit: (count: number) => string;
  bulkNone: string;
  bulkSuccess: (count: number) => string;
  bulkPreflightFailure: string;
  bulkPartialFailure: (confirmed: number, failed: number) => string;
  bulkReadFailure: string;
  selectToConfirm: (dokId: string) => string;
  rowStale: (reason: StaleReason | undefined) => string;
  rowJudged: string;
}

export const ENGLISH_DOK_DRIFT_COPY: DokDriftCopy = {
  panelLabel: 'Source drift',
  staleLabel: 'Stale',
  title: 'The code this Dok tracks changed since it was generated or last confirmed.',
  reason: (reason) =>
    reason === 'missing-file'
      ? 'A tracked source file is missing or cannot be read.'
      : reason === 'tracking-expanded'
        ? 'Recovered source tracking needs review.'
        : 'A tracked source file changed.',
  syncHint: 'Regeneration happens with `doklo sync`.',
  verdictTitle: 'Judge check: still accurate',
  verdictModel: (model) => `by ${model}`,
  verdictUnconfirmed:
    'Unconfirmed — the judge’s opinion, not a review. The Dok stays stale until a person confirms it.',
  evidenceTitle: 'What the judge checked',
  confirm: 'Still accurate',
  confirming: 'Confirming…',
  confirmHint:
    'Confirm only after reading the change yourself. It re-stamps the source hashes and the diff base; status, history and version stay as they are.',
  blocked: (block) =>
    block === 'TRACKING_REVIEW_REQUIRED'
      ? 'Recovered source tracking needs review — regenerate this Dok with `doklo sync`. Confirming cannot clear it.'
      : 'A tracked source file cannot be read, so there is nothing to confirm.',
  pendingEdits: 'Save your edits before confirming.',
  confirmed: 'Confirmed. This Dok reads fresh until its tracked sources change again.',
  failure: (code, error) =>
    code === 'CONFLICT'
      ? 'The Dok changed outside this view. Reload before confirming.'
      : code === 'NOT_STALE'
        ? 'This Dok is no longer stale — nothing to confirm.'
        : code === 'TRACKING_REVIEW_REQUIRED' || code === 'NOTHING_TO_CONFIRM'
          ? ENGLISH_DOK_DRIFT_COPY.blocked(code)
          : error,
  reload: 'Reload',
  bulkEntry: 'Confirm stale Doks',
  bulkChecking: 'Checking sources…',
  bulkCancel: 'Cancel',
  bulkWarning:
    'Confirming is a person’s judgement that each Dok still matches its code. Doklo keeps no record of it other than the re-stamped source hashes.',
  bulkSelectedActions: 'Selected stale Doks',
  bulkSelectAll: 'Select all stale Doks',
  bulkSelectAllLabel: 'Select all',
  bulkSelected: (count) => `${count} selected`,
  bulkConfirm: (count) => `Confirm ${count} still accurate`,
  bulkLimit: (count) =>
    `${count} selected exceeds the 500-item safety limit. Confirm them in smaller batches.`,
  bulkNone: 'No stale Doks — every tracked source matches its Dok or changed in form only.',
  bulkSuccess: (count) =>
    `${count} ${count === 1 ? 'Dok' : 'Doks'} confirmed still accurate`,
  bulkPreflightFailure: 'The Doks or their sources changed. Reload Doks before retrying.',
  bulkPartialFailure: (confirmed, failed) => `${confirmed} confirmed; ${failed} failed`,
  bulkReadFailure: 'Could not check the Doks’ sources. Reload Doks and try again.',
  selectToConfirm: (dokId) => `Select ${dokId} to confirm still accurate`,
  rowStale: (reason) =>
    reason === 'missing-file'
      ? 'Stale · file missing'
      : reason === 'tracking-expanded'
        ? 'Stale · tracking review'
        : 'Stale · code changed',
  rowJudged: 'Judge: still accurate',
};

export const KOREAN_DOK_DRIFT_COPY: DokDriftCopy = {
  panelLabel: '소스 드리프트',
  staleLabel: '드리프트됨',
  title: '이 Dok이 추적하는 코드가 생성이나 마지막 확인 뒤로 바뀌었습니다.',
  reason: (reason) =>
    reason === 'missing-file'
      ? '추적하는 소스 파일이 없거나 읽을 수 없습니다.'
      : reason === 'tracking-expanded'
        ? '복구한 소스 추적을 검토해야 합니다.'
        : '추적하는 소스 파일이 바뀌었습니다.',
  syncHint: '재생성은 `doklo sync`로 합니다.',
  verdictTitle: '판사 확인: 그대로 맞음',
  verdictModel: (model) => `${model} 판정`,
  verdictUnconfirmed:
    '사람 확인 전입니다. 판사의 의견일 뿐 검토가 아니며, 사람이 확인할 때까지 Dok은 드리프트된 상태로 남습니다.',
  evidenceTitle: '판사가 확인한 근거',
  confirm: '여전히 맞다',
  confirming: '확인하는 중…',
  confirmHint:
    '바뀐 코드를 직접 읽은 뒤에만 확인하세요. 소스 해시와 diff 기준만 다시 찍고, 상태·이력·버전은 그대로 둡니다.',
  blocked: (block) =>
    block === 'TRACKING_REVIEW_REQUIRED'
      ? '복구한 소스 추적을 검토해야 합니다. `doklo sync`로 이 Dok을 다시 만드세요. 확인으로는 이 표시를 끌 수 없습니다.'
      : '추적하는 소스 파일을 읽을 수 없어 확인할 대상이 없습니다.',
  pendingEdits: '확인하기 전에 편집 내용을 저장하세요.',
  confirmed: '확인했습니다. 추적하는 소스가 다시 바뀔 때까지 이 Dok은 최신으로 읽힙니다.',
  failure: (code, error) =>
    code === 'CONFLICT'
      ? 'Dok이 이 화면 밖에서 바뀌었습니다. 새로고침한 뒤 확인하세요.'
      : code === 'NOT_STALE'
        ? '이 Dok은 더 이상 드리프트된 상태가 아닙니다. 확인할 것이 없습니다.'
        : code === 'TRACKING_REVIEW_REQUIRED' || code === 'NOTHING_TO_CONFIRM'
          ? KOREAN_DOK_DRIFT_COPY.blocked(code)
          : error,
  reload: '새로고침',
  bulkEntry: '드리프트된 Dok 확인',
  bulkChecking: '소스를 확인하는 중…',
  bulkCancel: '취소',
  bulkWarning:
    '확인은 각 Dok이 아직 코드와 맞는다는 사람의 판단입니다. 다시 찍힌 소스 해시 말고는 아무 기록도 남지 않습니다.',
  bulkSelectedActions: '선택한 드리프트 Dok',
  bulkSelectAll: '드리프트된 Dok 모두 선택',
  bulkSelectAllLabel: '모두 선택',
  bulkSelected: (count) => `${count}개 선택`,
  bulkConfirm: (count) => `${count}개 여전히 맞음으로 확인`,
  bulkLimit: (count) =>
    `선택한 ${count}개는 안전 제한 500개를 초과합니다. 더 작은 묶음으로 나누어 확인하세요.`,
  bulkNone: '드리프트된 Dok이 없습니다. 추적하는 소스가 모두 Dok과 같거나 모양만 바뀌었습니다.',
  bulkSuccess: (count) => `Dok ${count}개를 여전히 맞음으로 확인했습니다`,
  bulkPreflightFailure: 'Dok이나 소스가 바뀌었습니다. 다시 시도하기 전에 Dok을 새로고침하세요.',
  bulkPartialFailure: (confirmed, failed) => `${confirmed}개 확인 · ${failed}개 실패`,
  bulkReadFailure: 'Dok의 소스를 확인하지 못했습니다. Dok을 새로고침한 뒤 다시 시도하세요.',
  selectToConfirm: (dokId) => `${dokId}을(를) 여전히 맞음 확인 대상으로 선택`,
  rowStale: (reason) =>
    reason === 'missing-file'
      ? '드리프트됨 · 파일 없음'
      : reason === 'tracking-expanded'
        ? '드리프트됨 · 추적 검토'
        : '드리프트됨 · 코드 바뀜',
  rowJudged: '판사: 그대로 맞음',
};

export function dokDriftCopy(locale: string): DokDriftCopy {
  return locale.toLowerCase().startsWith('ko')
    ? KOREAN_DOK_DRIFT_COPY
    : ENGLISH_DOK_DRIFT_COPY;
}
