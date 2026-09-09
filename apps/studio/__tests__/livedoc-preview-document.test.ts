import { describe, expect, it } from 'vitest';
import { textPreviewDocument } from '../lib/livedoc-preview-document';

describe('textPreviewDocument', () => {
  it('uses the rendered document locale instead of a hard-coded language', () => {
    const document = textPreviewDocument(
      '# 도움말',
      'help.md',
      'ko',
    );

    expect(document).toContain('<html lang="ko">');
  });
});
