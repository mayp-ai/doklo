import type { Dok } from '@doklo-beta/core';

/** Only the service-root brief: examples, archives and build guides are not authoritative intent. */
export function isProductIntentFile(file: string): boolean {
  return /^(?:PRODUCT|VISION)\.md$/i.test(file.replaceAll('\\', '/').replace(/^\.\//, ''));
}

export interface ContentReviewConcern {
  kind: 'product-scope-conflict' | 'implementation-detail' | 'insufficient-evidence';
  message: string;
  files: string[];
}

export interface ContentReview {
  assessed_by: 'model';
  reported: boolean;
  product_sources: string[];
  concerns: ContentReviewConcern[];
}

/** Model suggestions are review evidence, never customer copy or approval. */
export function recordContentReview(dok: Dok, files: readonly string[]): void {
  const allowed = new Set(files);
  const raw = dok['_review'];
  const notes = raw && typeof raw === 'object' && 'concerns' in raw
    ? (raw as { concerns: unknown }).concerns : undefined;
  const concerns: ContentReviewConcern[] = [];
  if (Array.isArray(notes)) {
    for (const note of notes.slice(0, 20)) {
      if (!note || typeof note !== 'object'
        || !['product-scope-conflict', 'implementation-detail', 'insufficient-evidence'].includes(note.kind)
        || typeof note.message !== 'string' || !note.message.trim()) continue;
      concerns.push({
        kind: note.kind, message: note.message.trim().slice(0, 2_000),
        files: Array.isArray(note.files)
          ? [...new Set((note.files as unknown[]).filter((file): file is string => typeof file === 'string' && allowed.has(file)))]
          : [],
      });
    }
  }
  delete dok['_review'];
  dok._meta.content_review = {
    assessed_by: 'model', reported: Array.isArray(notes), product_sources: files.filter(isProductIntentFile), concerns,
  } satisfies ContentReview;
}
