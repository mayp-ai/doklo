export type PublicationUiLocale = 'en' | 'ko';

export const ENGLISH_PUBLICATION_COPY = {
  common: {
    back: 'Back',
    cancel: 'Cancel',
    continue: 'Continue',
    create: 'Create publication',
    loading: 'Loading publications',
    retry: 'Retry',
    unknown: 'Unknown',
    doks: 'Doks',
  },
  workbench: {
    title: 'Live Docs',
    lead: 'Saved deliverables that stay connected to your Dok Hub.',
    newPublication: 'New publication',
    emptyTitle: 'Create your first publication',
    emptyBody: 'Choose a document recipe, select its Doks, and keep the result ready to regenerate.',
    publications: 'Publications',
    officialOutput: 'Official output',
    officialPreview: 'Official preview',
    candidatePreview: 'Candidate preview',
    lastRendered: 'Last rendered',
    destination: 'Destination',
    noDestination: 'No publishing destination',
  },
  create: {
    title: 'New publication',
    lead: 'Define a reusable deliverable from a Template and your current Doks.',
    summary: 'Publication summary',
    name: 'Publication name',
    nameHint: 'Lowercase letters, numbers, and hyphens.',
    displayName: 'Display name',
    template: 'Document Template',
    outputLocale: 'Document language',
    format: 'Output format',
    destination: 'Publish destination',
    destinationHint: 'Optional workspace-relative folder, such as docs/help.',
    createFailed: 'The publication could not be created.',
    created: 'Publication created',
    initialRenderFailed: 'Publication created, but the initial document build failed. Open it in Live Docs to retry.',
    openCreated: 'Open publication',
  },
  steps: {
    document: 'Choose document',
    content: 'Choose content',
    update: 'Choose update behavior',
    output: 'Choose output and delivery',
    review: 'Review',
  },
  template: {
    all: 'All',
    audience: 'Audience',
    purpose: 'Purpose',
    job: 'Reader job',
    requiredInput: 'Required input',
    scope: 'Output shape',
    version: 'Template version',
    stable: 'Stable',
    stableHelp: 'Validated for regular use. Output and compatibility changes follow the stable contract.',
    experimental: 'Experimental',
    experimentalHelp: 'Available to try, but output or compatibility may change. Review before sharing.',
    workspacePreview: 'Workspace preview',
    examplePreview: 'Example preview',
    searchPlaceholder: 'Search templates',
    previewUnavailable: 'Preview unavailable',
    perDok: 'One document per Dok',
    workspace: 'One workspace document',
    selectedDoks: 'One document per eligible Dok',
  },
  selection: {
    title: 'Dok scope',
    allEligible: 'All eligible',
    allEligibleBody: 'Use every Dok that is eligible for this Template.',
    filter: 'Filter',
    explicit: 'Choose Doks',
    explicitBody: 'Choose the Doks to include in this document.',
    template: 'Template selection',
    resolved: 'Resolved Doks',
    excluded: 'Excluded',
    unreviewed: 'Not active yet',
    templateSelector: 'Outside the Template selector',
    includeTags: 'Required tags',
    excludeTags: 'Excluded tags',
    statuses: 'Statuses',
    noEligible: 'No Doks are eligible for this Template.',
  },
  update: {
    title: 'Update behavior',
    manual: 'Manual',
    manualBody: 'Review changes, then build the latest document and publish when ready.',
    review: 'Review before publishing',
    reviewBody: 'Prepare a temporary candidate while this workbench is open. Nothing official changes until you approve.',
    localNote: 'This local Studio works only while it is open.',
  },
  actions: {
    resnapshot: 'Resnapshot',
    render: 'Build latest document',
    approveRender: 'Approve render',
    approvePublish: 'Approve and publish',
    publish: 'Publish',
    export: 'Download ZIP',
    download: 'Download',
    openFull: 'Open full document',
  },
  status: {
    render: 'Render status',
    publish: 'Publish status',
    notRendered: 'Not rendered',
    current: 'Current',
    updateAvailable: 'Update available',
    definitionChanged: 'Definition changed',
    blocked: 'Blocked',
    noDestination: 'No destination',
    notPublished: 'Not published',
    published: 'Published',
    publishNeeded: 'Publish needed',
    publishBlocked: 'Publish blocked',
    freshnessUnknown: 'Cannot prove freshness',
    templateChanged: 'Template update available',
    renderedPublishBlocked: 'Rendered; publish blocked',
    selectionUpdatedRenderFailed: 'Selection updated; document build failed. Review the error, then retry.',
    publishFailed: 'Publishing failed; the official output is unchanged.',
  },
  preview: {
    preview: 'Preview',
    documents: 'Documents',
    changes: 'Changes',
    settings: 'Settings',
    preparing: 'Preparing candidate preview',
    official: 'Official',
    candidate: 'Candidate',
    binaryTitle: 'Binary deliverable',
    binaryBody: 'Download the candidate to inspect it in its native application.',
    unavailable: 'No preview is available yet.',
  },
  changes: {
    added: 'Added',
    changed: 'Changed',
    removed: 'Removed',
    excluded: 'Excluded',
    none: 'No Dok changes are proven against the last official render.',
    more: 'more',
  },
  errors: {
    title: 'Publication needs attention',
    invalidDefinition: 'This Publication definition is invalid.',
    invalidEvidence: 'The last render evidence is invalid.',
    missingDok: 'A snapshotted Dok no longer exists.',
    staleFingerprint: 'The Dok Hub changed. Review the refreshed candidate before approving.',
    alreadyRunning: 'Another official action is already running for this Publication.',
    cliMissing: 'Doklo CLI is not available to Studio.',
    generic: 'The action could not be completed.',
  },
} as const;

