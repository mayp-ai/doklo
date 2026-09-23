import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { it, expect } from 'vitest';
import { extractGenericIR } from '../src/generic.js';
it('retains multi-layer service context beyond four files', async () => {
 const root = await mkdtemp(join(tmpdir(), 'doklo-context-'));
 try {
 const files = ['src/routes/list.py','src/routes/detail.py','src/services/notices.py','src/models/notice.py','src/repositories/notices.py','src/validation/id.py'];
 for (const file of files) {await mkdir(dirname(join(root,file)),{recursive:true}); await writeFile(join(root,file),'# source');}
 const ir = await extractGenericIR({rootDir:root});
 expect(ir.analysis_units).toHaveLength(1);
 expect(ir.analysis_units![0]!.files).toEqual([...files].sort());
 } finally {await rm(root,{recursive:true,force:true});}
});
