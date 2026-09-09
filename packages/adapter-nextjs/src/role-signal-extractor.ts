import type { RoleKind, RoleSignalIR } from '@doklo-beta/core';
import { Node, SyntaxKind, type SourceFile } from 'ts-morph';

export const ACCESS_VALUES = new Set([
  'admin',
  'manager',
  'owner',
  'editor',
  'staff',
  'guest',
  'moderator',
  'reviewer',
  'user',
]);
export const IDENTITY_NAME = /(user|account|member|profile|session|mentor|customer|seller|buyer|expert)/i;
export const ROLE_PROPERTY = /^(role|userRole|userType|userKind|programRole|type|kind)$/;
export const AI_MESSAGE_VALUES = new Set(['system', 'user', 'assistant', 'tool']);

const AUTH_ROLE_PROPERTY = /^(role|userRole|userType|userKind|programRole)$/;
const IDENTITY_WORDS = new Set([
  'user',
  'account',
  'member',
  'profile',
  'session',
  'auth',
  'token',
  'mentor',
  'customer',
  'seller',
  'buyer',
  'expert',
]);
const NON_IDENTITY_CONTEXT_WORDS = new Set([
  'preferences',
  'preference',
  'settings',
  'setting',
  'config',
  'options',
  'message',
  'messages',
  'chat',
  'prompt',
  'task',
  'field',
  'inbox',
  'notification',
  'event',
  'request',
  'response',
  'payload',
  'input',
  'dto',
]);
const AUTH_CHAIN_ROOTS = new Set(['auth', 'session', 'token', 'req', 'request', 'ctx', 'context']);
const DIRECT_AUTH_SUBJECTS = new Set([
  'auth',
  'session',
  'token',
  'user',
  'account',
  'member',
  'profile',
]);
const ROLE_DEFINITION_PREFIXES = new Set([
  'auth',
  'access',
  'program',
  ...IDENTITY_WORDS,
]);
const DOM_ROLE_VALUES = new Set([
  'alert',
  'button',
  'checkbox',
  'dialog',
  'grid',
  'link',
  'list',
  'listbox',
  'menu',
  'navigation',
  'option',
  'radio',
  'row',
  'tab',
  'tabpanel',
  'textbox',
]);
const ROLE_MAP_METADATA_KEYS = new Set(['label', 'value', 'name', 'title', 'description']);
const COMPARISON_OPERATORS = new Set([
  SyntaxKind.EqualsEqualsToken,
  SyntaxKind.EqualsEqualsEqualsToken,
  SyntaxKind.ExclamationEqualsToken,
  SyntaxKind.ExclamationEqualsEqualsToken,
]);

interface LiteralEvidence {
  value: string;
  line: number;
}

export function classifyRoleKind(value: string): RoleKind {
  return ACCESS_VALUES.has(value.trim().toLowerCase()) ? 'access' : 'actor_type';
}

export function extractRoleSignals(sourceFile: SourceFile, filePath: string): RoleSignalIR[] {
  const signals = [
    ...extractIdentityUnions(sourceFile, filePath),
    ...extractMongooseEnums(sourceFile, filePath),
    ...extractAuthRoleDefinitions(sourceFile, filePath),
    ...extractAuthComparisons(sourceFile, filePath),
  ];
  return dedupeSignals(signals).sort(compareSignals);
}

