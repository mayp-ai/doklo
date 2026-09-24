# 실행 범위 확인과 앱 도움말 통합

현재 소스 기준 안내입니다. 설치한 버전의 `--help`에서 새 옵션을 확인하세요.

## 워크스페이스와 소스 경로

워크스페이스 루트에는 `workspace.json`, Hub, 출력 파일이 저장됩니다. 서비스의 `code_root`는 그 안에서 분석할 소스 경로입니다. `web/`과 `server/`가 있는 저장소에서는 다음처럼 시작합니다.

```sh
doklo init --root . --code-root web --service-id web --default-locale ko --yes
doklo scan --root . --json
```

Doklo 상태는 저장소 루트에 두고 `web/`을 분석합니다. 선택한 서비스 루트에서 Next.js App Router가 발견되면 전용 추출을 사용합니다. Python 등 다른 소스에는 범용 분석을 사용합니다. 범용 분석이 서버 프레임워크의 모든 동작을 이해했다는 뜻은 아닙니다. 출력된 경로·분석 방식·포함/제외 범위를 확인하세요. `scan --json`의 `includedFiles`는 서비스 루트 기준 실제 포함 파일 경로입니다. 같은 저장소의 다른 서비스가 자동으로 포함되지는 않습니다.

서버도 분석하려면 기존 `workspace.json`의 다른 내용은 보존하고 `services` 배열에 다음 항목을 추가한 뒤 `doklo scan`을 다시 실행합니다.

```json
{"service_id":"server","type":"backend","framework":"fastapi","code_root":"server"}
```

소스 경로는 실제 존재하는 워크스페이스 내부 상대 디렉터리여야 합니다. 상위 경로·절대 경로·워크스페이스 밖으로 연결되는 심볼릭 링크는 거절합니다.

## 비용 발생 전 확인

```sh
doklo generate --dry-run
doklo consolidate --dry-run
doklo consolidate --service web --dry-run
```

consolidate 계획이 아직 없는 상태는 문서 대상이 0건인 상태와 다릅니다. 유료 호출 전에는 소스 후보와 분석 범위를 볼 수 있지만, 최종 Dok ID와 개수는 모델의 기능 묶기가 끝나야 정해집니다. consolidate는 모델 비용이 발생할 수 있습니다. `--service`로 그 범위를 줄이세요. 계획 생성 후에는 `generate --only CHAT,CHILD --dry-run`으로 특정 문서만 확인할 수 있습니다.

토큰 추정은 견적 금액이나 모델 제공자가 보장하는 상한이 아닙니다. 실제 단계·모델·입력 추정·출력 추정 또는 미확정 값·최대 출력 허용량을 구분하세요. 캐시 사용은 호출 전에 확정할 수 없습니다. 생성 기본 시도 추정과 재시도 허용 범위도 다릅니다. 실측에는 제공자가 보고한 실패 시도 사용량도 포함하며, 측정 불가를 0으로 보지 않습니다. 동일 단계·동일 시도 범위끼리 비교하세요. consolidate의 group 수는 확정 Dok 수가 아닙니다.

소스·모델 계획을 검토한 후 실제 실행하세요. 기존 실행 동의 절차는 유지됩니다. backend 지원 값은 `claude-code`, `anthropic-api`입니다.

```sh
doklo generate --llm-backend anthropic-api --dry-run
```

## 한국어 역할과 정본 용어

새 기본 역할 표시명은 워크스페이스 언어에 맞춥니다. `ROLE-USER` 같은 ID는 유지하고, 사람이 편집한 기존 이름도 보존합니다. Studio에서 기존 역할의 이름을 수정하세요. 역할을 삭제하고 새로 만들 필요는 없습니다. “보호자” 같은 제품 용어를 확정한다고 새 권한 역할이 생기지는 않습니다.

