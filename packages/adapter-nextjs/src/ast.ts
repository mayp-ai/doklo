// ============================================
// TS Parser: TypeScript/JavaScript 구조 추출
// ============================================

import { Project, SourceFile, SyntaxKind, Node, ts } from 'ts-morph';
import path from 'path';
import type { RoleSignalIR } from '@doklo-beta/core';
import { extractRoleSignals } from './role-signal-extractor.js';
import type {
  ParseResult,
  FunctionInfo,
  RouteInfo,
  ComponentInfo,
  ClassInfo,
  ImportInfo,
  ParseError,
  ParserDiagnostic,
  ScanResult,
} from './legacy-types.js';

/**
 * 프로젝트를 파싱하여 구조 정보 추출
 */
export function parseProject(scanResult: ScanResult): ParseResult {
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: 2, // React
    },
    skipAddingFilesFromTsConfig: true,
  });

  const functions: FunctionInfo[] = [];
  const routes: RouteInfo[] = [];
  const components: ComponentInfo[] = [];
  const classes: ClassInfo[] = [];
  const imports: ImportInfo[] = [];
  const roleSignals: RoleSignalIR[] = [];
  const errors: ParseError[] = [];
  const diagnostics: ParserDiagnostic[] = [];

  // 파일 추가
  for (const file of scanResult.files) {
    const fullPath = path.join(scanResult.rootDir, file);
    try {
      const sourceFile = project.addSourceFileAtPath(fullPath);
      for (const message of readSyntaxDiagnostics(sourceFile)) {
        diagnostics.push({ filePath: file, stage: 'ast', message });
        errors.push({ filePath: file, message });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      diagnostics.push({ filePath: file, stage: 'ast', message });
      errors.push({ filePath: file, message });
    }
  }

  for (const sourceFile of project.getSourceFiles()) {
    const relativePath = path.relative(scanResult.rootDir, sourceFile.getFilePath());
    if (diagnostics.some((diagnostic) => diagnostic.filePath === relativePath)) {
      continue;
    }
    
    try {
      // 함수 추출
      functions.push(...extractFunctions(sourceFile, relativePath));
      
      // 클래스 추출
      classes.push(...extractClasses(sourceFile, relativePath));
      
      // import 추출
      imports.push(extractImports(sourceFile, relativePath));

      // Extract role signals during the existing source-file pass.
      roleSignals.push(...extractRoleSignals(sourceFile, relativePath));
      
      // API 라우트 감지 (Next.js App Router / Pages Router)
      if (isApiRoute(relativePath)) {
        routes.push(...extractRoutes(sourceFile, relativePath));
      }
      
      // React 컴포넌트 감지
      if (relativePath.endsWith('.tsx') || relativePath.endsWith('.jsx')) {
        components.push(...extractComponents(sourceFile, relativePath));
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      errors.push({ filePath: relativePath, message });
      diagnostics.push({ filePath: relativePath, stage: 'ast', message });
    }
  }

  return {
    scanResult,
    functions,
    routes,
    components,
    classes,
    imports,
    roleSignals,
    errors,
    diagnostics,
  };
}

function readSyntaxDiagnostics(sourceFile: SourceFile): string[] {
  const compilerNode = sourceFile.compilerNode as typeof sourceFile.compilerNode & {
    parseDiagnostics?: readonly ts.Diagnostic[];
  };
  return (compilerNode.parseDiagnostics ?? []).map((diagnostic) => {
    const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n');
    const code = `TS${diagnostic.code}`;
    if (diagnostic.start === undefined) return `${code} ${message}`;
    const position = sourceFile.getLineAndColumnAtPos(diagnostic.start);
    return `${code} ${position.line}:${position.column} ${message}`;
  });
}

/**
 * 함수 추출
 */
function extractFunctions(sourceFile: SourceFile, filePath: string): FunctionInfo[] {
  const functions: FunctionInfo[] = [];

  // 일반 함수 선언
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name) continue; // 익명 함수 제외
    
    functions.push({
      name,
      filePath,
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      isExported: fn.isExported(),
      isAsync: fn.isAsync(),
      params: fn.getParameters().map(p => ({
        name: p.getName(),
        type: p.getTypeNode()?.getText() ?? p.getType().getText(p) ?? null,
        isOptional: p.isOptional(),
      })),
      returnType: fn.getReturnTypeNode()?.getText() ?? fn.getReturnType()?.getText(fn) ?? null,
      jsDoc: fn.getJsDocs()[0]?.getDescription() || null,
    });
  }

  // 화살표 함수 (변수에 할당된 것)
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;
    
    if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
      const name = varDecl.getName();
      const varStatement = varDecl.getVariableStatement();
      
      functions.push({
        name,
        filePath,
        startLine: varDecl.getStartLineNumber(),
        endLine: varDecl.getEndLineNumber(),
        isExported: varStatement?.isExported() || false,
        isAsync: initializer.isAsync(),
        params: initializer.getParameters().map(p => ({
          name: p.getName(),
          type: p.getTypeNode()?.getText() ?? p.getType()?.getText(p) ?? null,
          isOptional: p.isOptional(),
        })),
        returnType:
          initializer.getReturnTypeNode()?.getText()
          ?? initializer.getReturnType()?.getText(initializer)
          ?? null,
        jsDoc: varStatement?.getJsDocs()[0]?.getDescription() || null,
      });
    }
  }

  return functions;
}

