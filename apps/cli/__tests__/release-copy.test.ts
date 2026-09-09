import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const CLI_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const REPO_ROOT = resolve(CLI_DIR, '..', '..');
const README_ASSET_ROOT = './docs/assets';

const EN_GUIDANCE = [
  '### For coding agents',
  'Before changing a feature, use `search_doks` and `get_dok` through the read-only Doklo MCP server. Pass the project root explicitly when configuring the server. Without MCP, use `doklo show` to find a Dok and `doklo show <ID> --json` to inspect it from the project directory.',
  'Check both lifecycle and freshness. A `draft` has not been reviewed by a person. An `active` Dok has crossed the review transition, but may still be stale or incomplete. `is_stale: false` only means the tracked source hash matches; `unknown` does not mean fresh. Compare claims with source code when accuracy matters and report conflicts.',
  'Use existing Doks during development. After integration on the configured recording branch, run `doklo sync --check --json` from its clean checkout when the recording workflow is authorized. Read the final JSONL result and diagnostics as well as the exit code. Do not request recording on every development commit or silently regenerate, force-overwrite human edits, or mark a Dok active to make a check pass.',
  'When the user requests new documentation, initialize with `doklo init --yes --json`, then generate drafts using the approved model route. Generation can send selected source excerpts to a model provider. After generation or regeneration, direct the user to `doklo serve --open` to review drafts in Studio. Execution consent does not approve the resulting document.',
  'The current keyless Claude Code route is available for `generate`; do not assume `sync` supports the same route. If the required route is unavailable, report the limitation instead of silently switching providers.',
].join('\n\n');

const KO_GUIDANCE = [
  '### 코딩 에이전트 안내',
  '기능을 수정하기 전에 읽기 전용 MCP의 `search_doks`와 `get_dok`으로 관련 문서를 읽으세요. MCP 설정에는 프로젝트 루트를 명시하세요. MCP가 없으면 프로젝트 디렉터리에서 `doklo show`로 목록을 보고 `doklo show <ID> --json`으로 문서를 확인하세요.',
  '검토 상태와 최신 여부를 함께 확인하세요. `draft`는 사람 검토 전입니다. `active`도 소스 변경으로 낡았거나 내용이 불완전할 수 있습니다. `is_stale: false`는 추적 소스 해시가 같다는 뜻이며 내용 정확성을 보증하지 않습니다. `unknown`은 최신으로 간주하지 마세요. 정확성이 필요한 주장은 코드와 대조하고 충돌을 보고하세요.',
  '개발 중에는 기존 Dok을 참고하세요. 설정한 기록 기준 브랜치에 반영한 뒤, 기록 작업이 승인된 경우 그 브랜치의 깨끗한 체크아웃에서 `doklo sync --check --json`을 실행하세요. 종료 코드와 JSONL 마지막 result·diagnostics를 함께 읽으세요. 개발 중 매 커밋마다 기록을 요구하거나, 문서를 임의로 재생성하거나, 사람 편집을 강제로 덮어쓰거나, active로 바꾸지 마세요.',
  '사용자가 새 문서 생성을 요청하면 `doklo init --yes --json`으로 초기화한 뒤 승인된 모델 경로로 초안을 생성하세요. 생성 과정에서 선택한 소스 발췌가 모델 공급자에게 전송될 수 있습니다. 생성·재생성이 끝나면 사용자가 `doklo serve --open`으로 Studio에서 초안을 검토하도록 안내하세요. 실행 동의는 결과 문서의 검토 승인이 아닙니다.',
  '현재 키 없는 Claude Code 경로는 `generate`에 제공됩니다. `sync`에도 같은 경로가 있다고 가정하지 마세요. 필요한 경로를 쓸 수 없으면 공급자를 조용히 바꾸지 말고 제한을 알려 주세요.',
].join('\n\n');

const EN_CONSENT =
  'Before running `generate` or `sync`, show the person the source files to be sent, model route, token estimates, and safety limits, and get consent for that run. Use non-interactive `-y` only to carry that consent.';
const KO_CONSENT =
  'generate/sync를 실행하기 전에 전송 소스·모델 경로·예상 토큰·보호 한도를 사람에게 보여 주고 해당 실행의 동의를 받으세요. 비대화형 -y는 그 동의를 전달하는 용도로만 쓰세요.';

