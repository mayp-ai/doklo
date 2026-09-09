// Honest first run, contract half: Studio never produces a workspace
// artifact itself. Everything a user could mistake for "Doklo analyzed my
// code" — Doks, layers, rendered deliverables — is produced by the CLI
// process. Studio only reviews, edits, and previews.
//
// These are boundary tests, not behavior tests: they exist so a future change
// cannot quietly move generation back into the Studio server, where it would
// be invisible to `doklo generate` and to the CLI's consent, cost and ledger
// guarantees.

import { readFileSync, readdirSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const streamMock = vi.fn();
const resolverMock = vi.fn();

vi.mock('../lib/data', () => ({
  workspaceRoot: () => '/workspace',
  loadDok: vi.fn(),
  loadLexicon: vi.fn(),
  resolveTermText: vi.fn(),
}));
vi.mock('../lib/cli-bin', () => ({ resolveStudioCliBin: resolverMock }));
vi.mock('../lib/generate-subprocess', () => ({ streamCliGenerate: streamMock }));

const STUDIO_DIR = dirname(fileURLToPath(import.meta.url)).replace(/\/__tests__$/, '');
const CLI_API_SOURCE = join(STUDIO_DIR, '..', 'cli', 'src', 'api.ts');
const SCANNED_DIRS = ['app', 'lib', 'components'];

/** Client libraries that only exist to call a model provider. Studio holds no
 *  credentials and makes no provider call — the CLI process does both. */
const PROVIDER_SDKS = [
  '@anthropic-ai/sdk',
  '@google/generative-ai',
  '@mistralai/mistralai',
  '@ai-sdk/anthropic',
  '@ai-sdk/openai',
  'cohere-ai',
  'ollama',
  'openai',
];

/** Provider endpoints. A hand-rolled fetch bypasses an SDK ban entirely. */
const PROVIDER_HOSTS = [
  'api.anthropic.com',
  'api.openai.com',
  'openrouter.ai',
  'generativelanguage.googleapis.com',
];

/** Remove block and line comments so prose about generation never satisfies
 *  (or trips) a source assertion. */
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry);
    if (statSync(path).isDirectory()) {
      found.push(...sourceFiles(path));
    } else if (/\.tsx?$/.test(entry)) {
      found.push(path);
    }
  }
  return found;
}

function studioSourceFiles(): string[] {
  return SCANNED_DIRS.flatMap((dir) => sourceFiles(join(STUDIO_DIR, dir)));
}

interface ImportSite {
  file: string;
  clause: string;
  specifier: string;
}

