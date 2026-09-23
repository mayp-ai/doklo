// ============================================
// Next.js Parser: Next.js 특화 구조 추출
// ============================================

import fs from 'fs/promises';
import path from 'path';
import type { ParserDiagnostic, ScanResult } from './legacy-types.js';

/** Next.js 프로젝트 메타데이터 */
export interface NextJsProjectMeta {
  // package.json 정보
  packageJson: PackageJsonInfo | null;
  
  // Next.js 설정
  nextConfig: NextConfigInfo | null;
  
  // App Router 구조
  appRoutes: AppRoute[];
  
  // Middleware
  middleware: MiddlewareInfo | null;
  
  // 환경변수 (키만, 값은 제외)
  envKeys: string[];

  diagnostics: ParserDiagnostic[];
}

export interface PackageJsonInfo {
  name: string;
  version: string;
  
  // 카테고리별 의존성
  stateManagement: DependencyInfo[];
  dataFetching: DependencyInfo[];
  uiLibrary: DependencyInfo[];
  database: DependencyInfo[];
  auth: DependencyInfo[];
  validation: DependencyInfo[];
  testing: DependencyInfo[];
  other: DependencyInfo[];
  
  // 스크립트
  scripts: Record<string, string>;
}

export interface DependencyInfo {
  name: string;
  version: string;
  category: string;
}

export interface NextConfigInfo {
  hasConfig: boolean;
  configPath: string;
  // 주요 설정들
  experimental?: string[];
  images?: boolean;
  i18n?: boolean;
  redirects?: boolean;
  rewrites?: boolean;
}

export interface AppRoute {
  path: string;           // URL 경로
  filePath: string;       // 파일 경로
  type: 'page' | 'layout' | 'loading' | 'error' | 'not-found' | 'route' | 'template';
  isDynamic: boolean;     // [param] 포함 여부
  isParallel: boolean;    // @folder 패턴
  isIntercepting: boolean; // (.) (..) (...) 패턴
  params: string[];       // 동적 파라미터들
}

export interface MiddlewareInfo {
  filePath: string;
  hasMatcher: boolean;
  matchers: string[];
}

// 의존성 카테고리 매핑
const DEPENDENCY_CATEGORIES: Record<string, string[]> = {
  stateManagement: [
    'zustand', 'redux', '@reduxjs/toolkit', 'recoil', 'jotai', 
    'valtio', 'mobx', 'xstate', 'nanostores'
  ],
  dataFetching: [
    '@tanstack/react-query', 'swr', 'axios', 'ky', 'graphql-request',
    '@apollo/client', 'urql', 'trpc', '@trpc/client', '@trpc/server'
  ],
  uiLibrary: [
    '@radix-ui', '@headlessui/react', '@chakra-ui/react', '@mantine/core',
    '@mui/material', 'antd', 'shadcn', 'tailwindcss', 'styled-components',
    '@emotion/react', 'framer-motion', 'lucide-react', '@heroicons/react'
  ],
  database: [
    'prisma', '@prisma/client', 'drizzle-orm', 'kysely', 'typeorm',
    'mongoose', 'sequelize', '@supabase/supabase-js', 'firebase', '@vercel/postgres'
  ],
  auth: [
    'next-auth', '@auth/core', '@clerk/nextjs', 'lucia', '@supabase/auth-helpers-nextjs',
    'jsonwebtoken', 'jose', 'bcrypt', 'argon2'
  ],
  validation: [
    'zod', 'yup', 'joi', 'class-validator', 'valibot', 'superstruct'
  ],
  testing: [
    'jest', 'vitest', '@testing-library/react', 'playwright', 'cypress',
    '@playwright/test', 'msw'
  ],
};

/**
 * Next.js 프로젝트 메타데이터 추출
 */
