# 모델 선택하기

Doklo의 현재 production generation에는 엄격한 runtime trust gate가 있습니다. 설정된 model reference는 다음 두 경로에서 **`anthropic/claude-sonnet-5`**여야 합니다:

| 경로 | 인증 | runtime 제약 |
| --- | --- | --- |
| Direct Anthropic | keychain 또는 environment의 Anthropic API credential | 설정된 Doklo reference에서 `anthropic/` prefix를 제거하고 기본 Anthropic transport에 `claude-sonnet-5`를 전송; custom base URL·fetch override 불가 |
| 로컬 Claude Code | 로컬에서 인증된 Claude Code session | 설치된 CLI를 `--model sonnet`으로 실행; Doklo가 관리하는 API key 없음. 움직이는 `sonnet` alias가 가리키는 실제 model은 Claude Code가 결정 |

지원하지 않는 설정 model reference나 경로는 유료 작업 전에 `RUNTIME_TRUST_MODEL_REQUIRED` 또는 `RUNTIME_TRUST_ROUTE_REQUIRED`로 fail-closed합니다. direct 경로는 version-gated입니다. 로컬 경로는 설정 gate를 거치지만 Claude Code의 `sonnet` alias에 위임하므로 실제 하위 model version을 불변으로 고정하지는 않습니다. picker가 다른 model reference의 benchmark guidance를 보여줄 수는 있지만, 선택했다고 해서 현재 production `generate`가 그 model을 허용하는 것은 아닙니다.

대화형 `doklo init`은 picker 선택을 저장·인증하지만 catalog를 실행 가능한 production 경로 두 개로 필터링하지는 않습니다. 로컬 경로를 명시적으로 선택하려면:

```bash
doklo generate --llm-backend claude-code --model anthropic/claude-sonnet-5
```

## sync 판사 (`judge` role)

`doklo sync --judge`는 stale인 설명을 다시 생성하기 전에 아직 맞는지 판사 모델에게 묻습니다([무엇을 다시 만들지 판사에게 맡기기](../../README.ko.md#무엇을-다시-만들지-판사에게-맡기기) 참고). 판사는 자기 task role인 `judge`로 모델을 정하며, 허용하는 모델은 정확히 둘입니다:

| 모델 | 경로 | 쓰이는 경우 |
| --- | --- | --- |
| `anthropic/claude-sonnet-5` | Direct Anthropic. keychain 또는 environment의 Anthropic API credential | 기본값: 재생성 모델이 OpenAI 모델이 아닐 때 |
| `openai/gpt-6-luna` | 기본 OpenAI endpoint로 보내는 OpenAI API key(`doklo auth --provider openai`의 API key 방식 또는 `OPENAI_API_KEY`), 또는 ChatGPT 로그인(`doklo auth`)으로 쓰는 OpenAI Codex 경로 | 재생성 모델이 OpenAI 모델일 때. 이 경우 생성은 ChatGPT 로그인으로만 실행됨. API key로 GPT-6 Luna를 쓰려면 아래처럼 고정: 생성은 OpenAI API key로 실행되지 않으므로 기본값은 그때 GPT-6 Luna를 고르지 않음. GPT-6 Luna는 판사 호출에만 허용되고 생성에는 쓰지 않음 |

고정하지 않으면 판사는 재생성 모델의 공급자를 따릅니다. 재생성 모델은 `doklo sync`에 준 `--model`, 없으면 `generate` role, 없으면 `default`입니다. 고정하려면:

```bash
doklo model --task judge --set anthropic/claude-sonnet-5
doklo model --task judge --set openai/gpt-6-luna
```

그 밖의 판사 모델은 판사 호출 전에 `RUNTIME_TRUST_MODEL_REQUIRED`로 멈추고, 로컬 Claude Code 경로는 `RUNTIME_TRUST_ROUTE_REQUIRED`로 거부합니다. OpenAI API key 경로의 판사 호출은 Codex 경로처럼 `store: false`로 보냅니다. 2026-10-14 벤치마크에서 두 모델 모두 고쳐야 할 변경을 놓치지 않았습니다. GPT-6 Luna는 관련 없는 설명에 몇 번 잘못된 경보를 냈고 실행마다 판정이 덜 일정했으며, Sonnet 5는 잘못된 경보를 내지 않았습니다. 이 벤치마크는 GPT-6 Luna를 Codex 경로로 쟀고, API key endpoint는 스모크 테스트만 했으며 벤치마크하지 않았습니다.

## Picker guidance 3개 티어

`doklo init`이나 `doklo model`의 benchmark label은 research evidence를 뜻하며 현재 runtime 지원표가 아닙니다:

| 티어 | 마커 | 의미 |
| --- | --- | --- |
| **추천(Recommended)** | `★` | 실프로젝트에서 좋은 성능 — 안전한 기본값. |
| **미검증(Unverified)** | — | 벤치마크에 없으므로 품질을 주장하지 않음. 현재 runtime 지원을 뜻하지도 않음. |
| **경고(Warned)** | `⚠` | 실프로젝트에서 성능이 *낮았음* — 품질 문제 예상. |

티어는 picker의 힌트로, 그리고 선택 후 한 줄 메모로 노출됩니다. 위 runtime gate가 최종 기준입니다.

## Benchmark research (현재 runtime 경로 아님)

| 측정 모델 | research 결과 | 현재 production generation |
| --- | --- | --- |
| `anthropic/claude-sonnet-5` | 기록된 benchmark에서 품질/비용 균형이 가장 좋음 | 위 두 경로의 설정 reference로 **허용**; direct Anthropic은 transport model ID `claude-sonnet-5`로 변환 |
| `anthropic/claude-opus-4-8` | benchmark 품질 우수 | 현재 runtime gate에서 허용하지 않음 |
| `openai/gpt-5.6-sol` | benchmark 품질 우수 | 현재 runtime gate에서 허용하지 않음 |
| `openai/gpt-5.6-luna` | benchmark 가성비 우수 | 현재 runtime gate에서 허용하지 않음 |

### 경고

- **`anthropic/claude-haiku-4-5`** — 300개 이상 파일 프로젝트에서 스키마 실패율이 높았고 자신감 있는 환각을 냈습니다. 현재 runtime gate에서도 허용하지 않습니다.

## 근거는 어떻게 만들어지나

추천/경고 목록은 직관이 아니라 완료율·비용·판정 품질을 측정한 멀티모델 × 멀티프로젝트 벤치마크에서 나옵니다. 재현·갱신하려면:

```bash
pnpm bench:models
```

벤치마크 슈트는 [`benchmarks/README.md`](../../benchmarks/README.md), 기록된 결과는 `docs/decisions.md`를 보세요. 목록 자체는 `apps/cli/src/lib/model-guidance.ts`에 있으며, 새 벤치마크 실행 결과가 있을 때만 바꿔야 합니다.
