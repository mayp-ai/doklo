// ============================================
// Store Parser: 상태 관리 구조 추출
// ============================================

import { Project, SourceFile, Node, SyntaxKind } from 'ts-morph';
import path from 'path';
import type { ParserDiagnostic, ScanResult } from './legacy-types.js';

/** Store 정보 */
export interface StoreInfo {
  type: 'zustand' | 'redux' | 'jotai' | 'recoil' | 'context' | 'unknown';
  filePath: string;
  name: string;
  
  // 상태 구조
  state: StateField[];
  
  // 액션/메서드
  actions: ActionInfo[];
  
  // 셀렉터/훅
  selectors: SelectorInfo[];
  
  // 미들웨어 (persist, devtools 등)
  middleware: string[];
}

export interface StateField {
  name: string;
  type: string | null;
  defaultValue: string | null;
}

export interface ActionInfo {
  name: string;
  params: string[];
  isAsync: boolean;
  description: string | null;
}

export interface SelectorInfo {
  name: string;
  returnType: string | null;
  dependencies: string[];  // 사용하는 state 필드들
}

/** 전체 Store 분석 결과 */
export interface StoreAnalysis {
  stores: StoreInfo[];
  contexts: ContextInfo[];
  diagnostics: ParserDiagnostic[];
  processedFiles: string[];
}

export interface ContextInfo {
  name: string;
  filePath: string;
  providerName: string;
  hookName: string | null;
  valueType: string | null;
}

/**
 * 프로젝트 내 상태 관리 구조 추출
 */
