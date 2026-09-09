import { resolveTemplate } from '@doklo-beta/livedoc-engine';
import chalk from 'chalk';

export interface InfoOptions {
  name: string;
  root: string;
  json?: boolean;
}

export async function infoAction(opts: InfoOptions): Promise<Record<string, unknown>> {
  const r = await resolveTemplate(opts.name, { workspaceRoot: opts.root });
  const m = r.parsed.manifest;
  const contract = {
    name: m.name,
    version: m.version,
    source: r.source,
    path: r.path,
    active: true,
    stability: m.stability,
    audience: m.audience,
    purpose: m.purpose,
    job: m.job,
    required_input: m.required_input,
    variables: m.variables,
    default_format: m.default_format,
    output_formats: m.output_formats,
    outputs: m.outputs,
    scope: m.scope,
    output_path: m.output_path,
    supported_locales: m.supported_locales,
    default_locale: m.default_locale,
  };
  if (opts.json) return contract;
  process.stdout.write(chalk.bold(`${m.name} v${m.version}\n`));
  process.stdout.write(chalk.dim(`  source: ${r.source}\n`));
  process.stdout.write(chalk.dim(`  path:   ${r.path}\n`));
  process.stdout.write(`  stability:       ${m.stability}\n`);
  if (m.display_name) {
    for (const [lc, name] of Object.entries(m.display_name)) {
      process.stdout.write(`  ${lc}: ${name}\n`);
    }
  }
  process.stdout.write(`  scope:           ${m.scope}\n`);
  process.stdout.write(`  default_format:  ${m.default_format}\n`);
  process.stdout.write(`  output_formats:  ${m.output_formats.join(', ')}\n`);
  process.stdout.write('  outputs:\n');
  for (const format of m.output_formats) {
    const recipe = m.outputs[format]!;
    const entry = recipe.entry ? `, entry=${recipe.entry}` : '';
    process.stdout.write(
      `    ${format}: source=${recipe.source}${entry}, output_path=${recipe.output_path}\n`,
    );
  }
  process.stdout.write(`  output_path:     ${m.output_path}\n`);
  printLocalized('audience', m.audience);
  printLocalized('purpose', m.purpose);
  printLocalized('job', m.job);
  printLocalized('required input', m.required_input);
  process.stdout.write('  variables:\n');
  const variables = Object.entries(m.variables).sort(([a], [b]) => a.localeCompare(b));
  if (variables.length === 0) {
    process.stdout.write('    none\n');
  } else {
    for (const [name, definition] of variables) {
      const fallback = definition.default === undefined
        ? ''
        : `, default=${String(definition.default)}`;
      process.stdout.write(
        `    ${name}: ${definition.type}, ${definition.required ? 'required' : 'optional'}${fallback} — ${definition.description}\n`,
      );
    }
  }
  process.stdout.write(`  locales:         ${m.supported_locales.join(', ')} (default: ${m.default_locale})\n`);
  if (m.requires_hub_layers.length > 0) {
    process.stdout.write(`  hub layers:      ${m.requires_hub_layers.join(', ')}\n`);
  }
  if (m.selector) {
    process.stdout.write(`  selector:\n`);
    if (m.selector.include_tags) process.stdout.write(`    include_tags:     ${m.selector.include_tags.join(', ')}\n`);
    if (m.selector.include_services) process.stdout.write(`    include_services: ${m.selector.include_services.join(', ')}\n`);
    if (m.selector.include_statuses) process.stdout.write(`    include_statuses: ${m.selector.include_statuses.join(', ')}\n`);
    if (m.selector.explicit_ids) process.stdout.write(`    explicit_ids:     ${m.selector.explicit_ids.join(', ')}\n`);
    if (m.selector.exclude_tags) process.stdout.write(`    exclude_tags:     ${m.selector.exclude_tags.join(', ')}\n`);
  }
  return contract;
}

function printLocalized(label: string, values: Record<string, string>): void {
  process.stdout.write(`  ${label}:\n`);
  const entries = Object.entries(values).sort(([a], [b]) => a.localeCompare(b));
  if (entries.length === 0) {
    process.stdout.write('    not declared\n');
    return;
  }
  for (const [locale, text] of entries) {
    process.stdout.write(`    ${locale}: ${text}\n`);
  }
}