type WidenCopy<T> = {
  [Key in keyof T]: T[Key] extends string
    ? string
    : T[Key] extends Record<string, unknown>
      ? WidenCopy<T[Key]>
      : T[Key];
};

export const KOREAN_PUBLICATION_COPY = {
  common: {
    back: '뒤로',
    cancel: '취소',
    continue: '계속',
    create: '발행물 만들기',
    loading: '발행물 불러오는 중',
    retry: '다시 시도',
    unknown: '알 수 없음',
    doks: 'Dok',
  },
  workbench: {
    title: 'Live Docs',
    lead: 'Dok Hub와 연결된 상태로 다시 만들 수 있는 발행물입니다.',
    newPublication: '새 발행물',
    emptyTitle: '첫 발행물을 만들어보세요',
    emptyBody: '문서 레시피와 Dok 범위를 고르면 언제든 다시 만들 수 있습니다.',
    publications: '발행물',
    officialOutput: '공식 산출물',
    officialPreview: '공식본 미리보기',
    candidatePreview: '변경 후보 미리보기',
    lastRendered: '마지막 생성',
    destination: '발행 위치',
    noDestination: '발행 위치 없음',
  },
  create: {
    title: '새 발행물',
    lead: 'Template과 현재 Dok으로 반복 생성 가능한 산출물을 정의합니다.',
    summary: '발행물 요약',
    name: '발행물 이름',
    nameHint: '영문 소문자, 숫자, 하이픈만 사용할 수 있습니다.',
    displayName: '표시 이름',
    template: '문서 Template',
    outputLocale: '문서 언어',
    format: '출력 형식',
    destination: '발행 위치',
    destinationHint: '선택 사항입니다. docs/help 같은 workspace 상대 경로를 입력하세요.',
    createFailed: '발행물을 만들지 못했습니다.',
    created: '발행물을 만들었습니다',
    initialRenderFailed: '발행물은 만들었지만 첫 문서 생성에 실패했습니다. Live Docs에서 열어 다시 시도하세요.',
    openCreated: '발행물 열기',
  },
  steps: {
    document: '문서 선택',
    content: '내용 범위 선택',
    update: '갱신 방식 선택',
    output: '출력과 발행 설정',
    review: '최종 확인',
  },
  template: {
    all: '전체',
    audience: '대상 독자',
    purpose: '문서 목적',
    job: '독자가 할 일',
    requiredInput: '필요한 입력',
    scope: '출력 구조',
    version: 'Template 버전',
    stable: '안정',
    stableHelp: '일상적인 사용을 위해 검증되었습니다. 출력과 호환성 변경은 안정 계약을 따릅니다.',
    experimental: '실험적',
    experimentalHelp: '사용해 볼 수 있지만 출력이나 호환성이 바뀔 수 있습니다. 공유 전에 검토하세요.',
    workspacePreview: '워크스페이스 미리보기',
    examplePreview: '예시 미리보기',
    searchPlaceholder: 'Template 검색',
    previewUnavailable: '미리보기를 사용할 수 없습니다.',
    perDok: 'Dok마다 문서 하나',
    workspace: 'workspace 문서 하나',
    selectedDoks: '조건에 맞는 Dok마다 문서 하나',
  },
  selection: {
    title: 'Dok 범위',
    allEligible: '사용 가능한 전체',
    allEligibleBody: '이 Template에 사용할 수 있는 모든 Dok를 사용합니다.',
    filter: '조건으로 선택',
    explicit: 'Dok 직접 선택',
    explicitBody: '이 문서에 포함할 Dok를 선택합니다.',
    template: 'Template 기준 선택',
    resolved: '선택된 Dok',
    excluded: '제외된 Dok',
    unreviewed: '아직 active가 아님',
    templateSelector: 'Template 조건 밖',
    includeTags: '포함 태그',
    excludeTags: '제외 태그',
    statuses: '상태',
    noEligible: '이 Template에 사용할 수 있는 Dok이 없습니다.',
  },
  update: {
    title: '갱신 방식',
    manual: '수동 갱신',
    manualBody: '변경을 검토한 뒤 최신 문서를 만들고 준비되면 발행하세요.',
    review: '검토 후 발행',
    reviewBody: '작업대가 열려 있을 때 임시 후보를 준비합니다. 승인하기 전에는 공식 산출물이 바뀌지 않습니다.',
    localNote: '로컬 Studio가 열려 있을 때만 동작합니다.',
  },
  actions: {
    resnapshot: '스냅샷 갱신',
    render: '최신 문서 만들기',
    approveRender: '승인하고 생성',
    approvePublish: '승인하고 발행',
    publish: '발행',
    export: 'ZIP 내려받기',
    download: '다운로드',
    openFull: '전체 문서 열기',
  },
  status: {
    render: '생성 상태',
    publish: '발행 상태',
    notRendered: '아직 생성 안 됨',
    current: '최신 상태',
    updateAvailable: '변경 있음',
    definitionChanged: '설정 변경됨',
    blocked: '진행할 수 없음',
    noDestination: '발행 위치 없음',
    notPublished: '아직 발행 안 됨',
    published: '발행됨',
    publishNeeded: '발행 필요',
    publishBlocked: '발행 차단됨',
    freshnessUnknown: '최신 여부를 확인할 수 없음',
    templateChanged: 'Template 업데이트 있음',
    renderedPublishBlocked: '생성 완료, 발행 차단됨',
    selectionUpdatedRenderFailed: 'Dok 선택은 갱신됐지만 문서 생성에 실패했습니다. 오류를 확인한 뒤 다시 시도하세요.',
    publishFailed: '발행에 실패했습니다. 공식 산출물은 변경되지 않았습니다.',
  },
  preview: {
    preview: '미리보기',
    documents: '문서',
    changes: '변경 사항',
    settings: '설정',
    preparing: '변경 후보 준비 중',
    official: '공식본',
    candidate: '변경 후보',
    binaryTitle: '바이너리 산출물',
    binaryBody: '원래 프로그램에서 확인하려면 변경 후보를 다운로드하세요.',
    unavailable: '아직 미리볼 문서가 없습니다.',
  },
  changes: {
    added: '추가됨',
    changed: '변경됨',
    removed: '제외됨',
    excluded: 'Template에서 제외',
    none: '마지막 공식 생성 이후 확인된 Dok 변경이 없습니다.',
    more: '개 더 있음',
  },
  errors: {
    title: '발행물에 확인이 필요합니다',
    invalidDefinition: '발행물 정의가 올바르지 않습니다.',
    invalidEvidence: '마지막 생성 근거가 올바르지 않습니다.',
    missingDok: '스냅샷에 있던 Dok이 더 이상 존재하지 않습니다.',
    staleFingerprint: 'Dok Hub가 변경됐습니다. 새 후보를 확인한 뒤 승인하세요.',
    alreadyRunning: '이 발행물에서 다른 공식 작업을 실행 중입니다.',
    cliMissing: 'Studio에서 Doklo CLI를 사용할 수 없습니다.',
    generic: '작업을 완료하지 못했습니다.',
  },
} as const satisfies WidenCopy<typeof ENGLISH_PUBLICATION_COPY>;

