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
   * in Excel / 한컴오피스 / PowerPoint. Defaults to 'html'.
   */
  preview?: 'html' | 'xlsx' | 'hwpx' | 'pptx';
}

/** Rendered document returned by /api/wizard/livedoc. */
export type RenderedDoc =
  | { kind: 'html'; html: string; filename: string }
  | { kind: 'binary'; dataBase64: string; mime: string; filename: string };

export const WIZARD_LIVEDOCS: LivedocTemplateMeta[] = [
  {
    ref: 'saas-prd',
    title: { ko: '제품 요구사항 문서', en: 'Product Requirements' },
    desc: {
      ko: 'PM이 검토하는 PRD — 시나리오 타임라인, 규칙 카드, 인수조건까지.',
      en: 'A PM-ready PRD — scenario timeline, rule cards, and acceptance criteria.',
    },
    audience: { ko: 'PM', en: 'PM' },
    scope: 'per_dok',
    sections: {
      ko: ['개요', '시나리오 타임라인', '비즈니스 규칙', '인수 조건'],
      en: ['Overview', 'Scenario Timeline', 'Business Rules', 'Acceptance Criteria'],
    },
  },
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
      ko: ['이런 상황에서', '따라하기', '알아두세요', '확인하기'],
      en: ['When this happens', 'Steps', 'Good to know', 'Check it worked'],
    },
  },
  {
    ref: 'github-onboarding',
    title: { ko: '개발자 온보딩', en: 'Developer Onboarding' },
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
    title: { ko: '왜 안 되나요 — 차단 사유 인덱스', en: 'Why Blocked — Denial Index' },
    desc: {
      ko: 'CS가 티켓을 받는 순간 여는 문서 — 기능별 권한·사전조건·검증·제한을 차단 사유 체크리스트로.',
      en: 'What support opens when a ticket lands — permissions, preconditions, validations and limits as a denial checklist per feature.',
    },
    audience: { ko: '고객지원', en: 'Support' },
    scope: 'workspace',
    sections: {
      ko: ['기능 인덱스', '권한', '사전조건', '입력 검증', '제한·정책'],
      en: ['Feature index', 'Permissions', 'Preconditions', 'Input checks', 'Limits & policies'],
    },
  },
  {
    ref: 'permission-gap',
    title: { ko: '권한 규칙 공백 점검표', en: 'Permission Gap Report' },
    desc: {
      ko: '보안 점검 전 제출하는 한 장 — 권한 규칙이 정의되지 않은 active 기능만 적출.',
      en: 'The one-pager submitted before a security review — only the active features with no permission rule.',
    },
    audience: { ko: '보안', en: 'Security' },
    scope: 'workspace',
    sections: {
      ko: ['판정 기준', '검토 대상 (예외만)', '점검 범위'],
      en: ['Criteria', 'For review (exceptions only)', 'Scope'],
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
      ko: ['요구사항추적표 (AC당 1행)', '기능별 집계'],
      en: ['Traceability (one row per AC)', 'Feature summary'],
    },
    preview: 'xlsx',
  },
  {
    ref: 'ops-manual',
    title: { ko: '운영 매뉴얼 (한글 납품본)', en: 'Operations Manual (.hwpx)' },
    desc: {
      ko: '납품·검수 때 발주처 운영자에게 전달하는 한글(.hwpx) 매뉴얼 — 사용 절차·유의사항·확인 기준.',
      en: 'The operator manual handed over at delivery — usage steps, notes and success checks, as Hangul .hwpx.',
    },
    audience: { ko: '운영자·납품', en: 'Operators' },
    scope: 'workspace',
    sections: {
      ko: ['목차', '사용 절차', '운용 시 유의사항', '정상 동작 확인'],
      en: ['Contents', 'Usage steps', 'Operational notes', 'Success checks'],
    },
    preview: 'hwpx',
  },
  {
    ref: 'korean-public-ppt',
    title: { ko: '튜토리얼 슬라이드 (PPTX)', en: 'Tutorial Slides (PPTX)' },
    desc: {
      ko: '교육·발표용 16:9 슬라이드 — 스텝당 1장, 실스크린샷과 조작 위치 하이라이트 포함. 공공기관 매뉴얼 스타일.',
      en: '16:9 training slides — one per step, with captured screenshots and interaction highlights. Public-manual styling.',
    },
    audience: { ko: '교육·발표', en: 'Training' },
    scope: 'per_dok',
    sections: {
      ko: ['표지', '스텝 슬라이드 (스크린샷+행동/결과)', '마무리'],
      en: ['Cover', 'Step slides (screenshot + action/result)', 'Closing'],
    },
    preview: 'pptx',
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
