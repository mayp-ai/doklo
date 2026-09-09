import { describe, it, expect } from 'vitest';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  detectFramework,
  frameworkDisplayName,
} from '../src/lib/framework.js';

async function tmpProject(pkg: object): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'doklo-fw-'));
  await writeFile(join(dir, 'package.json'), JSON.stringify(pkg), 'utf-8');
  return dir;
}

describe('detectFramework', () => {
  it('returns "nextjs" when next is in dependencies', async () => {
    const dir = await tmpProject({ dependencies: { next: '^14.0.0' } });
    expect(await detectFramework(dir)).toBe('nextjs');
  });

  it('returns "nextjs" when next is in devDependencies', async () => {
    const dir = await tmpProject({ devDependencies: { next: '^14.0.0' } });
    expect(await detectFramework(dir)).toBe('nextjs');
  });

  it('returns "react-vite" when vite + react are present', async () => {
    const dir = await tmpProject({
      dependencies: { react: '^18.0.0' },
      devDependencies: { vite: '^5.0.0' },
    });
    expect(await detectFramework(dir)).toBe('react-vite');
  });

  it('returns "vue" when vue dep is present', async () => {
    const dir = await tmpProject({ dependencies: { vue: '^3.4.0' } });
    expect(await detectFramework(dir)).toBe('vue');
  });

  it('returns "unknown" when no recognized framework', async () => {
    const dir = await tmpProject({ dependencies: { lodash: '*' } });
    expect(await detectFramework(dir)).toBe('unknown');
  });

  it('returns "unknown" when package.json is missing', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-fw-empty-'));
    await mkdir(dir, { recursive: true });
    expect(await detectFramework(dir)).toBe('unknown');
  });

  it('returns "unknown" when package.json is malformed', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'doklo-fw-bad-'));
    await writeFile(join(dir, 'package.json'), 'not json', 'utf-8');
    expect(await detectFramework(dir)).toBe('unknown');
  });
});

describe('frameworkDisplayName', () => {
  it.each([
    ['nextjs', 'Next.js'],
    ['nuxt', 'Nuxt'],
    ['sveltekit', 'SvelteKit'],
    ['svelte', 'Svelte'],
    ['angular', 'Angular'],
    ['react-vite', 'React (Vite)'],
    ['vue', 'Vue'],
    ['react-native', 'React Native'],
    ['flutter', 'Flutter'],
    ['nestjs', 'NestJS'],
    ['express', 'Express'],
    ['fastify', 'Fastify'],
    ['fastapi', 'FastAPI'],
    ['django', 'Django'],
    ['rails', 'Rails'],
  ] as const)('maps %s to %s', (framework, expected) => {
    expect(frameworkDisplayName(framework)).toBe(expected);
  });
});
