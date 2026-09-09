import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  effectivePublicationUpdateMode,
  parsePublication,
  publicationDigest,
  serializePublication,
  type PublicationV1,
} from '../src/publication.js';

function publication(overrides: Partial<PublicationV1> = {}): PublicationV1 {
  return {
    schema_version: 1,
    name: 'public-help',
    display_name: 'Public Help',
    template: 'help-page',
    selection: {
      mode: 'filter',
      include_tags: ['public'],
      exclude_tags: ['internal'],
      statuses: ['active'],
    },
    selected_dok_ids: ['AUTH', 'SUPPORT'],
    format: 'html',
    locale: 'en',
    vars: { title: 'Help Center', show_rules: 'true' },
    output_dir: 'help-page/public-help',
    created_at: '2026-07-17T03:04:05.678Z',
    ...overrides,
  };
}

describe('PublicationV1', () => {
  it('parses the complete restart-reproducible definition', () => {
    const value = publication();

    expect(parsePublication(value)).toEqual(value);
  });

  it('keeps legacy bytes unchanged and treats a missing update mode as manual', () => {
    const legacy = publication();

    expect(effectivePublicationUpdateMode(legacy)).toBe('manual');
    expect(serializePublication(parsePublication(legacy))).not.toContain('update_mode');
  });

  it('round-trips review mode and rejects automatic mode', () => {
    const review = parsePublication({
      ...publication(),
      update_mode: 'review',
    });

    expect(review.update_mode).toBe('review');
    expect(effectivePublicationUpdateMode(review)).toBe('review');
    expect(() => parsePublication({
      ...publication(),
      update_mode: 'automatic',
    })).toThrow();
  });

  it('accepts a repo_path destination and round-trips it canonically', () => {
    const value = {
      ...publication(),
      destination: { kind: 'repo_path', path: 'docs/help/checkout' },
    };

    const parsed = parsePublication(value);
    expect(parsed.destination).toEqual({
      kind: 'repo_path',
      path: 'docs/help/checkout',
    });
    expect(serializePublication(parsed)).toContain('"destination"');
  });

  it.each([
    '/abs/path',
    '../escape',
    'docs/../escape',
    '.doklo/output/x',
    'docs\\help',
    'C:/help',
  ])('rejects unsafe destination path %s', (path) => {
    expect(() =>
      parsePublication({
        ...publication(),
        destination: { kind: 'repo_path', path },
      }),
    ).toThrow();
  });

  it.each([
    ['unknown top-level keys', { ...publication(), surprise: true }],
    ['unknown selection keys', publication({ selection: { mode: 'all', surprise: true } as never })],
    ['schema versions other than 1', { ...publication(), schema_version: 2 }],
    ['invalid names', publication({ name: '../help' })],
    ['duplicate explicit Dok IDs', publication({ selection: { mode: 'explicit', dok_ids: ['AUTH', 'AUTH'] } })],
    ['duplicate selected Dok IDs', publication({ selected_dok_ids: ['AUTH', 'AUTH'] })],
    ['an empty selected Dok snapshot', publication({ selected_dok_ids: [] })],
    ['duplicate filter tags', publication({ selection: { mode: 'filter', include_tags: ['public', 'public'] } })],
    ['a filter without criteria', publication({ selection: { mode: 'filter' } })],
    ['non-string variable values', publication({ vars: { show_rules: true } as never })],
    ['an unsupported format', publication({ format: 'docx' as never })],
    ['a non-ISO creation timestamp', publication({ created_at: 'July 17' })],
    ['an absolute POSIX output directory', publication({ output_dir: '/tmp/help' })],
    ['an absolute Windows output directory', publication({ output_dir: 'C:\\tmp\\help' })],
    ['a parent output segment', publication({ output_dir: 'help-page/../escape' })],
    ['the current directory alias', publication({ output_dir: '.' })],
    ['a leading current-directory segment', publication({ output_dir: './help-page' })],
    ['an embedded current-directory segment', publication({ output_dir: 'help-page/./public-help' })],
    ['an empty output-directory segment', publication({ output_dir: 'help-page//public-help' })],
    ['a trailing output-directory separator', publication({ output_dir: 'help-page/public-help/' })],
    ['a backslash output-directory separator', publication({ output_dir: 'help-page\\public-help' })],
    ['an output directory with surrounding whitespace', publication({ output_dir: ' help-page/public-help' })],
  ])('rejects %s', (_label, value) => {
    expect(() => parsePublication(value)).toThrow();
  });

  it('rejects duplicate values in every filter array', () => {
    expect(() => parsePublication(publication({
      selection: { mode: 'filter', exclude_tags: ['internal', 'internal'] },
    }))).toThrow();
    expect(() => parsePublication(publication({
      selection: { mode: 'filter', statuses: ['active', 'active'] },
    }))).toThrow();
  });

  it('serializes canonical bytes and digests exactly those bytes', () => {
    const value = publication({
      vars: { zed: 'last', alpha: 'first' },
      selection: { mode: 'all' },
    });

    const bytes = serializePublication(value);
    expect(bytes.endsWith('\n')).toBe(true);
    expect(bytes).toBe(
      '{"created_at":"2026-07-17T03:04:05.678Z","display_name":"Public Help",'
      + '"format":"html","locale":"en","name":"public-help","output_dir":"help-page/public-help",'
      + '"schema_version":1,"selected_dok_ids":["AUTH","SUPPORT"],'
      + '"selection":{"mode":"all"},"template":"help-page","vars":{"alpha":"first","zed":"last"}}\n',
    );
    expect(publicationDigest(value)).toBe(
      createHash('sha256').update(bytes, 'utf8').digest('hex'),
    );
    expect(parsePublication(JSON.parse(bytes) as unknown)).toEqual(value);
  });
});
