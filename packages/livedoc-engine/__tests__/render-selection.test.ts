import type { Dok } from '@doklo-beta/core';
import { describe, expect, it } from 'vitest';
import {
  resolvePublicationDokIds,
  selectPublicationDoks,
} from '../src/render-selection.js';
import type { PublicationV1 } from '../src/publication.js';

const doks = [
  dok('PAY', ['public', 'payments'], 'active'),
  dok('AUTH', ['public', 'auth'], 'active'),
  dok('INTERNAL', ['public', 'internal'], 'active'),
  dok('SUPPORT', ['public', 'support'], 'active'),
  dok('DRAFT', ['public'], 'draft'),
];

describe('Publication selection resolution', () => {
  it('resolves explicit IDs to canonical Dok order instead of caller order', () => {
    expect(resolvePublicationDokIds(doks, {
      mode: 'explicit',
      dok_ids: ['PAY', 'AUTH'],
    })).toEqual(['AUTH', 'PAY']);
  });

  it('requires every explicit ID to exist in the validated Hub', () => {
    expect(() => resolvePublicationDokIds(doks, {
      mode: 'explicit',
      dok_ids: ['AUTH', 'MISSING'],
    })).toThrow(/MISSING/);
  });

  it('applies every include tag, every exclusion, and the declared status set', () => {
    expect(resolvePublicationDokIds(doks, {
      mode: 'filter',
      include_tags: ['public'],
      exclude_tags: ['internal'],
      statuses: ['active'],
    })).toEqual(['AUTH', 'PAY', 'SUPPORT']);

    expect(resolvePublicationDokIds(doks, {
      mode: 'filter',
      include_tags: ['public', 'payments'],
      statuses: ['active', 'draft'],
    })).toEqual(['PAY']);
  });

  it('rejects a filter that resolves to zero Doks', () => {
    expect(() => resolvePublicationDokIds(doks, {
      mode: 'filter',
      include_tags: ['does-not-exist'],
    })).toThrow(/0 Doks/);
  });

  it('selects all Doks in deterministic order', () => {
    expect(resolvePublicationDokIds(doks, { mode: 'all' })).toEqual([
      'AUTH',
      'DRAFT',
      'INTERNAL',
      'PAY',
      'SUPPORT',
    ]);
  });
});

describe('Publication render snapshot', () => {
  it('creates one target per persisted Dok for per_dok templates', () => {
    const result = selectPublicationDoks(
      doks,
      publication({
        selection: { mode: 'all' },
        selected_dok_ids: ['PAY', 'AUTH'],
      }),
      'per_dok',
    );

    expect(result.selectedDokIds).toEqual(['AUTH', 'PAY']);
    expect(result.targets.map(({ doks: targetDoks }) => (
      targetDoks.map(({ dok_id }) => dok_id)
    ))).toEqual([['AUTH'], ['PAY']]);
  });

  it('passes one persisted Dok array to a workspace template without re-evaluating filters', () => {
    const result = selectPublicationDoks(
      doks,
      publication({
        selection: {
          mode: 'filter',
          include_tags: ['public'],
          exclude_tags: ['internal'],
          statuses: ['active'],
        },
        selected_dok_ids: ['AUTH', 'SUPPORT'],
      }),
      'workspace',
    );

    expect(result.targets).toHaveLength(1);
    expect(result.targets[0]!.doks.map(({ dok_id }) => dok_id)).toEqual([
      'AUTH',
      'SUPPORT',
    ]);
  });

  it('fails restart rendering when a persisted Dok no longer exists', () => {
    expect(() => selectPublicationDoks(
      doks,
      publication({ selected_dok_ids: ['AUTH', 'REMOVED'] }),
      'per_dok',
    )).toThrow(/REMOVED/);
  });
});

function dok(dokId: string, tags: string[], status: Dok['status']): Dok {
  return {
    dok_id: dokId,
    name: dokId,
    description: `${dokId} description`,
    status,
    tags,
    surfaces: [],
    _meta: { version: 1, history: [] },
  } as Dok;
}

function publication(overrides: Partial<PublicationV1> = {}): PublicationV1 {
  return {
    schema_version: 1,
    name: 'public-help',
    display_name: 'Public Help',
    template: 'help-page',
    selection: { mode: 'all' },
    selected_dok_ids: ['AUTH'],
    format: 'html',
    locale: 'en',
    vars: {},
    output_dir: 'help-page/public-help',
    created_at: '2026-07-17T03:04:05.678Z',
    ...overrides,
  };
}
