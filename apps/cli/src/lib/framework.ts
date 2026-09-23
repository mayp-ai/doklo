// Lightweight framework detection from package.json deps.
//
// We deliberately keep this narrow: the result is just a hint shown during
// `doklo init` and stored in workspace.json's services[].framework. The
// adapter packages do their own framework-specific scanning later.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Framework } from '@doklo-beta/core';
import { validateCurrentSourceFiles } from './current-source-policy.js';

interface PackageJson {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

function deps(pkg: PackageJson): Record<string, string> {
  return { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
}

const FRAMEWORK_DISPLAY_NAMES: Partial<Record<Framework, string>> = {
  nextjs: 'Next.js',
  nuxt: 'Nuxt',
  sveltekit: 'SvelteKit',
  svelte: 'Svelte',
  angular: 'Angular',
  'react-vite': 'React (Vite)',
  vue: 'Vue',
  'react-native': 'React Native',
  flutter: 'Flutter',
  nestjs: 'NestJS',
  express: 'Express',
  fastify: 'Fastify',
  fastapi: 'FastAPI',
  django: 'Django',
  rails: 'Rails',
};

export function frameworkDisplayName(framework: Framework): string {
  return FRAMEWORK_DISPLAY_NAMES[framework] ?? framework;
}

export async function detectFramework(projectRoot: string): Promise<Framework> {
  let pkg: PackageJson;
  try {
    await validateCurrentSourceFiles(projectRoot, ['package.json']);
    const raw = await readFile(join(projectRoot, 'package.json'), 'utf-8');
    pkg = JSON.parse(raw) as PackageJson;
  } catch {
    return 'unknown';
  }
  if (!pkg || typeof pkg !== 'object' || Array.isArray(pkg)) return 'unknown';
  const all = deps(pkg);

  // Order matters — prefer specific framework over generic "react".
  if (all['next']) return 'nextjs';
  if (all['nuxt']) return 'nuxt';
  if (all['@sveltejs/kit']) return 'sveltekit';
  if (all['svelte']) return 'svelte';
  if (all['@angular/core']) return 'angular';
  if (all['vite'] && all['react']) return 'react-vite';
  if (all['vue']) return 'vue';
  if (all['react-native']) return 'react-native';
  if (all['flutter']) return 'flutter';
  if (all['@nestjs/core']) return 'nestjs';
  if (all['express']) return 'express';
  if (all['fastify']) return 'fastify';
  if (all['fastapi']) return 'fastapi';
  if (all['django']) return 'django';
  if (all['rails']) return 'rails';

  return 'unknown';
}
