# @doklo-beta/adapter-nextjs

Next.js App Router → `ProjectIR` adapter.

## Runtime support

| Contract | Supported |
|---|---|
| Framework | Next.js |
| Router | App Router only |
| App roots | `app`, `src/app` |
| Source extensions | `.ts`, `.tsx`, `.js`, `.jsx` |
| Node.js | `>=20.9.0` |

Pages Router-only and non-Next.js projects are rejected before extraction.

## Public API

```typescript
import { extractIR } from '@doklo-beta/adapter-nextjs';

const ir = await extractIR({ rootDir: '/path/to/nextjs-project' });
// ir: ProjectIR — see @doklo-beta/core
```

`extractIR` validates the Next.js dependency and App Router root before the
scanner runs; unsupported projects reject with `UnsupportedNextJsProjectError`.

## Pipeline

```
scanner    ─┐
ast        ─┤  legacy parsers (vendored from doklo-cli)
routing    ─┤
state      ─┘
              │
              ▼
            mappers  (legacy output → IR)
              │
              ▼
          ProjectIR  (framework-agnostic, validated by core schema)
```

The 3 derived parsers (ast / routing / state) consume the same scan and
run in parallel.

## Validation snapshot

Tested against a real-world Next.js 14.2.4 App Router workspace:

- 688 files scanned in ~8s
- 305 routes (page 63, layout 22, api 220 — deduped)
- 1276 components (component 435, function 756, hook 81, class 4)
- 1 store (React Context)
- Output validates against `ProjectIRSchema` (Zod) ✅

## Vendored from doklo-cli

These four files are *vendored* from legacy code, not rewrites:

| File | Source |
|---|---|
| `scanner.ts` | `doklo-cli/src/parser/scanner.ts` |
| `ast.ts` | `doklo-cli/src/parser/ts-parser.ts` |
| `routing.ts` | `doklo-cli/src/parser/nextjs-parser.ts` |
| `state.ts` | `doklo-cli/src/parser/store-parser.ts` |

`legacy-types.ts` mirrors the v4 internal types these parsers consume.
The IR translation lives in `mappers.ts`.

### Why `noUncheckedIndexedAccess: false`

The vendored parsers were authored without strict array-indexing
checks. We override the workspace default in this package's
`tsconfig.json` so the vendored code compiles unchanged. When (or if)
the parsers are rewritten to emit IR directly, this override should be
removed and strict checks restored.

## Roadmap

- [ ] Mid-level IR producers that bypass the legacy types entirely
- [ ] i18n detection (next-intl, next-i18next) → Lexicon hints
- [ ] RBAC extraction (next-auth) → Roles hints
