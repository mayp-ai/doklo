export interface DokBulkReviewCopy {
  entry: string;
  cancelReview: string;
  warning: string;
  selected: (count: number) => string;
  selectedActions: string;
  allDraftActions: string;
  activateSelected: (count: number) => string;
  activateAll: (count: number) => string;
  allLimit: (count: number) => string;
  modalTitle: (count: number) => string;
  modalDescription: (count: number) => string;
  modalWarning: string;
  acknowledgment: string;
  cancel: string;
  confirmAll: (count: number) => string;
  success: (count: number) => string;
  preflightFailure: string;
  partialFailure: (activated: number, failed: number) => string;
  reload: string;
}

export const ENGLISH_DOK_BULK_REVIEW_COPY: DokBulkReviewCopy = {
  entry: 'Review Doks',
  cancelReview: 'Cancel review',
  warning:
    'Active Doks may be treated as reviewed product context by AI agents and stable Live Docs. Check the selected Doks before continuing. Staged change proposals are recorded to history on approval.',
  selected: (count) => `${count} selected`,
  selectedActions: 'Selected Doks',
  allDraftActions: 'All Drafts',
  activateSelected: (count) => `Mark ${count} as active`,
  activateAll: (count) => `Mark all ${count} drafts active`,
  allLimit: (count) =>
    `${count} Drafts exceed the 500-item safety limit. Review them in selected batches.`,
  modalTitle: (count) => `Mark all ${count} Drafts active?`,
  modalDescription: (count) =>
    `This marks ${count} AI-generated Doks as reviewed.`,
  modalWarning:
    'AI agents and stable Live Docs may use every activated Dok as trusted product context, including Doks you did not review individually.',
  acknowledgment: 'I understand the impact',
  cancel: 'Cancel',
  confirmAll: (count) => `Mark all ${count} as active`,
  success: (count) => `${count} ${count === 1 ? 'Dok' : 'Doks'} marked active`,
  preflightFailure: 'The Dok set changed. Reload Doks before retrying.',
  partialFailure: (activated, failed) => `${activated} activated; ${failed} failed`,
  reload: 'Reload Doks',
};

export const KOREAN_DOK_BULK_REVIEW_COPY: DokBulkReviewCopy = {
  entry: 'Dok 검토',
  cancelReview: '검토 취소',
  warning:
    'Active Dok은 AI 에이전트와 Stable Live Docs에서 검토된 제품 정보로 취급될 수 있습니다. 선택한 Dok을 확인한 뒤 계속하세요. 준비된 변경 제안은 승인 시 이력에 기록됩니다.',
  selected: (count) => `${count}개 선택`,
  selectedActions: '선택한 Dok',
  allDraftActions: '전체 Draft',
  activateSelected: (count) => `${count}개 Active 처리`,
  activateAll: (count) => `Draft ${count}개 모두 Active 처리`,
  allLimit: (count) =>
    `Draft ${count}개는 안전 제한 500개를 초과합니다. 직접 선택한 묶음으로 나누어 검토하세요.`,
  modalTitle: (count) => `Draft ${count}개를 모두 Active 처리할까요?`,
  modalDescription: (count) =>
    `AI가 생성한 Dok ${count}개를 검토 완료로 표시합니다.`,
  modalWarning:
    '개별적으로 검토하지 않은 Dok을 포함해, 활성화된 모든 Dok이 AI 에이전트와 Stable Live Docs에서 신뢰된 제품 정보로 사용될 수 있습니다.',
  acknowledgment: '영향을 확인했습니다',
  cancel: '취소',
  confirmAll: (count) => `${count}개 모두 Active 처리`,
  success: (count) => `Dok ${count}개를 Active 처리했습니다`,
  preflightFailure: 'Dok 구성이 변경되었습니다. 다시 시도하기 전에 Dok을 새로고침하세요.',
  partialFailure: (activated, failed) => `${activated}개 성공 · ${failed}개 실패`,
  reload: 'Dok 새로고침',
};

export function dokBulkReviewCopy(locale: string): DokBulkReviewCopy {
  return locale.toLowerCase().startsWith('ko')
    ? KOREAN_DOK_BULK_REVIEW_COPY
    : ENGLISH_DOK_BULK_REVIEW_COPY;
}