export type PublicationCopy = WidenCopy<
  typeof ENGLISH_PUBLICATION_COPY
>;

export function publicationUiLocale(
  workspaceDefault: string | undefined,
): PublicationUiLocale {
  return workspaceDefault === 'ko' ? 'ko' : 'en';
}

export function publicationCopy(
  locale: PublicationUiLocale,
): PublicationCopy {
  return locale === 'ko'
    ? KOREAN_PUBLICATION_COPY
    : ENGLISH_PUBLICATION_COPY;
}

export function publicationErrorMessage(
  locale: PublicationUiLocale,
  code: string | undefined,
): string {
  const copy = publicationCopy(locale);
  switch (code) {
    case 'PUBLICATION_FINGERPRINT_STALE':
      return copy.errors.staleFingerprint;
    case 'PUBLICATION_ALREADY_RUNNING':
      return copy.errors.alreadyRunning;
    case 'PUBLICATION_CLI_MISSING':
      return copy.errors.cliMissing;
    case 'PUBLICATION_INVALID':
    case 'PUBLICATION_INPUT_INVALID':
      return copy.errors.invalidDefinition;
    case 'PUBLICATION_EVIDENCE_INVALID':
      return copy.errors.invalidEvidence;
    default:
      return copy.errors.generic;
  }
}
