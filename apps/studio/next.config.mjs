import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));

/** @type {import('next').NextConfig} */
export default {
  // Studio reads .doklo/hub/<workspace>/doks/*.json from the filesystem at
  // request time. No build-time data baking — every page re-reads.
  reactStrictMode: true,
  // Prevent Next.js from trying to typecheck or lint the monorepo
  // root during build (the parent directory has its own tsconfig).
  typescript: { tsconfigPath: './tsconfig.json' },
  // Ship Studio as a self-contained production server. `next build` emits
  // .next/standalone/ with a minimal server.js + only the traced node_modules,
  // which the CLI's `serve` command boots directly (no monorepo needed at
  // runtime). See apps/cli/src/commands/serve.ts + scripts/copy-standalone-assets.mjs.
  output: 'standalone',
  // pnpm monorepo: by default Next traces from apps/studio only, which drops
  // the workspace deps (@doklo-beta/*) that live at the repo root via pnpm
  // symlinks. Point the trace root at the monorepo root (two dirs up) so their
  // real files are copied into the standalone tree. Promoted from `experimental`
  // to a top-level option in Next 15. Computed relative to this config file so
  // it holds in both the main checkout and git worktrees.
  outputFileTracingRoot: join(here, '..', '..'),
  // Drop kordoc's optional heavy native tree from the standalone build. kordoc
  // (used only by packages/livedoc-engine/src/writers/hwpx.ts, and now imported
  // lazily there) transitively drags onnxruntime-node (~2×130MB/90MB), sharp +
  // its non-portable @img/sharp-libvips-* binaries, @huggingface/transformers,
  // and @hyzyla/pdfium — together the bulk of a ~326MB standalone tree. HWPX is
  // a lazy optional feature (writers/hwpx.ts throws a friendly install hint when
  // kordoc is absent), so none of this belongs in the shipped server. Verified
  // kordoc-only via `pnpm why -r`; sharp is only Next's *optional* image dep and
  // Studio uses no next/image, so excluding it is safe.
  //
  // Two glob forms per package are intentional and both required: Next resolves
  // per-route excludes with path.join(<appDir>, glob) (needs the `../../` prefix
  // to reach the pnpm-hoisted store under outputFileTracingRoot), while the
  // server-trace ignore matches the raw glob against absolute paths with
  // `contains:true` (needs the plain `**/` form).
  outputFileTracingExcludes: {
    '*': [
      '**/node_modules/kordoc/**',
      '../../**/node_modules/kordoc/**',
      '**/node_modules/onnxruntime-node/**',
      '../../**/node_modules/onnxruntime-node/**',
      '**/node_modules/@huggingface/transformers/**',
      '../../**/node_modules/@huggingface/transformers/**',
      '**/node_modules/sharp/**',
      '../../**/node_modules/sharp/**',
      '**/node_modules/@img/**',
      '../../**/node_modules/@img/**',
      '**/node_modules/@hyzyla/**',
      '../../**/node_modules/@hyzyla/**',
    ],
  },
  // Template manifests, bodies, default CSS, and the experimental PPTX writer
  // are loaded from the filesystem at runtime. Native dynamic imports keep the
  // engine out of Next's server bundle, so explicitly retain their standalone
  // runtime files.
  outputFileTracingIncludes: {
    '*': [
      '../../packages/livedoc-engine/templates/**/*',
      '../../packages/livedoc-engine/dist/css/**/*',
      '../../packages/livedoc-engine/node_modules/pptxgenjs/**/*',
      '../../node_modules/.pnpm/pptxgenjs@*/node_modules/pptxgenjs/**/*',
      '../../node_modules/.pnpm/image-size@*/node_modules/image-size/**/*',
      '../../node_modules/.pnpm/jszip@*/node_modules/jszip/**/*',
      '../../node_modules/.pnpm/https@*/node_modules/https/**/*',
    ],
  },
  // The onboarding wizard's server actions / route handlers import the
  // CLI's `run*` runners, which pull in Node-only, heavyweight deps
  // (ts-morph AST, the Anthropic SDK, simple-git). Keep them external so
  // Next doesn't try to bundle them into the server build.
  serverExternalPackages: [
    '@doklo-beta/cli',
    '@doklo-beta/adapter-nextjs',
    '@doklo-beta/generator',
    '@doklo-beta/livedoc-engine',
    'ts-morph',
    '@anthropic-ai/sdk',
    'simple-git',
  ],
};
