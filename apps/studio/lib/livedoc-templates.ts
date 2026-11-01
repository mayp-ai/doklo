// Display metadata for the Live Doc templates recommended at the end of
// onboarding. Plain module (no 'use server') so both the client step and
// the server action can import it. `scope` drives whether the render
// targets one representative Dok (per_dok) or the whole workspace.

export interface WizardLivedoc {
  /** Self-contained HTML (inlined CSS) — usable directly as iframe srcDoc
   *  and as the body of a client-side Blob download. */
  html: string;
  filename: string;
}

export type DocLocale = 'ko' | 'en';
export type Localized = Record<DocLocale, string>;

export interface LivedocTemplateMeta {
  ref: string;
  title: Localized;
  desc: Localized;
  /** Audience chip shown on the card. */
  audience: Localized;
  scope: 'per_dok' | 'workspace';
  /** Section labels used to sketch a simple depiction of the document. */
  sections: Record<DocLocale, string[]>;
  /**
   * Which engine output the gallery presents. 'html' previews inline;
   * 'xlsx'/'hwpx'/'pptx' are binary deliverables — download-only, opened
   * in Excel / 한컴오피스 / PowerPoint. 'json' is a data deliverable —
   * also download-only, but consumed by code rather than an office app.
   * Defaults to 'html'.
   */
  preview?: 'html' | 'xlsx' | 'hwpx' | 'pptx' | 'json';
}

/** Rendered document returned by /api/wizard/livedoc. */
export type RenderedDoc =
  | { kind: 'html'; html: string; filename: string }
  | { kind: 'binary'; dataBase64: string; mime: string; filename: string };

export const WIZARD_LIVEDOCS: LivedocTemplateMeta[] = [
  {
    ref: 'help-page',
    title: { ko: '고객 도움말 페이지', en: 'Customer Help Page' },
    desc: {
      ko: '사용자 시각의 단계별 가이드와 "잘 됐는지" 확인 체크리스트.',
      en: 'A user-facing step-by-step guide with a "did it work?" checklist.',
    },
    audience: { ko: '고객지원', en: 'Support' },
    scope: 'per_dok',
    sections: {
      ko: ['어떻게 하나요?', '알아두세요', '잘 되었는지 확인하기'],
      en: ['How to do it', 'Good to know', 'Checking it worked'],
    },
  },
  {
    ref: 'github-onboarding',
    title: { ko: '개발자 온보딩 가이드', en: 'Developer Onboarding Guide' },
    desc: {
      ko: '신규 합류자 1주차용 ONBOARDING — 추천 플로우 + 도메인 맵.',
      en: 'First-week ONBOARDING for new hires — recommended flows + domain map.',
    },
    audience: { ko: '개발', en: 'Engineering' },
    scope: 'workspace',
    sections: {
      ko: ['첫 주 추천 플로우', '제품 도메인 맵', '핵심 용어'],
      en: ['First-week flows', 'Product domains', 'Glossary'],
    },
  },
];

/**
 * The full /livedocs gallery: the wizard's three plus the job-first
 * templates that survived the 2026-06-04 triage (each named after the
 * question its reader brings — see docs/positioning-and-live-docs-catalog.md §2.5).
 * The onboarding wizard keeps WIZARD_LIVEDOCS so its happy path stays at three cards.
 */
