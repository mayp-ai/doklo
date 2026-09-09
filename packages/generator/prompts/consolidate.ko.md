# Feature Consolidation Prompt — 한국어 (placeholder)

> **상태:** 아직 연결 안 됨. 실제 프롬프트는 `consolidator.ts::buildConsolidationPrompt`
> 함수 내부에서 빌드됨. .md 파일로의 외부화는 후속 작업.
>
> 외부화 시 consolidator가 `workspace.default_locale`에 따라 이 파일과
> `consolidate.en.md`를 선택하도록 변경 예정.

현재 consolidator 프롬프트는 영어 instructions + 한국어 reason/label 출력 요청
형태. 한국어 default_locale일 때 사용할 한국어 instructions 버전을 여기
작성하면 됨. 외부화 시 `{{projectName}}`, `{{featureGroups}}` placeholder
사용.
