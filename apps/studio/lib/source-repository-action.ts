'use server';

import { workspaceRoot } from './data';
import { readSourceRepository } from './source-repository';

export async function readSourceRepositoryAction() {
  return readSourceRepository(workspaceRoot());
}