export async function parseNextJsProject(scanResult: ScanResult, allowedSourceFiles?: ReadonlySet<string>): Promise<NextJsProjectMeta> {
  const rootDir = scanResult.rootDir;

  const [packageJson, nextConfig, appRouteAnalysis, middleware, envKeys] = await Promise.all([
    !allowedSourceFiles || allowedSourceFiles.has('package.json') ? parsePackageJson(rootDir) : Promise.resolve(null),
    parseNextConfig(rootDir, allowedSourceFiles),
    parseAppRoutes(rootDir, scanResult.files),
    parseMiddleware(rootDir, allowedSourceFiles),
    parseEnvFiles(rootDir, allowedSourceFiles),
  ]);

  return {
    packageJson,
    nextConfig,
    appRoutes: appRouteAnalysis.routes,
    middleware,
    envKeys,
    diagnostics: appRouteAnalysis.diagnostics,
  };
}

/**
 * package.json 파싱
 */
async function parsePackageJson(rootDir: string): Promise<PackageJsonInfo | null> {
  try {
    const content = await fs.readFile(path.join(rootDir, 'package.json'), 'utf-8');
    const pkg = JSON.parse(content);

    const allDeps = {
      ...pkg.dependencies,
      ...pkg.devDependencies,
    };

    const categorized = categorizeDependencies(allDeps);

    return {
      name: pkg.name || 'unknown',
      version: pkg.version || '0.0.0',
      ...categorized,
      scripts: pkg.scripts || {},
    };
  } catch {
    return null;
  }
}

/**
 * 의존성 카테고리화
 */
function categorizeDependencies(deps: Record<string, string>): Omit<PackageJsonInfo, 'name' | 'version' | 'scripts'> {
  const result: Record<string, DependencyInfo[]> = {
    stateManagement: [],
    dataFetching: [],
    uiLibrary: [],
    database: [],
    auth: [],
    validation: [],
    testing: [],
    other: [],
  };

  for (const [name, version] of Object.entries(deps)) {
    let categorized = false;

    for (const [category, packages] of Object.entries(DEPENDENCY_CATEGORIES)) {
      // 정확한 매칭 또는 prefix 매칭 (@radix-ui/* 등)
      if (packages.some(pkg => name === pkg || name.startsWith(pkg + '/'))) {
        result[category].push({ name, version, category });
        categorized = true;
        break;
      }
    }

    // 카테고리화되지 않은 주요 패키지만 other에 추가
    if (!categorized && isNoteworthyPackage(name)) {
      result.other.push({ name, version, category: 'other' });
    }
  }

  return result as Omit<PackageJsonInfo, 'name' | 'version' | 'scripts'>;
}

/**
 * 주목할 만한 패키지인지 확인 (타입 정의, 번들러 플러그인 등 제외)
 */
function isNoteworthyPackage(name: string): boolean {
  // 제외할 패턴
  const excludePatterns = [
    /^@types\//,
    /^eslint/,
    /^prettier/,
    /^typescript$/,
    /^@typescript-eslint/,
    /^postcss/,
    /^autoprefixer$/,
    /^next$/,  // next는 기본이니까
    /^react$/,
    /^react-dom$/,
  ];

  return !excludePatterns.some(pattern => pattern.test(name));
}

/**
 * next.config 파싱
 */