/**
 * 클래스 추출
 */
function extractClasses(sourceFile: SourceFile, filePath: string): ClassInfo[] {
  return sourceFile.getClasses().map(cls => ({
    name: cls.getName() || 'AnonymousClass',
    filePath,
    startLine: cls.getStartLineNumber(),
    endLine: cls.getEndLineNumber(),
    isExported: cls.isExported(),
    methods: cls.getMethods().map(m => m.getName()),
    properties: cls.getProperties().map(p => p.getName()),
  }));
}

/**
 * Import 추출
 */
function extractImports(sourceFile: SourceFile, filePath: string): ImportInfo {
  const imports = sourceFile.getImportDeclarations().map(imp => ({
    moduleSpecifier: imp.getModuleSpecifierValue(),
    namedImports: imp.getNamedImports().map(n => n.getName()),
    defaultImport: imp.getDefaultImport()?.getText() || null,
  }));

  return { filePath, imports };
}

/**
 * API 라우트인지 확인
 */
function isApiRoute(filePath: string): boolean {
  // Next.js App Router: app/api/...
  // Next.js Pages Router: pages/api/...
  // 일반 Express 등: routes/, api/
  return (
    filePath.includes('/api/') ||
    filePath.includes('/routes/') ||
    filePath.includes('route.ts') ||
    filePath.includes('route.js')
  );
}

/**
 * API 라우트 추출 (Next.js 패턴)
 */
function extractRoutes(sourceFile: SourceFile, filePath: string): RouteInfo[] {
  const routes: RouteInfo[] = [];
  
  // URL 경로 추론
  const urlPath = filePathToUrlPath(filePath);
  
  // HTTP 메서드 핸들러 찾기
  const httpMethods = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'];
  const handlers: string[] = [];
  
  // export된 함수 중 HTTP 메서드명인 것 찾기 (App Router)
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (name && httpMethods.includes(name) && fn.isExported()) {
      handlers.push(name);
    }
  }
  
  // export된 변수 중 HTTP 메서드명인 것 찾기
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (httpMethods.includes(name)) {
      const varStatement = varDecl.getVariableStatement();
      if (varStatement?.isExported()) {
        handlers.push(name);
      }
    }
  }
  
  // default export handler (Pages Router)
  const defaultExport = sourceFile.getDefaultExportSymbol();
  if (defaultExport && handlers.length === 0) {
    handlers.push('default');
  }

  if (handlers.length > 0) {
    for (const method of handlers) {
      routes.push({
        filePath,
        method: method === 'default' ? 'ALL' : method,
        path: urlPath,
        handlers: [method],
      });
    }
  }

  return routes;
}

/**
 * 파일 경로를 URL 경로로 변환
 */
function filePathToUrlPath(filePath: string): string {
  let urlPath = filePath
    // Next.js app router
    .replace(/^app/, '')
    .replace(/^src\/app/, '')
    // Next.js pages router
    .replace(/^pages/, '')
    .replace(/^src\/pages/, '')
    // 파일명 제거
    .replace(/\/route\.(ts|js|tsx|jsx)$/, '')
    .replace(/\/index\.(ts|js|tsx|jsx)$/, '')
    .replace(/\.(ts|js|tsx|jsx)$/, '')
    // [param] -> :param
    .replace(/\[([^\]]+)\]/g, ':$1')
    // [...param] -> *
    .replace(/\[:\.\.\.([^\]]+)\]/g, '*');
  
  // 빈 경로는 루트
  if (!urlPath || urlPath === '/') {
    urlPath = '/';
  }
  
  return urlPath;
}

/**
 * React 컴포넌트 추출
 */