한국어 고객 문체는 `formal`(기본, 합쇼체: “확인합니다”) 또는 `plain`(해라체: “확인한다”)을 선택할 수 있습니다. 처음에는 `doklo init --korean-tone formal`로 지정하고, 기존 워크스페이스에서는 `workspace.json`의 `korean_customer_tone`을 수정하세요. 생성은 선택한 정책을 프롬프트에 넣고, 사용한 정책과 필드별 문체 검토 사항을 Dok 메타데이터에 기록합니다.

정식 한국어 help-page 렌더는 용어 참조와 명시적 치환을 적용한 최종 문구에서 명확한 어미 충돌을 검사합니다. 생성 이후 문체 정책이 바뀐 문서도 검토가 필요합니다. 충돌이 있으면 문구를 수정하거나 선택 재생성한 뒤 다시 검토하세요. `--preview`는 경고와 미검토 표시가 있는 결과를 제공하며 Hub 상태를 바꾸지 않습니다. 인용과 이름·레이블은 검사에서 제외하고, 모든 문장의 문법이나 자연스러움까지 보장하지는 않습니다. 기존 영문 역할명·동의어·문장 어미를 자동으로 바꾸지 않습니다.

정책 변경 뒤 재생성 없이 기존 문구를 직접 고쳐 유지하려면, 사람이 해당 Dok의 고객용 문구를 새 정책에 맞게 검토한 후 `.doklo/hub/doks/<Dok ID>.json`의 기존 `_meta.writing_review`에 `policy_acknowledgment`를 추가하세요. 아래는 `plain` 정책을 검토한 예이며, 시각은 실제 검토한 UTC 시각으로 바꿉니다. 기존 필드와 생성 당시 `_meta.writing_policy`는 보존하세요.

```json
{"policy_acknowledgment":{"locale":"ko","tone":"plain","acknowledged_at":"2026-09-25T00:00:00.000Z"}}
```

이 수동 기록은 현재 정책과 일치할 때 정책 변경 경고를 해소합니다. 남아 있는 문장 어미 충돌은 계속 차단하고, Dok의 승인 상태를 바꾸지는 않습니다. Studio에서 문구를 고치거나 일반 승인을 하는 것만으로 이 기록이 생기지는 않습니다. 새로 생성하면 이전 수동 기록은 승계하지 않으므로 결과를 다시 검토하세요.

Studio의 Dok 텍스트 편집기에서 검토한 문구를 용어로 승격한 뒤 Lexicon에서 확인·수정할 수 있습니다. consolidate 결과나 Dok이 있는 상태에서 모델 제안이 필요하면 `doklo lexicon-suggest --dry-run`으로 범위를 확인하고 별도의 유료 실행에 동의하세요. Studio에서 제안을 수락하거나 수정해야 정본이 됩니다. 미확정 제안은 생성의 정본 지침으로 사용하지 않습니다. 확정된 owned/constant 표시 텍스트와 명시적 TermRef를 사용하며, i18n 바인딩은 현재 직접 해석하지 않습니다. 확정 후 `doklo generate --only CHAT --force`처럼 영향받는 초안을 선택해 다시 생성하고 검토하세요. 용어 수락만으로 기존 문장의 문자열이 모두 바뀌지는 않습니다.

기존 고객 출력에 검토한 문구 교정이 필요하면 `.doklo/audience-text.json`에 언어별 치환을 명시할 수 있습니다.

```json
{"ko":{"취소한다":"취소합니다"}}
```

이 설정은 렌더에만 적용되며 용어 승인이나 원본 Dok 수정이 아닙니다. 넓은 치환은 다른 문장에도 적용될 수 있으니 결과를 확인하세요. 지속적으로 유지할 용어는 원본 초안을 고치고 명시적인 용어 참조로 관리하는 편이 좋습니다.

## 공개 파일 포맷명

JPEG·PNG·WebP·HEIC·HEIF는 공개 포맷명으로 처리합니다. 다른 공개 제품명이 내부 식별자 패턴에 걸리면 기존 루트 `workspace.json`에 다음 필드를 병합하세요. 파일 전체를 이 예제로 교체하지 마세요.

```json
{"stable_public_terms":["ExampleCompany"]}
```