function extractIdentityUnions(sourceFile: SourceFile, filePath: string): RoleSignalIR[] {
  const signals: RoleSignalIR[] = [];

  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertySignature)) {
    if (!ROLE_PROPERTY.test(property.getName())) continue;

    const declaration = property.getAncestors().find(
      (ancestor) => Node.isInterfaceDeclaration(ancestor) || Node.isTypeAliasDeclaration(ancestor),
    );
    if (!declaration) continue;
    if (!Node.isInterfaceDeclaration(declaration) && !Node.isTypeAliasDeclaration(declaration)) {
      continue;
    }
    const ancestorsBeforeDeclaration = property
      .getAncestors()
      .slice(0, property.getAncestors().indexOf(declaration));
    if (ancestorsBeforeDeclaration.some(Node.isPropertySignature)) continue;
    if (!isIdentityName(declaration.getName())) continue;

    const values = property
      .getDescendantsOfKind(SyntaxKind.LiteralType)
      .map((literalType): LiteralEvidence | null => {
        const literal = literalType.getLiteral();
        if (!Node.isStringLiteral(literal)) return null;
        return { value: literal.getLiteralValue(), line: literal.getStartLineNumber() };
      })
      .filter((entry): entry is LiteralEvidence => entry !== null);

    if (isAiMessageSet(values)) continue;
    signals.push(...toSignals(values, filePath, 'explicit', 'identity-role-union'));
  }

  return signals;
}

function extractMongooseEnums(sourceFile: SourceFile, filePath: string): RoleSignalIR[] {
  const signals: RoleSignalIR[] = [];

  for (const property of sourceFile.getDescendantsOfKind(SyntaxKind.PropertyAssignment)) {
    if (!ROLE_PROPERTY.test(property.getName())) continue;
    if (!hasMongooseIdentityContext(property)) continue;

    const initializer = property.getInitializer();
    if (!initializer || !Node.isObjectLiteralExpression(initializer)) continue;

    const enumProperty = initializer.getProperty('enum');
    if (!enumProperty || !Node.isPropertyAssignment(enumProperty)) continue;
    const enumInitializer = enumProperty.getInitializerIfKind(SyntaxKind.ArrayLiteralExpression);
    if (!enumInitializer) continue;

    const values = enumInitializer
      .getElements()
      .map((element): LiteralEvidence | null => {
        if (!Node.isStringLiteral(element)) return null;
        return { value: element.getLiteralValue(), line: element.getStartLineNumber() };
      })
      .filter((entry): entry is LiteralEvidence => entry !== null);

    if (isAiMessageSet(values)) continue;
    signals.push(...toSignals(values, filePath, 'explicit', 'mongoose-role-enum'));
  }

  return signals;
}

function extractAuthRoleDefinitions(sourceFile: SourceFile, filePath: string): RoleSignalIR[] {
  const signals: RoleSignalIR[] = [];

  for (const declaration of sourceFile.getEnums()) {
    if (!isRoleDefinitionName(declaration.getName())) continue;
    const values = declaration.getMembers()
      .map((member): LiteralEvidence | null => {
        const initializer = member.getInitializer();
        if (!initializer || !Node.isStringLiteral(initializer)) return null;
        return { value: initializer.getLiteralValue(), line: initializer.getStartLineNumber() };
      })
      .filter((entry): entry is LiteralEvidence => entry !== null);
    if (isRejectedRoleSet(values)) continue;
    signals.push(...toSignals(values, filePath, 'explicit', 'auth-role-definition'));
  }

  for (const declaration of sourceFile.getVariableDeclarations()) {
    const initializer = declaration.getInitializer();
    if (!initializer) continue;

    const values = roleDefinitionValues(initializer);
    if (values.length === 0) continue;
    const name = declaration.getName();
    if (!isRoleDefinitionName(name) && !isMatchingScalarRoleConstant(name, values)) continue;
    if (isRejectedRoleSet(values)) continue;
    signals.push(...toSignals(values, filePath, 'explicit', 'auth-role-definition'));
  }

  return signals;
}

function extractAuthComparisons(sourceFile: SourceFile, filePath: string): RoleSignalIR[] {
  const signals: RoleSignalIR[] = [];

  for (const comparison of sourceFile.getDescendantsOfKind(SyntaxKind.BinaryExpression)) {
    if (!COMPARISON_OPERATORS.has(comparison.getOperatorToken().getKind())) continue;

    const left = comparison.getLeft();
    const right = comparison.getRight();
    const literal = Node.isStringLiteral(left)
      ? left
      : Node.isStringLiteral(right)
        ? right
        : null;
    const subject = literal === left ? right : literal === right ? left : null;

    if (!literal || !subject || !isAuthRoleExpression(subject)) continue;
    signals.push({
      value: literal.getLiteralValue(),
      kind: classifyRoleKind(literal.getLiteralValue()),
      source: 'middleware',
      file: filePath,
      line: literal.getStartLineNumber(),
      detector: 'auth-role-comparison',
    });
  }

  return signals;
}

