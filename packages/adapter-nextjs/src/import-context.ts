import { Node, ts, type Project, type SourceFile } from 'ts-morph';
import { relative, resolve } from 'node:path';
import { createHash } from 'node:crypto';

interface SourceRange {
  start: number;
  end: number;
  /** One-based UTF-16 columns; endColumn is exclusive. Omitted means whole line. */
  startColumn?: number;
  endColumn?: number;
}

/** Inclusive original source line ranges; file graph remains the drift closure. */
export interface ImportSourceContext {
  file: string;
  /** SHA-256 of the complete source text encoded as UTF-8. */
  content_hash: string;
  ranges: SourceRange[];
  symbols: string[];
  kind: 'entry' | 'imported-symbol' | 'module';
}

/** Resolve imported exports and their lexical dependencies, independently per entry. */
export function buildImportContexts(
  project: Project, rootDir: string, entries: string[], allowed: ReadonlySet<string>, maxDepth: number,
): Record<string, ImportSourceContext[]> {
  const result: Record<string, ImportSourceContext[]> = {};
  for (const entry of entries) {
    const contexts = new Map<string, ImportSourceContext>();
    const originalText = new Map<string, string>();
    const selected = new Set<Node>();
    const requested = new Set<string>();
    const pathOf = (source: SourceFile) => relative(rootDir, source.getFilePath());
    const contextFor = (source: SourceFile): ImportSourceContext => {
      const file = pathOf(source);
      let item = contexts.get(file);
      if (!item) {
        // ts-morph strips a UTF-8 BOM; identity and columns must refer to the
        // original approved text, not its normalized compiler representation.
        const text = project.getFileSystem().readFileSync(source.getFilePath(), 'utf8');
        if (text.replace(/^\uFEFF/, '') !== source.getFullText()) throw new Error(`SOURCE_CONTEXT_SOURCE_CHANGED: ${file}`);
        originalText.set(file, text);
        item = { file, content_hash: createHash('sha256').update(text, 'utf8').digest('hex'), ranges: [], symbols: [], kind: file === entry ? 'entry' : 'imported-symbol' };
        contexts.set(file, item);
      }
      return item;
    };
    const topLevel = (node: Node): Node => {
      let current = node;
      while (current.getParent() && !Node.isSourceFile(current.getParent()!)) {
        if (Node.isVariableDeclaration(current)) {
          const statement = current.getFirstAncestorByKind(ts.SyntaxKind.VariableStatement);
          if (statement && Node.isSourceFile(statement.getParent()) && statement.getDeclarations().length > 1) return current;
        }
        current = current.getParent()!;
      }
      return current;
    };
    const followBinding = (node: Node, depth: number): void => {
      const decl = Node.isImportDeclaration(node) ? node : node.getFirstAncestorByKind(ts.SyntaxKind.ImportDeclaration);
      if (!decl) return;
      const target = decl.getModuleSpecifierSourceFile();
      if (!target || !allowed.has(pathOf(target))) return;
      if (Node.isImportSpecifier(node)) request(target, [node.getName()], depth + 1, !decl.isTypeOnly() && !node.isTypeOnly());
      else if (Node.isImportClause(node) && node.getDefaultImport()) request(target, ['default'], depth + 1, !decl.isTypeOnly());
      else request(target, null, depth + 1);
    };
    const select = (node: Node, depth: number): void => {
      const source = node.getSourceFile();
      if (depth > maxDepth || !allowed.has(pathOf(source))) return;
      const statement = topLevel(node);
      if (selected.has(statement)) return;
      selected.add(statement);
      const start = source.getLineAndColumnAtPos(statement.getStart());
      const end = source.getLineAndColumnAtPos(statement.getEnd());
      const context = contextFor(source);
      const text = originalText.get(pathOf(source))!;
      if (text.startsWith('\uFEFF')) {
        if (start.line === 1) start.column += 1;
        if (end.line === 1) end.column += 1;
      }
      const lines = text.split('\n');
      context.ranges.push({ start: start.line, end: end.line,
        ...(lines[start.line - 1]!.slice(0, start.column - 1).trim() ? { startColumn: start.column } : {}),
        ...(lines[end.line - 1]!.slice(end.column - 1).trim() ? { endColumn: end.column } : {}),
      });
      // Bindings are followed by the reference that selected them, not every
      // sibling import: importing one helper must not pull another screen in.
      if (Node.isImportDeclaration(statement) || Node.isExportDeclaration(statement)) return;
      for (const identifier of statement.getDescendantsOfKind(ts.SyntaxKind.Identifier)) {
        for (const declaration of identifier.getSymbol()?.getDeclarations() ?? []) {
          if (declaration.getSourceFile() !== source) continue;
          const owner = topLevel(declaration);
          if (Node.isImportDeclaration(owner)) {
            select(owner, depth);
            followBinding(declaration, depth);
          } else select(owner, depth);
        }
      }
    };
    const request = (source: SourceFile, names: string[] | null, depth: number, initialize = true): void => {
      const file = pathOf(source);
      if (depth > maxDepth || !allowed.has(file)) return;
      const item = contextFor(source);
      // ES modules execute once even when a single export is consumed. Retain
      // module initialization independently of the requested declarations.
      const initializationKey = `${file}\0initialize`;
      if (initialize && !requested.has(initializationKey)) {
        requested.add(initializationKey);
        for (const statement of source.getStatements()) {
          if (Node.isImportDeclaration(statement)) {
            const onlyTypes = statement.isTypeOnly() || (!statement.getDefaultImport() && !statement.getNamespaceImport() &&
              statement.getNamedImports().length > 0 && statement.getNamedImports().every(spec => spec.isTypeOnly()));
            if (onlyTypes) continue;
            const target = statement.getModuleSpecifierSourceFile();
            if (target && allowed.has(pathOf(target))) {
              // An import's binding line alone asserts no screen behavior.
              // Include it only when the imported module has initialization evidence.
              request(target, [], depth + 1);
              if ((contexts.get(pathOf(target))?.ranges.length ?? 0) > 0) select(statement, depth);
            }
          } else if (Node.isExportDeclaration(statement)) {
            const target = statement.getModuleSpecifierSourceFile();
            if (target && !statement.isTypeOnly()) request(target, [], depth + 1);
          } else if (Node.isExportAssignment(statement)) {
            if (mayExecute(statement.getExpression())) select(statement, depth);
          } else if (Node.isExpressionStatement(statement)) {
            if (mayExecute(statement.getExpression())) select(statement, depth);
          } else if (Node.isVariableStatement(statement)) {
            for (const declaration of statement.getDeclarations()) {
              const initializer = declaration.getInitializer();
              if (initializer && mayExecute(initializer)) select(declaration, depth);
            }
          } else if (!Node.isFunctionDeclaration(statement) && !Node.isInterfaceDeclaration(statement) &&
              !Node.isTypeAliasDeclaration(statement) && !Node.isClassDeclaration(statement) && !Node.isEmptyStatement(statement)) {
            select(statement, depth);
          } else if (Node.isClassDeclaration(statement) &&
              ((statement.getExtends() && mayExecute(statement.getExtends()!.getExpression())) || statement.getDecorators().length || statement.getMembers().some(member =>
                Node.isClassStaticBlockDeclaration(member) || (Node.isPropertyDeclaration(member) && member.isStatic() && member.getInitializer())))) {
            select(statement, depth);
          }
        }
      }
      if (names === null) {
        const key = `${file}\0*`;
        if (requested.has(key)) return;
        requested.add(key);
        if (file !== entry) item.kind = 'module';
        for (const statement of source.getStatements()) select(statement, depth);
        for (const decl of source.getImportDeclarations()) {
          const target = decl.getModuleSpecifierSourceFile();
          if (!target) continue;
          const names = decl.getNamedImports().map(spec => spec.getName());
          if (decl.getDefaultImport()) names.push('default');
          request(target, decl.getNamespaceImport() ? null : names, depth + 1, !decl.isTypeOnly() &&
            (Boolean(decl.getDefaultImport() || decl.getNamespaceImport()) || decl.getNamedImports().length === 0 || decl.getNamedImports().some(spec => !spec.isTypeOnly())));
        }
        for (const decl of source.getExportDeclarations()) {
          const target = decl.getModuleSpecifierSourceFile();
          if (target) request(target, decl.getNamedExports().length ? decl.getNamedExports().map(spec => spec.getName()) : null, depth + 1, !decl.isTypeOnly());
        }
      } else {
        for (const name of names) {
          const key = `${file}\0${name}`;
          if (requested.has(key)) continue;
          requested.add(key);
          if (!item.symbols.includes(name)) item.symbols.push(name);
          const declarations = source.getExportedDeclarations().get(name) ?? [];
          for (const declaration of declarations) {
            if (declaration.getSourceFile() !== source) request(declaration.getSourceFile(), [], depth + 1, initialize);
            select(declaration, depth);
          }
          // Retain the barrel provenance without including unrelated exports.
          for (const decl of source.getExportDeclarations()) {
            if (decl.getNamedExports().some(spec => (spec.getAliasNode()?.getText() ?? spec.getName()) === name) ||
                (decl.isNamespaceExport() && declarations.some(node => node.getSourceFile() !== source))) select(decl, depth);
          }
        }
      }
    };
    const source = project.getSourceFile(resolve(rootDir, entry));
    if (source) request(source, null, 0);
    result[entry] = [...contexts.values()].filter(item => item.ranges.length > 0).map(item => ({ ...item, symbols: item.symbols.sort(), ranges: mergeRanges(item.ranges) }));
  }
  return result;
}

