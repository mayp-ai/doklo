import { createHash } from 'node:crypto';
import type { Dok } from '@doklo-beta/core';
import { describe, expect, it } from 'vitest';
import {
  projectPublicationStatus,
  type PublicationPublishRecord,
} from '../src/publication-status.js';
import {
  publicationDigest,
  type PublicationV1,
} from '../src/publication.js';
import {
  parseTemplateManifest,
  type TemplateManifest,
} from '../src/template-manifest.js';
import type { PublicationRenderEvidence } from '../src/render.js';

describe('projectPublicationStatus', () => {
  it('reports not rendered when official evidence is absent', () => {
    const status = projectPublicationStatus(input());

    expect(status.render_state).toBe('not_rendered');
    expect(status.publish_state).toBe('no_destination');
    expect(status.input_fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it('reports current only when definition, Template, membership, and hashes match', () => {
    const current = input();
    current.evidence = evidence(current.publication, current.manifest, current.doks);

    expect(projectPublicationStatus(current)).toMatchObject({
      render_state: 'current',
      freshness: 'proven',
      template_update_available: false,
    });
  });

  it('separates definition changes from Dok updates', () => {
    const current = input();
    const oldPublication = publication({ display_name: 'Old name' });
    current.evidence = evidence(oldPublication, current.manifest, current.doks);

    expect(projectPublicationStatus(current).render_state).toBe('definition_changed');
  });

  it('detects dynamic membership and proven content changes', () => {
    const membership = input({
      publication: publication({
        selection: { mode: 'filter', statuses: ['active'] },
        selected_dok_ids: ['AUTH'],
      }),
      doks: [dok('AUTH', 'hash-a'), dok('HELP', 'hash-help')],
    });
    membership.evidence = evidence(
      membership.publication,
      membership.manifest,
      [membership.doks[0]!],
    );
    expect(projectPublicationStatus(membership)).toMatchObject({
      render_state: 'update_available',
      reasons: expect.arrayContaining(['membership_changed']),
    });

    const content = input();
    content.evidence = evidence(
      content.publication,
      content.manifest,
      [dok('AUTH', 'old-hash')],
    );
    expect(projectPublicationStatus(content)).toMatchObject({
      render_state: 'update_available',
      reasons: expect.arrayContaining(['content_changed']),
    });
  });

  it('detects reviewed Dok prose edits even when logic_hash is unchanged', () => {
    const reviewed = input();
    reviewed.evidence = evidence(
      reviewed.publication,
      reviewed.manifest,
      reviewed.doks,
    );
    const before = projectPublicationStatus(reviewed);

    reviewed.doks[0] = {
      ...reviewed.doks[0]!,
      description: 'Human-edited customer-facing description',
    };
    const after = projectPublicationStatus(reviewed);

    expect(after).toMatchObject({
      render_state: 'update_available',
      reasons: expect.arrayContaining(['content_changed']),
    });
    expect(after.input_fingerprint).not.toBe(before.input_fingerprint);
  });

  it('changes the approval fingerprint when the prior evidence baseline changes', () => {
    const current = input();
    current.evidence = evidence(
      current.publication,
      current.manifest,
      current.doks,
    );
    const before = projectPublicationStatus(current).input_fingerprint;
    current.evidence = {
      ...current.evidence,
      dok_snapshots: current.evidence.dok_snapshots.map((snapshot) => ({
        ...snapshot,
        logic_hash: 'older-baseline',
      })),
    };

    expect(projectPublicationStatus(current).input_fingerprint).not.toBe(before);
  });

  it('does not claim content change when either logic hash is absent', () => {
    const current = input({ doks: [dok('AUTH')] });
    current.evidence = evidence(
      current.publication,
      current.manifest,
      [dok('AUTH', 'old-hash')],
    );
    delete current.evidence.dok_snapshots[0]!.content_sha256;

    expect(projectPublicationStatus(current)).toMatchObject({
      render_state: 'current',
      freshness: 'unknown',
      reasons: expect.arrayContaining(['freshness_unknown']),
    });
  });

  it('separates Template updates and blocks a missing selected Dok', () => {
    const templateChanged = input();
    templateChanged.evidence = evidence(
      templateChanged.publication,
      manifest('1.0.0'),
      templateChanged.doks,
    );
    templateChanged.manifest = manifest('2.0.0');
    expect(projectPublicationStatus(templateChanged)).toMatchObject({
      render_state: 'update_available',
      template_update_available: true,
      reasons: expect.arrayContaining(['template_changed']),
    });

    const missing = input({
      publication: publication({
        selection: { mode: 'explicit', dok_ids: ['AUTH'] },
        selected_dok_ids: ['AUTH'],
      }),
      doks: [],
    });
    expect(projectPublicationStatus(missing)).toMatchObject({
      render_state: 'blocked',
      reasons: ['missing_dok'],
    });
  });

  it('blocks a stable explicit Publication when its selected Dok is no longer active', () => {
    const current = input({
      publication: publication({
        selection: { mode: 'explicit', dok_ids: ['AUTH'] },
        selected_dok_ids: ['AUTH'],
      }),
      doks: [{
        ...dok('AUTH', 'hash-a'),
        status: 'planned',
      }],
    });
    current.evidence = evidence(
      current.publication,
      current.manifest,
      [dok('AUTH', 'hash-a')],
    );

    expect(projectPublicationStatus(current)).toMatchObject({
      render_state: 'blocked',
      freshness: 'unknown',
      reasons: expect.arrayContaining(['selection_empty']),
    });
  });

  it('blocks an all-eligible Publication when no Doks remain eligible', () => {
    const current = input({
      publication: publication({
        selection: { mode: 'all' },
        selected_dok_ids: ['AUTH'],
      }),
      doks: [{
        ...dok('AUTH', 'hash-a'),
        status: 'planned',
      }],
    });
    current.evidence = evidence(
      current.publication,
      current.manifest,
      [dok('AUTH', 'hash-a')],
    );

    expect(projectPublicationStatus(current)).toMatchObject({
      render_state: 'blocked',
      freshness: 'unknown',
      resolved_dok_ids: [],
      reasons: expect.arrayContaining(['selection_empty']),
    });
  });

  it('projects destination publishing from the official evidence and ledger', () => {
    const current = input({
      publication: publication({
        destination: { kind: 'repo_path', path: 'docs/help' },
      }),
    });
    current.evidence = evidence(current.publication, current.manifest, current.doks);

    expect(projectPublicationStatus(current).publish_state).toBe('not_published');

    current.publish_record = publishRecord('older-definition');
    expect(projectPublicationStatus(current).publish_state).toBe('publish_needed');

    current.publish_record = publishRecord(
      current.evidence.publication.definition_sha256,
    );
    expect(projectPublicationStatus(current).publish_state).toBe('published');

    current.publish_blocked = true;
    expect(projectPublicationStatus(current).publish_state).toBe('publish_blocked');
  });
});

function input(overrides: {
  publication?: PublicationV1;
  manifest?: TemplateManifest;
  doks?: Dok[];
} = {}): {
  publication: PublicationV1;
  definition_sha256: string;
  manifest: TemplateManifest;
  doks: Dok[];
  evidence?: PublicationRenderEvidence;
  publish_record?: PublicationPublishRecord;
  publish_blocked?: boolean;
} {
  const publicationValue = overrides.publication ?? publication();
  return {
    publication: publicationValue,
    definition_sha256: publicationDigest(publicationValue),
    manifest: overrides.manifest ?? manifest('1.0.0'),
    doks: overrides.doks ?? [dok('AUTH', 'hash-a')],
  };
}

function publication(overrides: Partial<PublicationV1> = {}): PublicationV1 {
  return {
    schema_version: 1,
    name: 'public-help',
    display_name: 'Public Help',
    template: 'help-page',
    selection: { mode: 'all' },
    selected_dok_ids: ['AUTH'],
    format: 'markdown',
    locale: 'en',
    vars: {},
    output_dir: 'help-page/public-help',
    created_at: '2026-07-17T03:04:05.678Z',
    ...overrides,
  };
}

function manifest(version: string): TemplateManifest {
  return parseTemplateManifest({
    name: 'help-page',
    version,
    stability: 'stable',
    audience: { en: 'Customers' },
    purpose: { en: 'Explain product behavior' },
    job: { en: 'Complete a task' },
    required_input: { en: 'Reviewed Doks' },
    output_formats: ['markdown'],
    scope: 'workspace',
    output_path: 'help.md',
    supported_locales: ['en'],
    default_locale: 'en',
  });
}

function dok(dokId: string, logicHash?: string): Dok {
  return {
    dok_id: dokId,
    name: dokId,
    description: `${dokId} description`,
    status: 'active',
    tags: [],
    surfaces: [],
    _meta: {
      version: 1,
      history: [],
      ...(logicHash ? { logic_hash: logicHash } : {}),
    },
  };
}

function evidence(
  publicationValue: PublicationV1,
  manifestValue: TemplateManifest,
  dokValues: Dok[],
): PublicationRenderEvidence {
  return {
    schema_version: 1,
    command: 'live-docs.publication.render',
    publication: {
      name: publicationValue.name,
      definition_path: `/workspace/.doklo/livedocs/publications/${publicationValue.name}.json`,
      definition_sha256: publicationDigest(publicationValue),
    },
    template: {
      name: manifestValue.name,
      version: manifestValue.version,
      stability: manifestValue.stability,
    },
    selected_dok_ids: dokValues.map((value) => value.dok_id),
    dok_snapshots: dokValues.map((value) => ({
      dok_id: value.dok_id,
      name: value.dok_id,
      status: value.status,
      content_sha256: dokContentSha256(value),
      ...(value._meta.logic_hash
        ? { logic_hash: value._meta.logic_hash }
        : {}),
    })),
    plan: {
      inputs: {
        template: {
          name: manifestValue.name,
          source: 'builtin',
          version: manifestValue.version,
        },
        locale: publicationValue.locale,
        format: publicationValue.format,
        dok_ids: dokValues.map((value) => value.dok_id),
        variables: {},
        source_paths: [],
      },
      outputs: [],
      warnings: [],
    },
    outputs: [],
    warnings: [],
    manifest_path: `/workspace/.doklo/output/${publicationValue.output_dir}/livedoc-manifest.json`,
  } as PublicationRenderEvidence;
}

function dokContentSha256(value: Dok): string {
  return createHash('sha256')
    .update(stableSerialize(value), 'utf8')
    .digest('hex');
}

function stableSerialize(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record).sort().map((key) => (
    `${JSON.stringify(key)}:${stableSerialize(record[key])}`
  )).join(',')}}`;
}

function publishRecord(definitionSha256: string): PublicationPublishRecord {
  return {
    schema_version: 1,
    publication: 'public-help',
    definition_sha256: definitionSha256,
  };
}
