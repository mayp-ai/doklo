import type { DocLocale } from './livedoc-templates';

type PipelineStage = 'scan' | 'consolidate' | 'roles' | 'lexicon' | 'doks' | 'ia' | 'code-mapping';

export const WIZARD_COPY: Record<
  DocLocale,
  {
    welcome: {
      eyebrow: string;
      hi: string;
      resume: string;
      generateRemaining: string;
      reviewScan: string;
      start: string;
      flow: string[];
      existingHub: string;
      doksHeld: (n: number) => string;
      noCandidates: string;
      scanAutomatic: (status: 'missing' | 'invalid' | 'unreadable') => string;
    };
    extract: {
      eyebrow: string;
      heading: string;
      headingDone: string;
      lead: string;
      service: string;
      noService: string;
      notConfigured: string;
      providerFallback: string;
      model: (model: string) => string;
      provider: (provider: string) => string;
      disclosure: (provider: string) => string;
      requestRejected: string;
      alreadyRunning: string;
      reloadStatus: string;
      requestFailed: (status: number) => string;
      noStream: string;
      unreadableProgress: string;
      partialStream: string;
      streamIncomplete: string;
      connectionLost: (detail: string) => string;
      invalidCompletion: string;
      protocolError: (detail: string) => string;
      noCandidates: string;
      generate: string;
      retry: string;
      recommend: string;
      receipt: string;
      waiting: string;
      scanPreparing: string;
      scanReady: (routes: number, components: number) => string;
      scanFailureSummary: (files: number) => string;
      scanFailureStatus: (files: number) => string;
      scanFailureDetails: string;
      scanFailureStage: (stage: string) => string;
      scanFailureAdditional: (diagnostics: number) => string;
      scanFailureNext: string;
      consolidated: (groups: number) => string;
      roles: (added: number, kept: number) => string;
      lexicon: (terms: number) => string;
      noRemaining: string;
      doksPlanned: (total: number) => string;
      doksGenerated: (total: number) => string;
      dok: string;
      dokGenerating: (dokId: string) => string;
      dokGenerated: (dokId: string) => string;
      dokFailed: (dokId: string) => string;
      ia: (count: number) => string;
      codeMapping: (count: number) => string;
      failureSummary: (failed: number, layerFailed: number) => string;
      unknownError: string;
      emptyHub: string;
      upToDate: string;
      stage: Record<PipelineStage, string>;
      status: { waiting: string; running: string; complete: string; skipped: string; failed: string };
    };
    hub: {
      eyebrow: string;
      title: string;
      hubLabel: string;
      moreDoks: (n: number) => string;
      mcpTitle: string;
      mcpDesc: string;
      /** Shown instead of a Dok query when the Hub holds no Dok to query. */
      mcpExampleLabel: string;
      mcpExampleReturn: string;
      next: string;
      editStudio: string;
    };
  }
