import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { copyStandaloneAssets } from './standalone-assets.mjs';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const studioDir = dirname(scriptDir); // scripts/ -> apps/studio

try {
  const { serverDir } = await copyStandaloneAssets({ studioDir });
  console.log(`[copy-standalone-assets] done. Standalone server: ${join(serverDir, 'server.js')}`);
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