function hasMongooseIdentityContext(property: Node): boolean {
  const schema = property.getFirstAncestorByKind(SyntaxKind.NewExpression);
  if (!schema) return false;

  if (!isMongooseSchemaExpression(schema)) return false;
  if (schema.getTypeArguments().some((typeArgument) => isIdentityName(typeArgument.getText()))) {
    return true;
  }

  const variable = schema.getFirstAncestorByKind(SyntaxKind.VariableDeclaration);
  if (variable) {
    const schemaName = variable.getName().replace(/schema$/i, '');
    if (isIdentityName(schemaName)) return true;
  }

  return property.getAncestors().some((ancestor) => {
    if (ancestor === schema) return false;
    if (!Node.isPropertyAssignment(ancestor)) return false;
    return isIdentityContainerName(ancestor.getName());
  });
}

function isMongooseSchemaExpression(schema: Node & { getExpression(): Node }): boolean {
  const expression = schema.getExpression();

  if (Node.isPropertyAccessExpression(expression)) {
    if (expression.getName() !== 'Schema') return false;
    const namespace = expression.getExpression().getText();
    if (namespace.toLowerCase() === 'mongoose') return true;
    return isMongooseDefaultImport(schema.getSourceFile(), namespace);
  }

  if (!Node.isIdentifier(expression)) return false;
  return isMongooseSchemaImport(schema.getSourceFile(), expression.getText());
}

function isMongooseDefaultImport(sourceFile: SourceFile, localName: string): boolean {
  return sourceFile.getImportDeclarations().some((declaration) =>
    declaration.getModuleSpecifierValue() === 'mongoose'
      && declaration.getDefaultImport()?.getText() === localName,
  );
}

function isMongooseSchemaImport(sourceFile: SourceFile, localName: string): boolean {
  return sourceFile.getImportDeclarations().some((declaration) => {
    if (declaration.getModuleSpecifierValue() !== 'mongoose') return false;
    return declaration.getNamedImports().some((namedImport) => {
      if (namedImport.getName() !== 'Schema') return false;
      return (namedImport.getAliasNode()?.getText() ?? namedImport.getName()) === localName;
    });
  });
}

function isAuthRoleExpression(node: Node): boolean {
  if (!Node.isPropertyAccessExpression(node)) return false;
  if (!AUTH_ROLE_PROPERTY.test(node.getName())) return false;

  const segments = propertyAccessSegments(node.getExpression());
  if (!segments || segments.length === 0) return false;
  const subject = segments.at(-1)!.toLowerCase();
  if (segments.length === 1) return DIRECT_AUTH_SUBJECTS.has(subject);

  const root = segments[0]!.toLowerCase();
  return AUTH_CHAIN_ROOTS.has(root) && DIRECT_AUTH_SUBJECTS.has(subject);
}

function propertyAccessSegments(node: Node): string[] | null {
  if (Node.isIdentifier(node)) return [node.getText()];
  if (!Node.isPropertyAccessExpression(node)) return null;
  const parent = propertyAccessSegments(node.getExpression());
  return parent ? [...parent, node.getName()] : null;
}

function isAiMessageSet(values: readonly LiteralEvidence[]): boolean {
  return values.length > 0
    && values.every(({ value }) => AI_MESSAGE_VALUES.has(value.trim().toLowerCase()));
}

function isRejectedRoleSet(values: readonly LiteralEvidence[]): boolean {
  return values.length === 0
    || isAiMessageSet(values)
    || values.every(({ value }) => DOM_ROLE_VALUES.has(value.trim().toLowerCase()));
}