describe('0.1.0 release copy', () => {
  it('ships the reviewed first-impression copy and its branch-local image assets', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeKo = readFileSync(join(REPO_ROOT, 'README.ko.md'), 'utf8');

    expect(readme).toContain('<strong>Understand what AI built.</strong>');
    expect(readmeKo).toContain('<strong>기술의 결과를, 사람의 이해로.</strong>');
    for (const path of ['doklo-logo-horizontal.png', 'studio-review.png']) {
      expect(readme).toContain(`${README_ASSET_ROOT}/${path}`);
      expect(readmeKo).toContain(`${README_ASSET_ROOT}/${path}`);
      expect(readFileSync(join(REPO_ROOT, 'docs', 'assets', path)).subarray(0, 8))
        .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    }
    expect(readme).toContain(`${README_ASSET_ROOT}/studio-tour.gif`);
    expect(readmeKo).toContain(`${README_ASSET_ROOT}/studio-tour.gif`);
    expect(
      readFileSync(join(REPO_ROOT, 'docs', 'assets', 'studio-tour.gif'))
        .subarray(0, 6)
        .toString('ascii'),
    ).toMatch(/^GIF8[79]a$/);
    expect(readFileSync(join(REPO_ROOT, 'docs', 'assets', 'doklo-symbol.png')).subarray(0, 8))
      .toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  });

  it('keeps initialization in the CLI and points MCP setup lower', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeKo = readFileSync(join(REPO_ROOT, 'README.ko.md'), 'utf8');
    const quickstart = readme.slice(readme.indexOf('## Quickstart'), readme.indexOf('## What to know'));
    const quickstartKo = readmeKo.slice(
      readmeKo.indexOf('## 빠른 시작'),
      readmeKo.indexOf('## 시작하기 전에 알아 둘 것'),
    );

    expect(quickstart).toContain('Initialization stays in the CLI.');
    expect(quickstart).not.toContain('If you chose **Browser**');
    expect(quickstartKo).toContain('초기화는 CLI에서 끝납니다.');
    expect(quickstartKo).not.toContain('**브라우저**를 선택했다면');
    expect(quickstart).not.toContain('doklo mcp');
    expect(quickstartKo).not.toContain('doklo mcp');
    expect(quickstart).toContain('[Use it from your AI agent (MCP)](#use-it-from-your-ai-agent-mcp)');
    expect(quickstartKo).toContain('[AI 에이전트에서 사용하기 (MCP)](#ai-에이전트에서-사용하기-mcp)');
  });

  it('ships the reviewed coding-agent guidance verbatim in both READMEs and the guide', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeKo = readFileSync(join(REPO_ROOT, 'README.ko.md'), 'utf8');
    const guide = readFileSync(join(REPO_ROOT, 'AGENT_GUIDE.md'), 'utf8');

    expect(readme).toContain(EN_GUIDANCE);
    expect(readmeKo).toContain(KO_GUIDANCE);
    expect(guide).toContain(EN_GUIDANCE);
    expect(guide).toContain(KO_GUIDANCE);
  });

  it('uses per-run human confirmation for generate and sync', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeKo = readFileSync(join(REPO_ROOT, 'README.ko.md'), 'utf8');
    const guide = readFileSync(join(REPO_ROOT, 'AGENT_GUIDE.md'), 'utf8');

    expect(readme).toContain(EN_CONSENT);
    expect(readmeKo).toContain(KO_CONSENT);
    expect(guide).toContain(EN_CONSENT);
    expect(guide).toContain(KO_CONSENT);
  });

  it('copies AGENT_GUIDE.md and lists it in the generated package allowlist', () => {
    const source = readFileSync(join(CLI_DIR, 'scripts', 'build-release.mjs'), 'utf8');

    expect(source).toContain(
      "['README.md', 'README.ko.md', 'AGENT_GUIDE.md', 'LICENSE', 'NOTICE', 'CHANGELOG.md']",
    );
    expect(source.match(/'AGENT_GUIDE\.md'/g)).toHaveLength(2);
  });

  it('marks 0.1.0 released on 2026-09-09 without unpublished copy', () => {
    const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    const readmes = ['README.md', 'README.ko.md'].map((name) =>
      readFileSync(join(REPO_ROOT, name), 'utf8'),
    );

    expect(changelog).toContain('## [0.1.0] - 2026-09-09');
    expect(changelog).not.toContain('## [Unreleased]');
    expect(changelog).not.toContain('has not been tagged or published');
    expect(readmes[0]).toContain('## Install');
    expect(readmes[0]).not.toContain('after the 0.1.0 release');
    expect(readmes[0]).not.toContain('has not been published yet');
    expect(readmes[1]).toContain('## 설치');
    expect(readmes[1]).not.toContain('0.1.0 배포 후');
    expect(readmes[1]).not.toContain('아직 publish되지 않았습니다');
  });

  it('documents the release highlights and the two known limitations', () => {
    const changelog = readFileSync(join(REPO_ROOT, 'CHANGELOG.md'), 'utf8');
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    const readmeKo = readFileSync(join(REPO_ROOT, 'README.ko.md'), 'utf8');

    expect(changelog).toContain('Apache-2.0');
    for (const template of [
      'feature-matrix',
      'github-onboarding',
      'help-index',
      'help-page',
      'keep-a-changelog',
      'permission-gap',
      'release-digest',
    ]) {
      expect(changelog).toContain(template);
    }
    expect(changelog).toContain('UNSUPPORTED_FRAMEWORK');
    expect(readme).toContain(
      '`doklo sync` regenerates through a supported model and an authenticated profile you select; the credential-free local Claude Code route is `generate`-only.',
    );
    expect(readme).toContain(
      'Terms listed in `workspace.json` under `stable_public_terms` are not treated as identifiers (exact match only).',
    );
    expect(readmeKo).toContain(
      '`doklo sync`는 지원되는 모델과 인증 프로필을 선택해 다시 생성합니다. 자격 증명 없는 로컬 Claude Code 경로는 `generate`에서만 됩니다.',
    );
    expect(readmeKo).toContain(
      '`workspace.json`의 `stable_public_terms`에 적은 단어는 식별자로 보지 않습니다(정확히 일치할 때만).',
    );
  });
});