async function parseNextConfig(rootDir: string, allowedSourceFiles?: ReadonlySet<string>): Promise<NextConfigInfo | null> {
  const configFiles = ['next.config.js', 'next.config.mjs', 'next.config.ts'];

  for (const configFile of configFiles) {
    if (allowedSourceFiles && !allowedSourceFiles.has(configFile)) continue;
    const configPath = path.join(rootDir, configFile);
    try {
      const content = await fs.readFile(configPath, 'utf-8');
      
      return {
        hasConfig: true,
        configPath: configFile,
        experimental: extractConfigArray(content, 'experimental'),
        images: content.includes('images:') || content.includes('images :'),
        i18n: content.includes('i18n:') || content.includes('i18n :'),
        redirects: content.includes('redirects'),
        rewrites: content.includes('rewrites'),
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 설정에서 배열 값 추출 (간단한 휴리스틱)
 */
function extractConfigArray(content: string, key: string): string[] {
  const regex = new RegExp(`${key}\\s*:\\s*\\{([^}]+)\\}`, 's');
  const match = content.match(regex);
  if (!match) return [];

  // 키들만 추출
  const keys = match[1].match(/(\w+)\s*:/g);
  return keys ? keys.map(k => k.replace(':', '').trim()) : [];
}

/**
 * App Router 라우트 구조 추출
 */
async function parseAppRoutes(
  rootDir: string,
  files: string[],
): Promise<{ routes: AppRoute[]; diagnostics: ParserDiagnostic[] }> {
  const routes: AppRoute[] = [];
  const diagnostics: ParserDiagnostic[] = [];
  const routeFiles = ['page', 'layout', 'loading', 'error', 'not-found', 'route', 'template'];

  for (const file of files) {
    try {
      // app/ 또는 src/app/ 하위 파일만
      const appMatch = file.match(/^(?:src\/)?app\/(.+)$/);
      if (!appMatch) continue;

      const relativePath = appMatch[1];
      const fileName = path.basename(relativePath, path.extname(relativePath));

      // page.tsx, layout.tsx 등인지 확인
      const routeType = routeFiles.find(rf => fileName === rf);
      if (!routeType) continue;

      const dirPath = path.dirname(relativePath);
      const urlPath = dirPathToUrlPath(dirPath);
      const params = extractDynamicParams(dirPath);

      routes.push({
        path: urlPath,
        filePath: file,
        type: routeType as AppRoute['type'],
        isDynamic: params.length > 0,
        isParallel: dirPath.includes('@'),
        isIntercepting: /\(\.\.*\)/.test(dirPath),
        params,
      });
    } catch (error) {
      diagnostics.push({
        filePath: file,
        stage: 'routing',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    routes: routes.sort((a, b) => a.path.localeCompare(b.path)),
    diagnostics,
  };
}

/**
 * 디렉토리 경로를 URL 경로로 변환
 */
function dirPathToUrlPath(dirPath: string): string {
  if (dirPath === '.') return '/';

  let urlPath = '/' + dirPath
    // Route Groups 제거: (marketing) -> 빈 문자열
    .replace(/\([^)]+\)\/?/g, '')
    // Dynamic segments: [id] -> :id
    .replace(/\[([^\]]+)\]/g, ':$1')
    // Catch-all: [...slug] -> *slug
    .replace(/\[:\.\.\.([^\]]+)\]/g, '*$1')
    // Optional catch-all: [[...slug]] -> *slug?
    .replace(/\[\[\.\.\.([^\]]+)\]\]/g, '*$1?')
    // Parallel routes 제거: @modal -> 빈 문자열
    .replace(/@[^/]+\/?/g, '')
    // Intercepting routes 제거
    .replace(/\(\.\.*\)\/?/g, '')
    // 연속 슬래시 정리
    .replace(/\/+/g, '/')
    // 끝 슬래시 제거
    .replace(/\/$/, '');

  return urlPath || '/';
}

/**
 * 동적 파라미터 추출
 */
function extractDynamicParams(dirPath: string): string[] {
  const params: string[] = [];
  const matches = dirPath.matchAll(/\[([^\]]+)\]/g);
  
  for (const match of matches) {
    let param = match[1];
    // ...slug -> slug (catch-all)
    param = param.replace(/^\.\.\./, '');
    params.push(param);
  }

  return params;
}

/**
 * Middleware 파싱
 */
async function parseMiddleware(rootDir: string, allowedSourceFiles?: ReadonlySet<string>): Promise<MiddlewareInfo | null> {
  const middlewarePaths = [
    'middleware.ts',
    'middleware.js',
    'src/middleware.ts',
    'src/middleware.js',
  ];

  for (const mwPath of middlewarePaths) {
    if (allowedSourceFiles && !allowedSourceFiles.has(mwPath)) continue;
    try {
      const content = await fs.readFile(path.join(rootDir, mwPath), 'utf-8');
      
      // matcher 추출
      const matcherRegex = /matcher\s*[=:]\s*\[([^\]]+)\]/;
      const matcherMatch = content.match(matcherRegex);
      const matchers: string[] = [];

      if (matcherMatch) {
        const matcherContent = matcherMatch[1];
        const stringMatches = matcherContent.matchAll(/['"]([^'"]+)['"]/g);
        for (const m of stringMatches) {
          matchers.push(m[1]);
        }
      }

      return {
        filePath: mwPath,
        hasMatcher: matchers.length > 0,
        matchers,
      };
    } catch {
      continue;
    }
  }

  return null;
}

/**
 * 환경변수 키 추출 (.env 파일들)
 */
async function parseEnvFiles(rootDir: string, allowedSourceFiles?: ReadonlySet<string>): Promise<string[]> {
  const envFiles = ['.env', '.env.local', '.env.development', '.env.production', '.env.example'];
  const allKeys = new Set<string>();

  for (const envFile of envFiles) {
    if (allowedSourceFiles && !allowedSourceFiles.has(envFile)) continue;
    try {
      const content = await fs.readFile(path.join(rootDir, envFile), 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        // KEY=value 패턴
        const match = line.match(/^([A-Z_][A-Z0-9_]*)\s*=/);
        if (match) {
          allKeys.add(match[1]);
        }
      }
    } catch {
      continue;
    }
  }

  return [...allKeys].sort();
}

/**
 * Next.js 메타데이터 콘솔 출력
 */
export function printNextJsMeta(meta: NextJsProjectMeta): void {
  console.log('\n📦 Project Meta (package.json)');
  console.log('─'.repeat(40));

  if (meta.packageJson) {
    const pkg = meta.packageJson;
    console.log(`   ${pkg.name}@${pkg.version}`);

    const categories = [
      { name: 'State Management', data: pkg.stateManagement },
      { name: 'Data Fetching', data: pkg.dataFetching },
      { name: 'UI Library', data: pkg.uiLibrary },
      { name: 'Database/ORM', data: pkg.database },
      { name: 'Auth', data: pkg.auth },
      { name: 'Validation', data: pkg.validation },
    ];

    for (const cat of categories) {
      if (cat.data.length > 0) {
        console.log(`\n   ${cat.name}:`);
        for (const dep of cat.data) {
          console.log(`     • ${dep.name} (${dep.version})`);
        }
      }
    }
  } else {
    console.log('   ⚠️  package.json not found');
  }

  console.log('\n🗂️  App Router Structure');
  console.log('─'.repeat(40));

  if (meta.appRoutes.length > 0) {
    // 타입별로 그룹화
    const pages = meta.appRoutes.filter(r => r.type === 'page');
    const layouts = meta.appRoutes.filter(r => r.type === 'layout');
    const apiRoutes = meta.appRoutes.filter(r => r.type === 'route');

    console.log(`\n   Pages (${pages.length}):`);
    for (const route of pages) {
      const dynamic = route.isDynamic ? ` [${route.params.join(', ')}]` : '';
      console.log(`     • ${route.path}${dynamic}`);
    }

    if (layouts.length > 0) {
      console.log(`\n   Layouts (${layouts.length}):`);
      for (const route of layouts) {
        console.log(`     • ${route.path}`);
      }
    }

    if (apiRoutes.length > 0) {
      console.log(`\n   API Routes (${apiRoutes.length}):`);
      for (const route of apiRoutes) {
        const dynamic = route.isDynamic ? ` [${route.params.join(', ')}]` : '';
        console.log(`     • ${route.path}${dynamic}`);
      }
    }
  } else {
    console.log('   No App Router routes found');
  }

  if (meta.middleware) {
    console.log('\n🔒 Middleware');
    console.log('─'.repeat(40));
    console.log(`   File: ${meta.middleware.filePath}`);
    if (meta.middleware.matchers.length > 0) {
      console.log('   Matchers:');
      for (const m of meta.middleware.matchers) {
        console.log(`     • ${m}`);
      }
    }
  }

  if (meta.envKeys.length > 0) {
    console.log('\n🔐 Environment Variables');
    console.log('─'.repeat(40));
    for (const key of meta.envKeys.slice(0, 15)) {
      const isPublic = key.startsWith('NEXT_PUBLIC_') ? ' (public)' : '';
      console.log(`   • ${key}${isPublic}`);
    }
    if (meta.envKeys.length > 15) {
      console.log(`   ... and ${meta.envKeys.length - 15} more`);
    }
  }
}