function roleDefinitionValues(node: Node): LiteralEvidence[] {
  const value = unwrapAsExpression(node);
  if (Node.isStringLiteral(value)) {
    return [{ value: value.getLiteralValue(), line: value.getStartLineNumber() }];
  }
  if (Node.isArrayLiteralExpression(value)) {
    return value.getElements()
      .map((element): LiteralEvidence | null => {
        if (!Node.isStringLiteral(element)) return null;
        return { value: element.getLiteralValue(), line: element.getStartLineNumber() };
      })
      .filter((entry): entry is LiteralEvidence => entry !== null);
  }
  if (!Node.isObjectLiteralExpression(value)) return [];

  return value.getProperties()
    .map((property): LiteralEvidence | null => {
      if (!Node.isPropertyAssignment(property)) return null;
      const name = property.getName();
      if (!/^[a-z][a-z0-9_-]*$/i.test(name)) return null;
      if (ROLE_MAP_METADATA_KEYS.has(name.toLowerCase())) return null;
      return { value: name, line: property.getNameNode().getStartLineNumber() };
    })
    .filter((entry): entry is LiteralEvidence => entry !== null);
}

function unwrapAsExpression(node: Node): Node {
  let current = node;
  while (Node.isAsExpression(current)) current = current.getExpression();
  return current;
}

function isRoleDefinitionName(name: string): boolean {
  const normalized = name.replace(/[^a-z0-9]/gi, '').toLowerCase();
  if (normalized === 'role' || normalized === 'roles') return true;
  const match = normalized.match(/^(.+?)roles?$/);
  return match ? ROLE_DEFINITION_PREFIXES.has(match[1]!) : false;
}

function isMatchingScalarRoleConstant(name: string, values: readonly LiteralEvidence[]): boolean {
  if (values.length !== 1) return false;
  const match = name.match(/^ROLE_([A-Z][A-Z0-9_]*)$/);
  if (!match) return false;
  const valueName = values[0]!.value
    .trim()
    .replace(/[^a-z0-9]+/gi, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return match[1] === valueName;
}

function isIdentityName(name: string): boolean {
  const words = identifierWords(name);
  return words.some((word) => IDENTITY_WORDS.has(word))
    && !words.some((word) => NON_IDENTITY_CONTEXT_WORDS.has(word));
}

function isIdentityContainerName(name: string): boolean {
  const words = identifierWords(name);
  if (words.some((word) => NON_IDENTITY_CONTEXT_WORDS.has(word))) return false;
  return words.some((word) => IDENTITY_WORDS.has(singular(word)));
}

function identifierWords(name: string): string[] {
  return name
    .replace(/^I(?=[A-Z])/, '')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1 $2')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .split(/[^a-z0-9]+/i)
    .filter(Boolean)
    .map((word) => word.toLowerCase());
}

function singular(word: string): string {
  return word.endsWith('s') ? word.slice(0, -1) : word;
}

function toSignals(
  values: readonly LiteralEvidence[],
  file: string,
  source: RoleSignalIR['source'],
  detector: string,
): RoleSignalIR[] {
  return values.map(({ value, line }) => ({
    value,
    kind: classifyRoleKind(value),
    source,
    file,
    line,
    detector,
  }));
}

function dedupeSignals(signals: readonly RoleSignalIR[]): RoleSignalIR[] {
  const unique = new Map<string, RoleSignalIR>();
  for (const signal of signals) {
    const key = [
      signal.file,
      signal.line ?? 1,
      signal.detector,
      signal.source,
      signal.value,
      signal.kind,
    ].join('\u0000');
    if (!unique.has(key)) unique.set(key, signal);
  }
  return [...unique.values()];
}

function compareSignals(a: RoleSignalIR, b: RoleSignalIR): number {
  return compareText(a.file, b.file)
    || (a.line ?? 1) - (b.line ?? 1)
    || compareText(a.detector, b.detector)
    || compareText(a.source, b.source)
    || compareText(a.value, b.value)
    || compareText(a.kind, b.kind);
}

function compareText(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