export const GALLERY_LIVEDOCS: LivedocTemplateMeta[] = [
  ...WIZARD_LIVEDOCS,
  {
    ref: 'why-blocked',
    title: { ko: '트러블슈팅 가이드', en: 'Troubleshooting Guide' },
    desc: {
      ko: 'CS가 티켓을 받는 순간 여는 내부 문서 — 왜 안 되는지, 기능별 권한·사전조건·검증·제한을 확인 순서대로.',
      en: 'What support opens when a ticket lands — why an action does not go through: permissions, preconditions, validations and limits per feature, in check order.',
    },
    audience: { ko: '고객지원', en: 'Support' },
    scope: 'workspace',
    sections: {
      ko: ['기능 목차', '기능별 조건 표', '그래도 안 되면'],
      en: ['Features', 'Conditions per feature', 'If it still fails'],
    },
  },
  {
    ref: 'permission-gap',
    title: { ko: '접근 권한 검토표', en: 'Access Review Sheet' },
    desc: {
      ko: '기준일 시점의 접근 권한 검토 — 메뉴별 기능 × 역할 표와, 접근 규칙이 없는 기능의 검토란.',
      en: 'A point-in-time access review — features by menu × roles, with a review column for features without an access rule.',
    },
    audience: { ko: '보안', en: 'Security' },
    scope: 'workspace',
    sections: {
      ko: ['역할 정의', '메뉴별 기능 × 역할', '검토 목록'],
      en: ['Role model', 'Features by menu × roles', 'Review lists'],
    },
  },
  {
    ref: 'rtm-trace',
    title: { ko: '요구사항추적표 (RTM)', en: 'Requirements Traceability Matrix' },
    desc: {
      ko: '감리 1순위 점검 산출물 — 요구사항→코드(출처 파일)→시험케이스 추적을 Excel로.',
      en: 'The audit-grade deliverable — requirement → source file → test case traceability, as Excel.',
    },
    audience: { ko: '공공·감리', en: 'Public sector' },
    scope: 'workspace',
    sections: {
      ko: ['요구사항추적표 (4단계 병합 헤더)', '커버리지 점검'],
      en: ['Traceability (4-stage header)', 'Coverage check'],
    },
    preview: 'xlsx',
  },
  {
    ref: 'ops-manual',
    title: { ko: '운영 매뉴얼 (HWPX)', en: 'Administrator Guide (HWPX)' },
    desc: {
      ko: '납품·검수 때 발주처 운영자에게 전달하는 한글(.hwpx) 매뉴얼 — 사용 절차·유의사항·확인 기준.',
      en: 'The administrator guide handed over at delivery — usage steps, notes and success checks, as Hangul .hwpx.',
    },
    audience: { ko: '운영자·납품', en: 'Operators' },
    scope: 'workspace',
    sections: {
      ko: ['문서 정보', '개정 이력', '목차', '개요', '접속 및 권한', '메뉴 구성', '기능별 운영 절차', '부록'],
      en: ['Document info', 'Revisions', 'Contents', 'Overview', 'Access & roles', 'Menus', 'Procedures per feature', 'Appendix'],
    },
    preview: 'hwpx',
  },
  {
    ref: 'feature-spec',
    title: { ko: '기능 명세서', en: 'Functional Specification' },
    desc: {
      ko: 'Hub 전체를 납품 꼴의 기능 명세서 한 권으로 — 표지·개정 이력·목차·개요·시스템 구성(서비스·메뉴 체계·역할)·기능 목록·기능별 절(절차·규칙·수용 기준)·공통 제약·요구사항 추적표·용어집.',
      en: 'The whole Hub as one delivery-grade functional specification — cover, revision history, contents, introduction, system structure (services, menu map, roles), feature list, a section per feature (procedure, rules, acceptance criteria), constraints, traceability matrix, glossary.',
    },
    audience: { ko: '발주처·PM·QA·개발자', en: 'Clients · PM · QA · developers' },
    scope: 'workspace',
    sections: {
      ko: ['표지·개정 이력·목차', '개요·시스템 구성', '기능 목록·기능 상세', '공통 제약·추적표·용어집'],
      en: ['Cover · history · contents', 'Introduction · system structure', 'Feature list · feature details', 'Constraints · RTM · glossary'],
    },
  },
  {
    ref: 'feature-spec-xlsx',
    title: { ko: '기능 명세서 (엑셀)', en: 'Functional Specification (Excel)' },
    desc: {
      ko: '기능 명세서의 엑셀 판 — 기능목록·처리절차·업무규칙·수용기준 네 시트. 구분(메뉴)·역할명·상태가 읽는 말로 채워지고 비고·시험 결과는 검수자 기입 칸.',
      en: 'The spreadsheet edition of the functional specification — four sheets: feature list, procedure steps, business rules, acceptance criteria. Menu group, role names and status print as words; remarks and test results are left for the reviewer.',
    },
    audience: { ko: '발주처·PM·QA', en: 'Clients · PM · QA' },
    scope: 'workspace',
    sections: {
      ko: ['기능목록', '처리절차', '업무규칙', '수용기준'],
      en: ['Features', 'Procedures', 'Business rules', 'Acceptance criteria'],
    },
    preview: 'xlsx',
  },
  {
    ref: 'korean-public-ppt',
    title: { ko: '사용자 매뉴얼 (PPTX, 공공기관 양식)', en: 'User Manual (PPTX, public-sector form)' },
    desc: {
      ko: '공공기관 납품 꼴의 16:9 사용자 매뉴얼 한 권 — 표지·문서 정보·목차·개요·접속 및 권한·메뉴 구성·기능별 화면 설명(스크린샷과 번호 콜아웃, 없으면 화면 설명)·유의사항·문의처·부록.',
      en: 'One 16:9 user manual in the public-sector deliverable form — cover, document info, contents, overview, access and roles, menu map, screens by feature (screenshot with callouts, or a written screen description), cautions, contact, appendix.',
    },
    audience: { ko: '운영자·공공 납품', en: 'Operators · public delivery' },
    scope: 'workspace',
    sections: {
      ko: ['표지·문서 정보·목차', '개요·접속 및 권한·메뉴 구성', '기능별 화면 설명', '유의사항·문의처·부록'],
      en: ['Cover · document info · contents', 'Overview · access · menu map', 'Screens by feature', 'Cautions · contact · appendix'],
    },
    preview: 'pptx',
  },
  {
    ref: 'help-data',
    title: { ko: '도움말 세트 데이터 (JSON)', en: 'Help Set Data (JSON)' },
    desc: {
      ko: '자사 사이트에 도움말을 직접 그릴 때 읽는 고객 안전 뷰 모델(doklo-help-set@1) — 카테고리·아티클·큐레이션 FAQ를 JSON 번들 하나로.',
      en: 'The customer-safe view model (doklo-help-set@1) read when help is rendered inside your own site — categories, articles and curated FAQ as one JSON bundle.',
    },
    audience: { ko: '개발자', en: 'Developers' },
    scope: 'workspace',
    sections: {
      ko: ['카테고리·아티클 번들(JSON)', '큐레이션 FAQ 포함'],
      en: ['Category & article bundle (JSON)', 'Includes curated FAQ'],
    },
    preview: 'json',
  },
];

/** Static UI copy for the Live Docs step, switched by the same toggle. */
export const LIVEDOCS_UI: Record<
  DocLocale,
  {
    heading: string;
    make: string;
    made: string;
    busy: string;
    finish: string;
  }
> = {
  ko: {
    heading: '이 Hub로 이런 문서를 만들 수 있어요',
    make: '문서 만들기',
    made: '다운로드됨',
    busy: '생성 중…',
    finish: 'Dok Studio에서 마무리하기',
  },
  en: {
    heading: 'Turn this Hub into docs like these',
    make: 'Generate',
    made: 'Downloaded',
    busy: 'Generating…',
    finish: 'Finish in Dok Studio',
  },
};
