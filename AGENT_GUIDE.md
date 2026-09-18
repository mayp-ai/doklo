# Doklo Agent Guide

### For coding agents

Before changing a feature, use `search_doks` and `get_dok` through the read-only Doklo MCP server. Pass the project root explicitly when configuring the server. Without MCP, use `doklo show` to find a Dok and `doklo show <ID> --json` to inspect it from the project directory.

Check both lifecycle and freshness. A `draft` has not been reviewed by a person. An `active` Dok has crossed the review transition, but may still be stale or incomplete. `is_stale: false` only means the tracked source hash matches; `unknown` does not mean fresh. Compare claims with source code when accuracy matters and report conflicts.

Use existing Doks during development. After integration on the configured recording branch, run `doklo sync --check --json` from its clean checkout when the recording workflow is authorized. Read the final JSONL result and diagnostics as well as the exit code. Do not request recording on every development commit or silently regenerate, force-overwrite human edits, or mark a Dok active to make a check pass.

When the user requests new documentation, initialize with `doklo init --yes --json`, then generate drafts using the approved model route. Generation can send selected source excerpts to a model provider. After generation or regeneration, direct the user to `doklo serve --open` to review drafts in Studio. Execution consent does not approve the resulting document.

The current keyless Claude Code route is available for `generate`; do not assume `sync` supports the same route. If the required route is unavailable, report the limitation instead of silently switching providers.

Before running `generate` or `sync`, show the person the source files to be sent, model route, token estimates, and safety limits, and get consent for that run. Use non-interactive `-y` only to carry that consent.

### 코딩 에이전트 안내

기능을 수정하기 전에 읽기 전용 MCP의 `search_doks`와 `get_dok`으로 관련 문서를 읽으십시오. MCP 설정에는 프로젝트 루트를 명시하십시오. MCP가 없으면 프로젝트 디렉터리에서 `doklo show`로 목록을 보고 `doklo show <ID> --json`으로 문서를 확인하십시오.

검토 상태와 최신 여부를 함께 확인하십시오. `draft`는 사람 검토 전입니다. `active`도 소스 변경으로 낡았거나 내용이 불완전할 수 있습니다. `is_stale: false`는 추적 소스 해시가 같다는 뜻이며 내용 정확성을 보증하지 않습니다. `unknown`은 최신으로 간주하지 마십시오. 정확성이 필요한 주장은 코드와 대조하고 충돌을 보고하십시오.

개발 중에는 기존 Dok을 참고하십시오. 설정한 기록 기준 브랜치에 반영한 뒤, 기록 작업이 승인된 경우 그 브랜치의 깨끗한 체크아웃에서 `doklo sync --check --json`을 실행하십시오. 종료 코드와 JSONL 마지막 result·diagnostics를 함께 읽으십시오. 개발 중 매 커밋마다 기록을 요구하거나 문서를 임의로 재생성하거나 사람 편집을 강제로 덮어쓰거나 active로 바꾸지 마십시오.

사용자가 새 문서 생성을 요청하면 `doklo init --yes --json`으로 초기화한 뒤 승인된 모델 경로로 초안을 생성하십시오. 생성 과정에서 선택한 소스 코드 일부가 모델 공급자에게 전송될 수 있습니다. 생성·재생성이 끝나면 사용자가 `doklo serve --open`으로 Studio에서 초안을 검토하도록 안내하십시오. 실행 동의는 결과 문서의 검토 승인이 아닙니다.

현재 키 없는 Claude Code 경로는 `generate`에 제공됩니다. `sync`에도 같은 경로가 있다고 가정하지 마십시오. 필요한 경로를 쓸 수 없으면 공급자를 조용히 바꾸지 말고 제한을 알려 주십시오.

generate/sync를 실행하기 전에 전송 소스·모델 경로·예상 토큰·보호 한도를 사람에게 보여 주고 해당 실행의 동의를 받으십시오. 비대화형 -y는 그 동의를 전달하는 용도로만 쓰십시오.
