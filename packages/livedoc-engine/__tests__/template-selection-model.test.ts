import type { Dok } from '@doklo-beta/core';
import { describe, expect, it } from 'vitest';
import {
  buildTemplateSelectionModel,
  resolveTemplateSelection,
} from '../src/template-selection-model.js';
import {
  parseTemplateManifest,
  type TemplateManifest,
  type TemplateScope,
} from '../src/template-manifest.js';

describe('buildTemplateSelectionModel', () => {
  it('defaults per-Dok templates to explicit selection', () => {
    const model = buildTemplateSelectionModel({
      manifest: manifest('per_dok'),
      doks: doks(),
    });

    expect(model.default_kind).toBe('explicit');
    expect(model.eligible_dok_ids).toEqual(['ACTIVE']);
    expect(model.excluded).toContainEqual({
      dok_id: 'DRAFT',
      reason: 'unreviewed',
    });
  });

  it('defaults workspace templates to every eligible Dok', () => {
    const model = buildTemplateSelectionModel({
      manifest: manifest('workspace'),
      doks: doks(),
    });

    expect(model.default_kind).toBe('all_eligible');
    expect(model.allowed_kinds).toEqual([
      'all_eligible',
      'filter',
      'explicit',
    ]);
  });

  it('applies selected-Doks Template eligibility before user narrowing', () => {
    const selected = manifest('selected_doks', {
      selector: { include_tags: ['tutorial'] },
    });
    const model = buildTemplateSelectionModel({
      manifest: selected,
      doks: [
        dok('ACTIVE-TUTORIAL', 'active', ['tutorial']),
        dok('ACTIVE-OTHER', 'active', ['other']),
        dok('DRAFT-TUTORIAL', 'draft', ['tutorial']),
      ],
    });

    expect(model.default_kind).toBe('template');
    expect(model.eligible_dok_ids).toEqual(['ACTIVE-TUTORIAL']);
    expect(model.excluded).toEqual([
      { dok_id: 'ACTIVE-OTHER', reason: 'template_selector' },
      { dok_id: 'DRAFT-TUTORIAL', reason: 'unreviewed' },
    ]);
    expect(resolveTemplateSelection(model, {
      mode: 'explicit',
      dok_ids: ['ACTIVE-TUTORIAL'],
    })).toEqual(['ACTIVE-TUTORIAL']);
    expect(() => resolveTemplateSelection(model, {
      mode: 'explicit',
      dok_ids: ['ACTIVE-OTHER'],
    })).toThrow(/not eligible/i);
  });

  it('keeps non-active Doks eligible for experimental Templates', () => {
    const model = buildTemplateSelectionModel({
      manifest: manifest('workspace', { stability: 'experimental' }),
      doks: doks(),
    });

    expect(model.eligible_dok_ids).toEqual(['ACTIVE', 'DRAFT']);
    expect(model.excluded).toEqual([]);
  });

  it('rejects all-eligible selection when no Doks remain eligible', () => {
    const model = buildTemplateSelectionModel({
      manifest: manifest('workspace'),
      doks: [dok('DRAFT', 'draft')],
    });

    expect(() => resolveTemplateSelection(model, {
      mode: 'all_eligible',
    })).toThrow(/0 eligible Doks/i);
    expect(() => resolveTemplateSelection(model, {
      mode: 'all',
    })).toThrow(/0 eligible Doks/i);
  });
});

function manifest(
  scope: TemplateScope,
  overrides: Partial<TemplateManifest> = {},
): TemplateManifest {
  return parseTemplateManifest({
    name: 'test-template',
    version: '1.0.0',
    stability: 'stable',
    audience: { en: 'Product teams', ko: '제품 팀' },
    purpose: { en: 'Explain the product', ko: '제품 설명' },
    job: { en: 'Review product behavior', ko: '제품 동작 검토' },
    required_input: { en: 'Reviewed Doks', ko: '검토된 Dok' },
    output_formats: ['markdown'],
    scope,
    output_path: 'output.md',
    supported_locales: ['en', 'ko'],
    default_locale: 'en',
    ...overrides,
  });
}

function doks(): Dok[] {
  return [
    dok('DRAFT', 'draft'),
    dok('ACTIVE', 'active'),
  ];
}

function dok(
  dokId: string,
  status: Dok['status'],
  tags: string[] = [],
): Dok {
  return {
    dok_id: dokId,
    name: dokId,
    description: `${dokId} description`,
    status,
    tags,
    surfaces: [],
    _meta: { version: 1, history: [], logic_hash: `${dokId}-hash` },
  };
}
