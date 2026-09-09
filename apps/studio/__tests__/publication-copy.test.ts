import { describe, expect, it } from 'vitest';
import {
  ENGLISH_PUBLICATION_COPY,
  KOREAN_PUBLICATION_COPY,
  publicationCopy,
  publicationUiLocale,
} from '../lib/publication-copy';

describe('publication copy', () => {
  it('provides canonical Template labels and picker guidance', () => {
    expect(ENGLISH_PUBLICATION_COPY.template).toMatchObject({
      all: 'All',
      stable: 'Stable',
      experimental: 'Experimental',
      stableHelp: 'Validated for regular use. Output and compatibility changes follow the stable contract.',
      experimentalHelp: 'Available to try, but output or compatibility may change. Review before sharing.',
      workspacePreview: 'Workspace preview',
      examplePreview: 'Example preview',
      searchPlaceholder: 'Search templates',
      previewUnavailable: 'Preview unavailable',
    });
    expect(ENGLISH_PUBLICATION_COPY.selection).toMatchObject({
      allEligibleBody: 'Use every Dok that is eligible for this Template.',
      explicitBody: 'Choose the Doks to include in this document.',
    });
    expect(ENGLISH_PUBLICATION_COPY.actions).toMatchObject({
      render: 'Build latest document',
      export: 'Download ZIP',
    });
    expect(ENGLISH_PUBLICATION_COPY.update.manualBody).toBe(
      'Review changes, then build the latest document and publish when ready.',
    );
  });

  it('keeps direct English and Korean Template keys in parity', () => {
    expect(Object.keys(KOREAN_PUBLICATION_COPY.template).sort()).toEqual(
      Object.keys(ENGLISH_PUBLICATION_COPY.template).sort(),
    );
  });

  it('keeps complete nested English and Korean key parity', () => {
    expect(flattenKeys(ENGLISH_PUBLICATION_COPY)).toEqual(
      flattenKeys(KOREAN_PUBLICATION_COPY),
    );
  });

  it('uses English as fallback and Korean when explicitly configured', () => {
    expect(publicationUiLocale('ja')).toBe('en');
    expect(publicationUiLocale(undefined)).toBe('en');
    expect(publicationUiLocale('ko')).toBe('ko');
    expect(publicationCopy('ko').create.title).toBe('새 발행물');
  });
});

function flattenKeys(
  value: Record<string, unknown>,
  prefix = '',
): string[] {
  return Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    return child !== null && typeof child === 'object' && !Array.isArray(child)
      ? flattenKeys(child as Record<string, unknown>, path)
      : [path];
  }).sort();
}