function importsOf(file: string): ImportSite[] {
  const source = stripComments(readFileSync(file, 'utf-8'));
  const sites: ImportSite[] = [];
  // `export { x } from '…'` pulls the module in exactly like an import does,
  // and hands it to callers on top — so both keywords count.
  const statik = /(?:import|export)\s+([^'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const match of source.matchAll(statik)) {
    sites.push({ file, clause: match[1] ?? '', specifier: match[2] ?? '' });
  }
  const dynamic = /import\s*\(\s*(?:\/\*[^*]*\*\/\s*)?['"]([^'"]+)['"]\s*\)/g;
  for (const match of source.matchAll(dynamic)) {
    sites.push({ file, clause: '', specifier: match[1] ?? '' });
  }
  return sites;
}

function shortPath(file: string): string {
  return relative(STUDIO_DIR, file);
}

describe('the CLI owns generation — module boundary', () => {
  it('keeps LLM-backed runners out of the embeddable CLI API', () => {
    const source = stripComments(readFileSync(CLI_API_SOURCE, 'utf-8'));
    // `export type { … }` is erased at runtime, so type re-exports of the
    // generate/consolidate contracts are fine; exported *values* are not.
    const values = source.replace(/export\s+type\s*\{[\s\S]*?\}\s*from\s*['"][^'"]*['"]\s*;/g, '');

    expect(values).not.toMatch(/\brunGenerate\b/);
    expect(values).not.toMatch(/\brunConsolidate\b/);
    // The scan/evaluate runners stay embeddable — they are deterministic and
    // read-only enough for Studio to call directly.
    expect(source).toMatch(/export\s*\{[^}]*\brunScan\b/);
  });

  it('never imports the generator package into the Studio server', () => {
    const offenders = studioSourceFiles()
      .flatMap(importsOf)
      .filter((site) => /^@doklo-beta\/generator(\/|$)/.test(site.specifier))
      .map((site) => shortPath(site.file));

    expect(offenders).toEqual([]);
  });

  it('never imports an LLM-backed runner value anywhere in Studio', () => {
    const offenders = studioSourceFiles()
      .flatMap(importsOf)
      .filter((site) => !/^\s*type\s/.test(site.clause))
      .filter((site) => /\b(runGenerate|runConsolidate)\b/.test(site.clause))
      .map((site) => `${shortPath(site.file)} ← ${site.specifier}`);

    expect(offenders).toEqual([]);
  });

  it('never imports a model provider SDK into the Studio server', () => {
    const offenders = studioSourceFiles()
      .flatMap(importsOf)
      .filter((site) => PROVIDER_SDKS.some(
        (sdk) => site.specifier === sdk || site.specifier.startsWith(`${sdk}/`),
      ))
      .map((site) => `${shortPath(site.file)} ← ${site.specifier}`);

    expect(offenders).toEqual([]);
  });

  it('never names a model provider endpoint anywhere in Studio', () => {
    const offenders = studioSourceFiles()
      .map((file) => ({ file, source: stripComments(readFileSync(file, 'utf-8')) }))
      .flatMap(({ file, source }) => PROVIDER_HOSTS
        .filter((host) => source.includes(host))
        .map((host) => `${shortPath(file)} → ${host}`));

    expect(offenders).toEqual([]);
  });

  it('does not depend on the generator package or a provider SDK', () => {
    const manifest = JSON.parse(readFileSync(join(STUDIO_DIR, 'package.json'), 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };

    const declared = [
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
    ];

    expect(declared).not.toContain('@doklo-beta/generator');
    for (const sdk of PROVIDER_SDKS) expect(declared).not.toContain(sdk);
  });

  it('renders Live Docs in-process only into a discarded temp directory', () => {
    const renderers = studioSourceFiles()
      .map((file) => ({ file, source: stripComments(readFileSync(file, 'utf-8')) }))
      .filter(({ source }) => /\brenderLivedoc\s*\(/.test(source));

    // Every `outDir` handed to the engine must be bound by `mkdtemp`. A render
    // that targets anything else writes into the user's workspace, and that
    // output belongs to `doklo live-docs render`.
    expect(renderers.length).toBeGreaterThan(0);
    for (const { file, source } of renderers) {
      const targets = new Set<string>();
      for (const match of source.matchAll(/\boutDir\s*:\s*([A-Za-z_$][\w$]*)\s*,/g)) {
        targets.add(match[1] as string);
      }
      if (/\boutDir\s*,/.test(source)) targets.add('outDir');

      expect(`${shortPath(file)} outDir bindings`).toBe(
        targets.size > 0 ? `${shortPath(file)} outDir bindings` : 'at least one outDir binding',
      );
      for (const name of targets) {
        const bound = new RegExp(
          `\\b(?:const|let)\\s+${name}\\s*=\\s*await\\s+mkdtemp\\s*\\(`,
        ).test(source);
        expect(`${shortPath(file)}: ${name} from mkdtemp = ${bound}`).toBe(
          `${shortPath(file)}: ${name} from mkdtemp = true`,
        );
      }
    }
  });
});

const ORIGIN = 'http://localhost';
const ACTION_HEADER = 'x-doklo-generation-action';
const CONSENT_HEADER = 'x-doklo-generation-consent';

type PostHandler = (request: Request) => Promise<Response>;

async function authorizedRequest(handler: PostHandler, path: string): Promise<Request> {
  const consent = await handler(new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: { Origin: ORIGIN, [ACTION_HEADER]: 'request-consent' },
  }));
  const { consentToken } = await consent.json() as { consentToken: string };
  const cookie = consent.headers.get('set-cookie')?.split(';', 1)[0] ?? '';
  return new Request(`${ORIGIN}${path}`, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      [ACTION_HEADER]: 'start-generation',
      [CONSENT_HEADER]: consentToken,
      Cookie: cookie,
    },
  });
}

describe('the CLI owns generation — every generation route', () => {
  const completions: Array<() => void> = [];

  beforeEach(() => {
    vi.resetModules();
    streamMock.mockReset();
    resolverMock.mockReset();
    resolverMock.mockResolvedValue('/resolved/cli/dist/index.js');
    streamMock.mockImplementation(() => new Promise<void>((resolve) => {
      completions.push(resolve);
    }));
  });

  afterEach(async () => {
    completions.splice(0).forEach((complete) => complete());
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    vi.clearAllMocks();
  });

  it.each([
    { name: 'wizard', module: '../app/api/wizard/generate/route', path: '/api/wizard/generate?service=web' },
    { name: 'consolidation', module: '../app/api/consolidation/generate/route', path: '/api/consolidation/generate?service=web' },
  ])('routes $name generation through the resolved CLI binary', async ({ module, path }) => {
    const { POST } = await import(module) as { POST: PostHandler };
    const response = await POST(await authorizedRequest(POST, path));

    // Consume enough of the stream to be sure the run actually started.
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    expect(response.status).toBe(200);
    expect(resolverMock).toHaveBeenCalled();
    expect(streamMock).toHaveBeenCalledTimes(1);
    expect(streamMock.mock.calls[0]?.[0]).toMatchObject({
      cliBin: '/resolved/cli/dist/index.js',
      root: '/workspace',
      service: 'web',
    });

    completions.splice(0).forEach((complete) => complete());
    await response.body?.cancel();
  });
});