function mergeRanges(ranges: SourceRange[]): SourceRange[] {
  const merged: SourceRange[] = [];
  for (const range of ranges.sort((a, b) => a.start - b.start || (a.startColumn ?? 1) - (b.startColumn ?? 1))) {
    const last = merged.at(-1);
    const touches = last && (range.start < last.end ||
      (range.start === last.end && (range.startColumn ?? 1) <= (last.endColumn ?? Infinity)) ||
      (range.start === last.end + 1 && last.endColumn === undefined && range.startColumn === undefined));
    if (last && touches) {
      if (range.end > last.end || (range.end === last.end && (range.endColumn ?? Infinity) > (last.endColumn ?? Infinity))) {
        last.end = range.end;
        if (range.endColumn === undefined) delete last.endColumn;
        else last.endColumn = range.endColumn;
      }
    } else merged.push({ ...range });
  }
  return merged;
}

/** Detect potentially executing initializers without traversing deferred function bodies. */
function mayExecute(node: Node): boolean {
  if (Node.isArrowFunction(node) || Node.isFunctionExpression(node)) return false;
  if (Node.isMethodDeclaration(node) || Node.isGetAccessorDeclaration(node) || Node.isSetAccessorDeclaration(node)) {
    const name = node.getNameNode();
    return Node.isComputedPropertyName(name) && mayExecute(name.getExpression());
  }
  if (Node.isCallExpression(node) || Node.isNewExpression(node) || Node.isAwaitExpression(node) ||
      Node.isPropertyAccessExpression(node) || Node.isElementAccessExpression(node) ||
      Node.isTaggedTemplateExpression(node) || Node.isPostfixUnaryExpression(node) || Node.isSpreadElement(node) ||
      Node.isSpreadAssignment(node) || Node.isClassExpression(node)) return true;
  if (Node.isPrefixUnaryExpression(node) && [ts.SyntaxKind.PlusPlusToken, ts.SyntaxKind.MinusMinusToken].includes(node.getOperatorToken())) return true;
  if (Node.isBinaryExpression(node) && node.getOperatorToken().getKind() >= ts.SyntaxKind.FirstAssignment &&
      node.getOperatorToken().getKind() <= ts.SyntaxKind.LastAssignment) return true;
  return node.getChildren().some(mayExecute);
}
