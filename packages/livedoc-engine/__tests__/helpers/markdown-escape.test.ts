import { describe, expect, it } from 'vitest';
import type { HelperRoot } from '../../src/helpers/index.js';
import { createEngine } from '../../src/handlebars-setup.js';

function render(template: string, value: string, source: 'markdown' | 'html'): string {
  const hb = createEngine();
  const root = { __outputSource: source } as unknown as HelperRoot;
  return hb.compile(template, { noEscape: true })({ value }, { data: { root } });
}

describe('Markdown escaping helpers', () => {
  it('neutralizes structural HTML and inline Markdown in prose', () => {
    expect(
      render(
        '{{md_text value}}',
        '<section>Injected *heading*</section> | extra',
        'markdown',
      ),
    ).toBe('&lt;section&gt;Injected \\*heading\\*&lt;/section&gt; | extra');
  });

  it('neutralizes leading blockquote and Setext heading markers', () => {
    expect(render('{{md_text value}}', '> quoted', 'markdown')).toBe(
      '&gt; quoted',
    );
    expect(render('{{md_text value}}', '===', 'markdown')).toBe('\\===');
  });

  it('neutralizes both CommonMark ordered-list delimiters', () => {
    expect(render('{{md_text value}}', '1. ordered', 'markdown')).toBe(
      '1\\. ordered',
    );
    expect(render('{{md_text value}}', '1) ordered', 'markdown')).toBe(
      '1\\) ordered',
    );
  });

  it('also protects table delimiters in cells', () => {
    expect(
      render(
        '{{md_cell value}}',
        '<section>Injected heading</section> | extra',
        'markdown',
      ),
    ).toBe('&lt;section&gt;Injected heading&lt;/section&gt; \\| extra');
  });

  it('uses a longer Markdown code fence when content contains backticks', () => {
    expect(
      render('{{md_code value}}', 'src/`quoted`.ts', 'markdown'),
    ).toBe('`` src/`quoted`.ts ``');
  });

  it('does not rewrite values for native HTML sources', () => {
    expect(
      render('{{md_text value}}', '<strong>Designed HTML</strong>', 'html'),
    ).toBe('<strong>Designed HTML</strong>');
  });
});
