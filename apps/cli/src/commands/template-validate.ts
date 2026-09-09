import { parseTemplate, TemplateParseError } from '@doklo-beta/livedoc-engine';
import chalk from 'chalk';

export interface ValidateOptions {
  path: string;
}

export async function validateAction(opts: ValidateOptions): Promise<boolean> {
  try {
    const t = await parseTemplate(opts.path);
    process.stdout.write(
      chalk.green(`✓ ${t.manifest.name} v${t.manifest.version} — manifest valid\n`),
    );
    process.stdout.write(
      chalk.dim(`  ${t.manifest.output_formats.length} output_format(s), ${t.manifest.supported_locales.length} locale(s)\n`),
    );
    return true;
  } catch (err) {
    if (err instanceof TemplateParseError) {
      process.stderr.write(chalk.red(`✗ ${err.message}\n`));
    } else {
      process.stderr.write(chalk.red(`✗ ${(err as Error).message}\n`));
    }
    return false;
  }
}
