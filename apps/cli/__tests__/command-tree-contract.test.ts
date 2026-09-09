import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const here = dirname(fileURLToPath(import.meta.url));
const commandDir = join(here, '..', 'src', 'commands');

describe('command tree process ownership', () => {
  it('contains no command-level process.exit or process.exitCode mutation', async () => {
    const files = (await readdir(commandDir)).filter((file) => file.endsWith('.ts'));
    const offenders: string[] = [];

    for (const file of files) {
      const source = await readFile(join(commandDir, file), 'utf-8');
      if (/\bprocess\.exit(?:Code|\s*\()/.test(source)) offenders.push(file);
    }

    expect(offenders).toEqual([]);
  });
});