export function parseStores(scanResult: ScanResult): StoreAnalysis {
  const project = new Project({
    compilerOptions: {
      allowJs: true,
      jsx: 2,
    },
    skipAddingFilesFromTsConfig: true,
  });

  // store 관련 파일들 추가
  const storeFiles = scanResult.files.filter(f => 
    f.includes('store') || 
    f.includes('Store') ||
    f.includes('slice') ||
    f.includes('atom') ||
    f.includes('context') ||
    f.includes('provider')
  );

  const stores: StoreInfo[] = [];
  const contexts: ContextInfo[] = [];
  const diagnostics: ParserDiagnostic[] = [];

  for (const file of storeFiles) {
    const fullPath = path.join(scanResult.rootDir, file);
    try {
      project.addSourceFileAtPath(fullPath);
    } catch (error) {
      diagnostics.push({
        filePath: file,
        stage: 'state',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  for (const sourceFile of project.getSourceFiles()) {
    const relativePath = path.relative(scanResult.rootDir, sourceFile.getFilePath());
    try {
      const content = sourceFile.getFullText();

      // Zustand 감지
      if (content.includes('create(') && content.includes('zustand')) {
        stores.push(...parseZustandStore(sourceFile, relativePath));
      }

      // Redux Toolkit 감지
      if (content.includes('createSlice') || content.includes('@reduxjs/toolkit')) {
        stores.push(...parseReduxSlice(sourceFile, relativePath));
      }

      // Jotai 감지
      if (content.includes('atom(') && content.includes('jotai')) {
        stores.push(...parseJotaiAtoms(sourceFile, relativePath));
      }

      // React Context 감지
      if (content.includes('createContext')) {
        contexts.push(...parseReactContext(sourceFile, relativePath));
      }
    } catch (error) {
      diagnostics.push({
        filePath: relativePath,
        stage: 'state',
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return { stores, contexts, diagnostics, processedFiles: storeFiles };
}

/**
 * Zustand 스토어 파싱
 */
function parseZustandStore(sourceFile: SourceFile, filePath: string): StoreInfo[] {
  const stores: StoreInfo[] = [];
  const content = sourceFile.getFullText();

  // create() 호출 찾기
  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    const callText = call.getExpression().getText();
    
    // create 또는 create<...> 패턴
    if (!callText.includes('create')) continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const firstArg = args[0];
    
    // 변수명 찾기 (export const useXxxStore = create(...))
    const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const storeName = varDecl?.getName() || 'unknownStore';

    const state: StateField[] = [];
    const actions: ActionInfo[] = [];
    const middleware: string[] = [];

    // 미들웨어 감지
    if (content.includes('persist')) middleware.push('persist');
    if (content.includes('devtools')) middleware.push('devtools');
    if (content.includes('immer')) middleware.push('immer');
    if (content.includes('subscribeWithSelector')) middleware.push('subscribeWithSelector');

    // 상태와 액션 추출 (arrow function 또는 function 내부)
    if (Node.isArrowFunction(firstArg) || Node.isFunctionExpression(firstArg)) {
      const params = firstArg.getParameters();
      const body = firstArg.getBody();

      if (body && Node.isBlock(body)) {
        // return 문 찾기
        const returnStatement = body.getFirstDescendantByKind(SyntaxKind.ReturnStatement);
        if (returnStatement) {
          const returnExpr = returnStatement.getExpression();
          if (returnExpr && Node.isObjectLiteralExpression(returnExpr)) {
            parseZustandObject(returnExpr, state, actions);
          }
        }
      } else if (body && Node.isObjectLiteralExpression(body)) {
        // (set) => ({ ... }) 형태
        parseZustandObject(body, state, actions);
      } else if (body && Node.isParenthesizedExpression(body)) {
        const inner = body.getExpression();
        if (Node.isObjectLiteralExpression(inner)) {
          parseZustandObject(inner, state, actions);
        }
      }
    }

    // 커스텀 훅 (셀렉터) 찾기
    const selectors = findZustandSelectors(sourceFile, storeName);

    stores.push({
      type: 'zustand',
      filePath,
      name: storeName,
      state,
      actions,
      selectors,
      middleware,
    });
  }

  return stores;
}

/**
 * Zustand 객체 리터럴 파싱
 */
function parseZustandObject(
  obj: Node,
  state: StateField[],
  actions: ActionInfo[]
): void {
  if (!Node.isObjectLiteralExpression(obj)) return;

  for (const prop of obj.getProperties()) {
    if (!Node.isPropertyAssignment(prop) && !Node.isMethodDeclaration(prop)) continue;

    const name = prop.getName?.() || (Node.isPropertyAssignment(prop) ? prop.getName() : null);
    if (!name) continue;

    if (Node.isPropertyAssignment(prop)) {
      const initializer = prop.getInitializer();
      
      if (initializer && (Node.isArrowFunction(initializer) || Node.isFunctionExpression(initializer))) {
        // 함수 = 액션
        actions.push({
          name,
          params: initializer.getParameters().map(p => p.getName()),
          isAsync: initializer.isAsync(),
          description: null,
        });
      } else {
        // 값 = 상태
        state.push({
          name,
          type: initializer?.getType()?.getText() || null,
          defaultValue: initializer?.getText()?.slice(0, 50) || null,
        });
      }
    } else if (Node.isMethodDeclaration(prop)) {
      // 메서드 = 액션
      actions.push({
        name,
        params: prop.getParameters().map(p => p.getName()),
        isAsync: prop.isAsync(),
        description: null,
      });
    }
  }
}

/**
 * Zustand 커스텀 셀렉터 훅 찾기
 */
function findZustandSelectors(sourceFile: SourceFile, storeName: string): SelectorInfo[] {
  const selectors: SelectorInfo[] = [];

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const name = varDecl.getName();
    
    // use로 시작하고 스토어를 참조하는 함수
    if (!name.startsWith('use')) continue;

    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const text = initializer.getText();
    
    // storeName을 호출하는 패턴: useXxxStore(state => state.xxx)
    if (text.includes(storeName)) {
      // state에서 어떤 필드를 가져오는지 추출
      const selectorMatch = text.match(/state\s*=>\s*state\.(\w+)/);
      const dependencies = selectorMatch ? [selectorMatch[1]] : [];

      selectors.push({
        name,
        returnType: varDecl.getType()?.getText() || null,
        dependencies,
      });
    }
  }

  return selectors;
}

/**
 * Redux Toolkit Slice 파싱
 */
function parseReduxSlice(sourceFile: SourceFile, filePath: string): StoreInfo[] {
  const stores: StoreInfo[] = [];

  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    if (call.getExpression().getText() !== 'createSlice') continue;

    const args = call.getArguments();
    if (args.length === 0) continue;

    const config = args[0];
    if (!Node.isObjectLiteralExpression(config)) continue;

    let sliceName = 'unknownSlice';
    const state: StateField[] = [];
    const actions: ActionInfo[] = [];

    for (const prop of config.getProperties()) {
      if (!Node.isPropertyAssignment(prop)) continue;

      const propName = prop.getName();
      const initializer = prop.getInitializer();

      if (propName === 'name' && initializer) {
        sliceName = initializer.getText().replace(/['"]/g, '');
      }

      if (propName === 'initialState' && initializer && Node.isObjectLiteralExpression(initializer)) {
        for (const stateProp of initializer.getProperties()) {
          if (Node.isPropertyAssignment(stateProp)) {
            const val = stateProp.getInitializer();
            state.push({
              name: stateProp.getName(),
              type: val?.getType()?.getText() || null,
              defaultValue: val?.getText()?.slice(0, 50) || null,
            });
          }
        }
      }

      if (propName === 'reducers' && initializer && Node.isObjectLiteralExpression(initializer)) {
        for (const reducerProp of initializer.getProperties()) {
          if (Node.isPropertyAssignment(reducerProp) || Node.isMethodDeclaration(reducerProp)) {
            const reducerName = reducerProp.getName?.() || 'unknown';
            actions.push({
              name: reducerName,
              params: ['state', 'action'],
              isAsync: false,
              description: null,
            });
          }
        }
      }
    }

    stores.push({
      type: 'redux',
      filePath,
      name: sliceName,
      state,
      actions,
      selectors: [],
      middleware: [],
    });
  }

  return stores;
}

/**
 * Jotai Atom 파싱
 */
function parseJotaiAtoms(sourceFile: SourceFile, filePath: string): StoreInfo[] {
  const state: StateField[] = [];
  const actions: ActionInfo[] = [];

  for (const varDecl of sourceFile.getVariableDeclarations()) {
    const initializer = varDecl.getInitializer();
    if (!initializer) continue;

    const text = initializer.getText();
    const name = varDecl.getName();

    // atom() 호출
    if (text.startsWith('atom(')) {
      state.push({
        name,
        type: varDecl.getType()?.getText() || null,
        defaultValue: text.slice(0, 50),
      });
    }

    // atomWithStorage, atomWithReset 등
    if (text.includes('atomWith')) {
      state.push({
        name,
        type: varDecl.getType()?.getText() || null,
        defaultValue: text.slice(0, 50),
      });
    }
  }

  if (state.length > 0) {
    return [{
      type: 'jotai',
      filePath,
      name: path.basename(filePath, path.extname(filePath)),
      state,
      actions,
      selectors: [],
      middleware: [],
    }];
  }

  return [];
}

/**
 * React Context 파싱
 */
function parseReactContext(sourceFile: SourceFile, filePath: string): ContextInfo[] {
  const contexts: ContextInfo[] = [];

  const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);

  for (const call of callExpressions) {
    if (call.getExpression().getText() !== 'createContext') continue;

    // 변수명 찾기
    const varDecl = call.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
    const contextName = varDecl?.getName() || 'UnknownContext';

    // Provider 찾기
    let providerName = contextName + '.Provider';
    let hookName: string | null = null;

    // 같은 파일에서 useXxx 훅 찾기
    for (const fn of sourceFile.getFunctions()) {
      const fnName = fn.getName();
      if (fnName?.startsWith('use') && fn.getText().includes(contextName)) {
        hookName = fnName;
        break;
      }
    }

    // 화살표 함수에서도 찾기
    for (const vd of sourceFile.getVariableDeclarations()) {
      const vdName = vd.getName();
      if (vdName.startsWith('use') && vd.getText().includes(contextName)) {
        hookName = vdName;
        break;
      }
    }

    contexts.push({
      name: contextName,
      filePath,
      providerName,
      hookName,
      valueType: null,
    });
  }

  return contexts;
}

/**
 * Store 분석 결과 콘솔 출력
 */
export function printStoreAnalysis(analysis: StoreAnalysis): void {
  if (analysis.stores.length === 0 && analysis.contexts.length === 0) {
    console.log('\n💾 State Management');
    console.log('─'.repeat(40));
    console.log('   No stores or contexts found');
    return;
  }

  console.log('\n💾 State Management');
  console.log('─'.repeat(40));

  for (const store of analysis.stores) {
    console.log(`\n   📦 ${store.name} (${store.type})`);
    console.log(`      File: ${store.filePath}`);

    if (store.middleware.length > 0) {
      console.log(`      Middleware: ${store.middleware.join(', ')}`);
    }

    if (store.state.length > 0) {
      console.log(`      State (${store.state.length}):`);
      for (const s of store.state.slice(0, 10)) {
        const type = s.type ? `: ${s.type.slice(0, 30)}` : '';
        console.log(`        • ${s.name}${type}`);
      }
      if (store.state.length > 10) {
        console.log(`        ... and ${store.state.length - 10} more`);
      }
    }

    if (store.actions.length > 0) {
      console.log(`      Actions (${store.actions.length}):`);
      for (const a of store.actions.slice(0, 10)) {
        const async = a.isAsync ? 'async ' : '';
        const params = a.params.length > 0 ? `(${a.params.join(', ')})` : '()';
        console.log(`        • ${async}${a.name}${params}`);
      }
      if (store.actions.length > 10) {
        console.log(`        ... and ${store.actions.length - 10} more`);
      }
    }

    if (store.selectors.length > 0) {
      console.log(`      Selectors (${store.selectors.length}):`);
      for (const sel of store.selectors) {
        console.log(`        • ${sel.name}`);
      }
    }
  }

  if (analysis.contexts.length > 0) {
    console.log('\n   🔄 React Contexts:');
    for (const ctx of analysis.contexts) {
      const hook = ctx.hookName ? ` → ${ctx.hookName}()` : '';
      console.log(`      • ${ctx.name}${hook}`);
    }
  }
}
