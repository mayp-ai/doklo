import { execFileSync } from 'node:child_process';
import { rmSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { captureStudioSource, provenancePath, recordStandaloneProvenance } from './standalone-provenance.mjs';

const studioDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const root = resolve(studioDir, '../..');
try {
  // A failed rebuild must never leave an older provenance record reusable.
  rmSync(provenancePath(root), { force: true });
  const before = captureStudioSource(root);
  execFileSync('pnpm', ['exec', 'next', 'build'], { cwd: studioDir, stdio: 'inherit' });
  execFileSync(process.execPath, ['scripts/copy-standalone-assets.mjs'], { cwd: studioDir, stdio: 'inherit' });
  recordStandaloneProvenance(root, before);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