function extractComponents(sourceFile: SourceFile, filePath: string): ComponentInfo[] {
  const components: ComponentInfo[] = [];
  
  // 함수 컴포넌트 (대문자로 시작하는 함수)
  for (const fn of sourceFile.getFunctions()) {
    const name = fn.getName();
    if (!name || !isComponentName(name)) continue;
    
    // JSX 반환 여부 확인 (간단한 휴리스틱)
    const body = fn.getBody()?.getText() || '';
    if (!containsJSX(body)) continue;
    
    components.push({
      name,
      filePath,
      startLine: fn.getStartLineNumber(),
      endLine: fn.getEndLineNumber(),
      props: extractPropsFromParams(fn.getParameters()),
      isDefaultExport: false,
      hooks: extractHooks(body),
    });
  }
  
  // 화살표 함수 컴포넌트
  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    if (!isComponentName(name)) continue;
    
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;
    
    if (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer)) {
      const body = initializer.getBody()?.getText() || '';
      if (!containsJSX(body)) continue;
      
      const varStatement = varDecl.getVariableStatement();
      
      components.push({
        name,
        filePath,
        startLine: varDecl.getStartLineNumber(),
        endLine: varDecl.getEndLineNumber(),
        props: extractPropsFromParams(initializer.getParameters()),
        isDefaultExport: false,
        hooks: extractHooks(body),
      });
    }
  }
  
  // default export 확인
  const defaultExportSymbol = sourceFile.getDefaultExportSymbol();
  if (defaultExportSymbol) {
    const name = defaultExportSymbol.getName();
    const comp = components.find(c => c.name === name);
    if (comp) {
      comp.isDefaultExport = true;
    }
  }

  return components;
}

/**
 * 컴포넌트 이름인지 확인 (대문자로 시작)
 */
function isComponentName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

/**
 * JSX 포함 여부 확인
 */
function containsJSX(code: string): boolean {
  return /<[A-Za-z]/.test(code);
}

/**
 * 함수 파라미터에서 Props 추출
 */
function extractPropsFromParams(params: any[]): { name: string; type: string | null; isOptional: boolean }[] {
  if (params.length === 0) return [];
  
  const firstParam = params[0];
  const type = firstParam.getType();
  const typeText = type?.getText(firstParam) || null;
  
  // Props 타입에서 속성 추출 시도
  try {
    const properties = type?.getProperties() || [];
    return properties.map((p: { getName: () => string; isOptional: () => boolean }) => ({
      name: p.getName(),
      type: null, // 간략화
      isOptional: p.isOptional(),
    }));
  } catch {
    return [{ name: 'props', type: typeText, isOptional: false }];
  }
}

/**
 * React Hook 사용 추출
 */
function extractHooks(code: string): string[] {
  const hookPattern = /use[A-Z][a-zA-Z]*/g;
  const matches = code.match(hookPattern) || [];
  return [...new Set(matches)];
}

/**
 * 파싱 결과 콘솔 출력
 */
export function printParseResult(result: ParseResult): void {
  console.log('\n⚙️  Parse Result');
  console.log('─'.repeat(40));
  
  console.log(`\n   Functions: ${result.functions.length}`);
  const exportedFns = result.functions.filter(f => f.isExported);
  console.log(`     - Exported: ${exportedFns.length}`);
  if (exportedFns.length > 0 && exportedFns.length <= 20) {
    for (const fn of exportedFns.slice(0, 10)) {
      console.log(`       • ${fn.name} (${fn.filePath}:${fn.startLine})`);
    }
    if (exportedFns.length > 10) {
      console.log(`       ... and ${exportedFns.length - 10} more`);
    }
  }
  
  console.log(`\n   API Routes: ${result.routes.length}`);
  for (const route of result.routes.slice(0, 10)) {
    console.log(`     • ${route.method.padEnd(6)} ${route.path}`);
  }
  if (result.routes.length > 10) {
    console.log(`     ... and ${result.routes.length - 10} more`);
  }
  
  console.log(`\n   Components: ${result.components.length}`);
  for (const comp of result.components.slice(0, 10)) {
    const hooks = comp.hooks.length > 0 ? ` [${comp.hooks.join(', ')}]` : '';
    console.log(`     • ${comp.name}${hooks} (${comp.filePath})`);
  }
  if (result.components.length > 10) {
    console.log(`     ... and ${result.components.length - 10} more`);
  }
  
  console.log(`\n   Classes: ${result.classes.length}`);
  for (const cls of result.classes.slice(0, 5)) {
    console.log(`     • ${cls.name} (${cls.filePath})`);
  }
  
  if (result.errors.length > 0) {
    console.log(`\n   ⚠️  Errors: ${result.errors.length}`);
    for (const err of result.errors.slice(0, 5)) {
      console.log(`     • ${err.filePath}: ${err.message}`);
    }
  }
}
