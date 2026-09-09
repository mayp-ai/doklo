import { describe, expect, it } from 'vitest';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseProject } from '../src/ast.js';
import { scanProject } from '../src/scanner.js';

async function parseTypeFixture(source: string) {
  const root = await mkdtemp(join(tmpdir(), 'doklo-ast-types-'));
  await writeFile(
    join(root, 'types.ts'),
    [
      'export interface Model<T> { value: T }',
      'export interface Schema<T, M = Model<T>, X = { model: M; nested: Model<M> }> {',
      '  model: M;',
      '  extra: X;',
      '}',
    ].join('\n'),
    'utf8',
  );
  await writeFile(join(root, 'source.ts'), source, 'utf8');
  return parseProject(await scanProject(root));
}

describe('parseProject type text', () => {
  it('preserves explicit function type annotations without expanding generic defaults', async () => {
    const result = await parseTypeFixture(`
      import type { Schema } from './types';
      export function register<T>(schema: Schema<T>): Schema<T> { return schema; }
    `);

    expect(result.functions.find(({ name }) => name === 'register')).toMatchObject({
      params: [{ name: 'schema', type: 'Schema<T>', isOptional: false }],
      returnType: 'Schema<T>',
    });
  });

  it('preserves explicit arrow-function type annotations without expanding generic defaults', async () => {
    const result = await parseTypeFixture(`
      import type { Schema } from './types';
      export const register = <T>(schema: Schema<T>): Schema<T> => schema;
    `);

    expect(result.functions.find(({ name }) => name === 'register')).toMatchObject({
      params: [{ name: 'schema', type: 'Schema<T>', isOptional: false }],
      returnType: 'Schema<T>',
    });
  });
});