정확히 일치하는 이름의 식별자 패턴에만 적용됩니다. 선택된 내부 Dok ID, 소스 경로, 구현 세부사항, 미완성 문구, 근거 없는 최신성 주장은 계속 검사합니다. `WebP` 허용이 `WebPEncoder` 허용으로 확대되지 않습니다.

## 여러 도움말을 한 페이지에 넣기

```sh
doklo live-docs render help-page --dok CHAT --format html --locale ko \
  --var html_fragment=true --var heading_level=2 \
  --out-dir .doklo/output/help-fragments
```

초안 검토에는 `--preview`를 추가하세요. fragment에도 미검토 표시가 남으며 원본 Hub 상태는 바뀌지 않습니다. 미리보기는 정식 Publication 배포 근거로 쓸 수 없습니다.

fragment는 문서 껍데기·스타일시트·스크립트 없는 article입니다. 스크린샷 표시 좌표와 지속적인 초안 표시에는 인라인 스타일 속성이 남을 수 있습니다. 언어, 제목·섹션 ID, 접근성 이름 참조, `help-*` 클래스를 유지합니다. ID에는 전체 Dok 식별 정보가 들어갑니다. 같은 Dok을 두 번 넣는다면 `--var id_prefix=sidebar`처럼 서로 다른 접두사를 지정하세요. `heading_level`은 1~5 정수이며 섹션은 그다음 수준입니다. 호스트 페이지 제목 아래 배치하고 출력된 ID로 탐색 링크를 연결하세요.

앱의 디자인 토큰은 범위를 제한한 스타일로 적용합니다.

```css
.doklo-help { color: var(--text-color, #202124); }
.doklo-help .help-title { font: inherit; font-size: 1.5rem; }
.doklo-help .help-section-title { font-size: 1.125rem; }
.doklo-help:focus, .doklo-help :focus { outline: 2px solid currentColor; outline-offset: 3px; }
```

`html_fragment`를 생략하면 기존 완결 HTML을 출력합니다. 완결 HTML의 페이지 전체 초기화 CSS를 호스트 앱에 그대로 넣지는 마세요. 통합 후 실제 앱에서 중복 ID, 제목 순서, 키보드 탐색을 확인하세요.

## 안전한 출력·전달

`--out-dir`는 서비스 `code_root`가 아닌 워크스페이스 루트를 기준으로 계산하며, 모든 경로 요소가 그 안에 있어야 합니다. 워크스페이스가 자동으로 저장소 루트가 되는 것은 아닙니다. 내부 절대 경로는 지원하지만 외부·형제 디렉터리와 심볼릭 링크 출력 경로는 거절합니다.

앱이 워크스페이스 안에 있다면 검토된 HTML을 전용 디렉터리에 Publication으로 게시할 수 있습니다.

```sh
doklo live-docs publication create customer-help --template help-page \
  --status active --format html --locale ko --destination web/public/help
doklo live-docs publication render customer-help
doklo live-docs publication publish customer-help --dry-run
doklo live-docs publication publish customer-help
```

워크스페이스 자체가 `web/`라면 목적지는 `public/help`입니다. 기존 소유권·덮어쓰기 검사는 유지됩니다. 형제 앱으로 전달할 때는 먼저 워크스페이스 내부의 전용 준비 디렉터리에 게시하고 검토한 뒤, 고객에게 보여 줄 파일만 목적지 앱의 **아직 존재하지 않는 버전별 새 디렉터리**로 명시적으로 복사하세요. 목적지 경로의 심볼릭 링크를 거절하고 기존 디렉터리에 합치지 마세요. 앱에서 확인한 뒤 참조를 새 버전으로 바꿉니다. 이 외부 복사는 Doklo 출력 경계 밖의 앱 배포 작업입니다.

`doklo live-docs publication export customer-help --zip-path .doklo/output/customer-help.zip`은 워크스페이스 내부에 검증된 ZIP을 만듭니다. ZIP에는 manifest와 근거도 포함되므로 비공개 준비 경로에 풀고 고객용 파일만 `public/`로 전달하세요.
