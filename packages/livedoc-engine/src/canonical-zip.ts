import JSZip from 'jszip';

/** Earliest conventional DOS ZIP timestamp, expressed in local fields. */
const CANONICAL_ZIP_DATE = new Date(1980, 0, 1, 0, 0, 0, 0);

/**
 * Office containers are ZIP files, and their libraries otherwise stamp every
 * entry with wall-clock time. Re-emitting the loaded archive after replacing
 * only those dates preserves entry order/content/compression while making the
 * bytes reproducible for identical document inputs.
 */
export async function canonicalizeZipBytes(
  bytes: Uint8Array,
  documentTimestamp = '1970-01-01T00:00:00.000Z',
): Promise<Buffer> {
  const zip = await JSZip.loadAsync(bytes);
  const core = zip.file('docProps/core.xml');
  if (core) {
    const xml = await core.async('string');
    zip.file(
      'docProps/core.xml',
      xml
        .replace(
          /(<dcterms:created\b[^>]*>)[^<]*(<\/dcterms:created>)/u,
          `$1${documentTimestamp}$2`,
        )
        .replace(
          /(<dcterms:modified\b[^>]*>)[^<]*(<\/dcterms:modified>)/u,
          `$1${documentTimestamp}$2`,
        ),
    );
  }
  for (const entry of Object.values(zip.files)) {
    entry.date = CANONICAL_ZIP_DATE;
  }
  return Buffer.from(await zip.generateAsync({ type: 'nodebuffer', platform: 'DOS' }));
}