> = {
  ko: {
    welcome: {
      eyebrow: 'DOKLO 온보딩',
      hi: '안녕하세요 👋',
      resume: 'Studio에서 계속하기',
      generateRemaining: '남은 작업 생성',
      reviewScan: '스캔 범위 확인',
      start: '시작하기',
      flow: ['코드에서 기능 추출', 'Dok 문서로 생성', '라이브독스로 발행'],
      existingHub: '기존 Hub',
      doksHeld: (n) => `${n}개 Dok 보유`,
      noCandidates: '마지막 스캔에서 Dok 후보를 찾지 못했어요. 서비스와 스캔 범위를 확인한 뒤 다시 생성해 주세요.',
      scanAutomatic: (status) => ({
        missing: '저장된 스캔이 없어요. 생성 전에 Doklo가 자동으로 스캔합니다.',
        invalid: '저장된 스캔이 유효하지 않아요. 생성 전에 Doklo가 자동으로 다시 스캔합니다.',
        unreadable: '저장된 스캔을 읽을 수 없어요. 생성 전에 Doklo가 자동으로 다시 스캔합니다.',
      })[status],
    },
    extract: {
      eyebrow: 'STEP · EXTRACT',
      heading: '생성 전에 확인하세요',
      headingDone: 'Hub가 준비됐어요',
      lead: '선택한 서비스의 실제 진행 상황을 확인하며 Dok Hub를 생성합니다.',
      service: '서비스',
      noService: '생성할 서비스를 찾지 못했어요. workspace 설정에 서비스를 추가한 뒤 다시 열어 주세요.',
      notConfigured: '설정되지 않음',
      providerFallback: 'AI 제공자',
      model: (model) => `모델: ${model}`,
      provider: (provider) => `제공자: ${provider}`,
      disclosure: (provider) => `Doklo는 선택한 소스 발췌를 구성된 자격 증명으로 ${provider}에 전송합니다. 생성된 파일은 로컬 Hub에 유지됩니다.`,
      requestRejected: '생성 요청이 거부됐어요. 선택한 서비스와 설정을 확인해 주세요.',
      alreadyRunning: '이 서비스에서는 다른 생성 작업이 이미 실행 중이에요. 작업이 끝날 때까지 기다린 뒤 상태를 새로고침하고 다시 시도해 주세요.',
      reloadStatus: '상태 새로고침',
      requestFailed: (status) => `생성 요청이 상태 ${status}로 실패했어요.`,
      noStream: '생성 진행 스트림을 받지 못했어요.',
      unreadableProgress: '생성 진행 이벤트를 읽을 수 없어요.',
      partialStream: '생성 스트림이 불완전한 이벤트로 끝났어요.',
      streamIncomplete: '정상 종료를 확인하기 전에 생성 스트림이 닫혔어요.',
      connectionLost: (detail) => `${detail} 브라우저의 진행 연결이 끊겨도 생성 작업은 계속 실행 중일 수 있어요. 다시 시도하기 전에 Hub를 확인해 주세요.`,
      invalidCompletion: '생성 완료 요약을 읽을 수 없어요.',
      protocolError: (detail) => `생성 진행 정보가 일치하지 않아요: ${detail}`,
      noCandidates: '새 Dok 후보를 찾지 못했어요. 스캔 범위와 서비스를 확인한 뒤 다시 시도해 주세요.',
      generate: 'Dok 생성',
      retry: '남은 작업 다시 시도',
      recommend: 'Hub 보기',
      receipt: '생성 영수증',
      waiting: '대기 중',
      scanPreparing: '스캔 준비 중',
      scanReady: (routes, components) => `라우트 ${routes}개 · 컴포넌트 ${components}개`,
      scanFailureSummary: (files) => `코드 파일 ${files}개를 읽지 못해 스캔을 중단했어요. 아래 파일을 확인한 뒤 다시 실행하세요.`,
      scanFailureStatus: (files) => `코드 파일 ${files}개를 읽지 못했어요.`,
      scanFailureDetails: '오류 내용 보기',
      scanFailureStage: (stage) => ({
        discovery: '파일 찾기',
        ast: 'AST 구문 분석',
        routing: '라울트 분석',
        state: '상태 분석',
        'import-graph': 'import 관계 분석',
      } as Record<string, string>)[stage] ?? stage,
      scanFailureAdditional: (diagnostics) => `추가 진단 ${diagnostics}건`,
      scanFailureNext: '파일 문법을 수정한 뒤 스캔을 다시 실행하세요. 기존 스캔 결과는 그대로 보존됐어요.',
      consolidated: (groups) => `기능 그룹 ${groups}개`,
      roles: (added, kept) => `${added}개 추가 · ${kept}개 유지`,
      lexicon: (terms) => `용어 ${terms}개`,
      noRemaining: '새로 생성할 Dok 없음',
      doksPlanned: (total) => `Dok ${total}개 생성 예정`,
      doksGenerated: (total) => `Dok ${total}개 생성됨`,
      dok: 'Dok',
      dokGenerating: (dokId) => `${dokId} 생성 중`,
      dokGenerated: (dokId) => `${dokId} 생성됨`,
      dokFailed: (dokId) => `${dokId} 생성 실패`,
      ia: (count) => `경로 ${count}개`,
      codeMapping: (count) => `항목 ${count}개`,
      failureSummary: (failed, layerFailed) => `Dok 실패 ${failed}개, 레이어 실패 ${layerFailed}개가 있습니다.`,
      unknownError: '알 수 없는 생성 오류',
      emptyHub: '생성이 끝났지만 Hub에서 Dok를 찾지 못했어요. 스캔 설정을 확인한 뒤 다시 시도해 주세요.',
      upToDate: '생성할 새 Dok가 없습니다. 현재 Hub는 최신 상태입니다.',
      stage: {
        scan: '스캔', consolidate: '통합', roles: '역할', lexicon: '용어집',
        doks: 'Dok 생성', ia: 'IA', 'code-mapping': '코드 매핑',
      },
      status: { waiting: '대기 중', running: '진행 중', complete: '완료', skipped: '건너뜀', failed: '실패' },
    },
    hub: {
      eyebrow: 'STEP · HUB',
      title: 'Hub가 준비됐어요',
      hubLabel: '생성된 Hub',
      moreDoks: (n) => `… 외 ${n}개`,
      mcpTitle: 'AI 에이전트는 MCP로 읽습니다',
      mcpDesc: '이 Hub는 이제 에이전트의 컨텍스트입니다. 코드를 다시 뒤지지 않고 Dok을 query해 비즈니스 맥락을 얻습니다.',
      mcpExampleLabel: '형식 예시 — 아직 query할 Dok이 없습니다',
      mcpExampleReturn: 'Dok의 시나리오 · 규칙 · 수용 기준',
      next: '라이브독스 보기',
      editStudio: 'Studio에서 편집하기',
    },
  },
  en: {
    welcome: {
      eyebrow: 'DOKLO ONBOARDING',
      hi: 'Hello 👋',
      resume: 'Resume in Dok Studio',
      generateRemaining: 'Generate remaining work',
      reviewScan: 'Review scan scope',
      start: 'Get started',
      flow: ['Extract features from code', 'Generate Dok docs', 'Publish Live Docs'],
      existingHub: 'Existing Hub',
      doksHeld: (n) => `${n} Doks`,
      noCandidates: 'The last scan found no Dok candidates. Review the service and scan scope, then run generation again.',
      scanAutomatic: (status) => ({
        missing: 'No cached scan is available. Doklo will scan automatically before generation.',
        invalid: 'The cached scan is invalid. Doklo will scan automatically before generation.',
        unreadable: 'The cached scan cannot be read. Doklo will scan automatically before generation.',
      })[status],
    },
    extract: {
      eyebrow: 'STEP · EXTRACT',
      heading: 'Review before generation',
      headingDone: 'Your Hub is ready',
      lead: 'Generate a Dok Hub with a truthful receipt of work for the selected service.',
      service: 'Service',
      noService: 'No service is configured. Add one to the workspace, then reopen Studio.',
      notConfigured: 'Not configured',
      providerFallback: 'your AI provider',
      model: (model) => `Model: ${model}`,
      provider: (provider) => `Provider: ${provider}`,
      disclosure: (provider) => `Doklo sends selected source excerpts to ${provider} using your configured credentials. Generated files stay in your local Hub.`,
      requestRejected: 'Generation request was rejected. Check the selected service and configuration.',
      alreadyRunning: 'Another generation run is already active for this service. Wait for it to finish, then reload status before retrying.',
      reloadStatus: 'Reload status',
      requestFailed: (status) => `Generation request failed with status ${status}.`,
      noStream: 'Generation returned no progress stream.',
      unreadableProgress: 'Generation returned an unreadable progress event.',
      partialStream: 'Generation stream ended with a partial event.',
      streamIncomplete: 'Generation stream closed before clean completion.',
      connectionLost: (detail) => `${detail} The browser lost the progress connection, so generation may still be active. Check the Hub before retrying.`,
      invalidCompletion: 'Generation returned an invalid completion summary.',
      protocolError: (detail) => `Generation progress is inconsistent: ${detail}`,
      noCandidates: 'No Dok candidates were found. Check the scan scope and service, then retry.',
      generate: 'Generate Doks',
      retry: 'Retry remaining',
      recommend: 'View your Hub',
      receipt: 'Pipeline receipt',
      waiting: 'Waiting for a real event',
      scanPreparing: 'Preparing the scan',
      scanReady: (routes, components) => `${routes} routes · ${components} components`,
      scanFailureSummary: (files) => `The scan stopped because ${files} code ${files === 1 ? 'file could' : 'files could'} not be read. Review the file${files === 1 ? '' : 's'} below, then run the scan again.`,
      scanFailureStatus: (files) => `${files} code ${files === 1 ? 'file could' : 'files could'} not be read.`,
      scanFailureDetails: 'View error details',
      scanFailureStage: (stage) => ({
        discovery: 'File discovery',
        ast: 'AST syntax parsing',
        routing: 'Route parsing',
        state: 'State parsing',
        'import-graph': 'Import graph parsing',
      } as Record<string, string>)[stage] ?? stage,
      scanFailureAdditional: (diagnostics) => `${diagnostics} additional ${diagnostics === 1 ? 'diagnostic' : 'diagnostics'}`,
      scanFailureNext: 'Fix the file syntax, then run the scan again. The previous scan result was preserved.',
      consolidated: (groups) => `${groups} feature groups`,
      roles: (added, kept) => `${added} added · ${kept} kept`,
      lexicon: (terms) => `${terms} terms`,
      noRemaining: 'No new Doks to generate',
      doksPlanned: (total) => `${total} Doks planned`,
      doksGenerated: (total) => `${total} Doks generated`,
      dok: 'Dok',
      dokGenerating: (dokId) => `Generating ${dokId}`,
      dokGenerated: (dokId) => `Generated ${dokId}`,
      dokFailed: (dokId) => `Failed ${dokId}`,
      ia: (count) => `${count} routes`,
      codeMapping: (count) => `${count} entries`,
      failureSummary: (failed, layerFailed) => `${failed} Dok failures and ${layerFailed} layer failures need attention.`,
      unknownError: 'Unknown generation error',
      emptyHub: 'Generation finished, but the Hub has no Doks. Check scan configuration, then retry.',
      upToDate: 'There are no new Doks to generate. Your current Hub is up to date.',
      stage: {
        scan: 'Scan', consolidate: 'Consolidate', roles: 'Roles', lexicon: 'Lexicon',
        doks: 'Dok generation', ia: 'IA', 'code-mapping': 'Code mapping',
      },
      status: { waiting: 'Waiting', running: 'Running', complete: 'Complete', skipped: 'Skipped', failed: 'Failed' },
    },
    hub: {
      eyebrow: 'STEP · HUB',
      title: 'Your Hub is ready',
      hubLabel: 'Generated Hub',
      moreDoks: (n) => `… +${n} more`,
      mcpTitle: 'AI agents read this over MCP',
      mcpDesc: 'This Hub is now agent context. Instead of re-reading your code, agents query Doks for business meaning.',
      mcpExampleLabel: 'Example shape — you have no Dok to query yet',
      mcpExampleReturn: 'the Dok’s scenarios · rules · acceptance criteria',
      next: 'See Live Docs',
      editStudio: 'Edit in Studio',
    },
  },
};
