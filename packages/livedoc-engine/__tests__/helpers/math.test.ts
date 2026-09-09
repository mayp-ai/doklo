import { describe, expect, it } from 'vitest';
import Handlebars from 'handlebars';
import { registerMathHelpers } from '../../src/helpers/math.js';

function render(tpl: string, ctx: unknown = {}): string {
  const hb = Handlebars.create();
  registerMathHelpers(hb);
  return hb.compile(tpl)(ctx);
}

describe('math helpers', () => {
  it('add increments', () => {
    expect(render('{{add a 1}}', { a: 2 })).toBe('3');
  });

  it('sub subtracts', () => {
    expect(render('{{sub 5 2}}')).toBe('3');
  });

  it('eq returns true on equal values', () => {
    expect(render('{{#if (eq k "x")}}Y{{/if}}', { k: 'x' })).toBe('Y');
  });

  it('ne returns true on different values', () => {
    expect(render('{{#if (ne k "y")}}Y{{/if}}', { k: 'x' })).toBe('Y');
  });

  it('gt / lt compare numbers', () => {
    expect(render('{{#if (gt n 0)}}Y{{/if}}', { n: 5 })).toBe('Y');
    expect(render('{{#if (lt n 0)}}Y{{/if}}', { n: -1 })).toBe('Y');
  });

  it('gte / lte are inclusive', () => {
    expect(render('{{#if (gte n 5)}}Y{{/if}}', { n: 5 })).toBe('Y');
    expect(render('{{#if (lte n 5)}}Y{{/if}}', { n: 5 })).toBe('Y');
  });

  it('len works for arrays, strings, objects', () => {
    expect(render('{{len arr}}', { arr: [1, 2, 3] })).toBe('3');
    expect(render('{{len s}}', { s: 'abcd' })).toBe('4');
    expect(render('{{len o}}', { o: { a: 1, b: 2 } })).toBe('2');
    expect(render('{{len n}}', { n: undefined })).toBe('0');
  });

  it('join concatenates with separator', () => {
    expect(render('{{join arr ", "}}', { arr: ['a', 'b'] })).toBe('a, b');
    expect(render('{{join arr}}', { arr: ['a', 'b'] })).toBe('a, b');
    expect(render('{{join arr " | "}}', { arr: ['a', 'b'] })).toBe('a | b');
  });

  it('concat builds a dynamic translation key', () => {
    expect(render('{{concat "platform_" platform}}', { platform: 'desktop' })).toBe(
      'platform_desktop',
    );
  });

  it('default returns fallback for empty values', () => {
    expect(render('{{default v "—"}}', { v: '' })).toBe('—');
    expect(render('{{default v "—"}}', { v: null })).toBe('—');
    expect(render('{{default v "—"}}', { v: 'x' })).toBe('x');
  });
});
