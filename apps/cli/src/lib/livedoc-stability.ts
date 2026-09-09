import type { CommandDiagnostic } from './command-result.js';

export type VisibleTemplateStability = 'stable' | 'experimental' | 'unavailable';

export function stabilityDiagnostics(
  template: string,
  stability: VisibleTemplateStability,
  detail?: string,
): CommandDiagnostic[] {
  if (stability === 'stable') return [];
  if (stability === 'experimental') {
    return [{
      code: 'EXPERIMENTAL_TEMPLATE',
      message: `[experimental] Template '${template}' is not a stable release contract. Validate the output before use.`,
    }];
  }
  return [{
    code: 'PUBLICATION_TEMPLATE_UNAVAILABLE',
    message: `Template '${template}' is unavailable; its current stability could not be verified.${detail ? ` ${detail}` : ''}`,
  }];
}
