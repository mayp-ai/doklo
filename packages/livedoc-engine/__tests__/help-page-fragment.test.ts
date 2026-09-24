import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import DOMPurify from 'isomorphic-dompurify';
import { afterEach, describe, expect, it } from 'vitest';
import { renderLivedoc } from '../src/render.js';
import { coerceTemplateVariables } from '../src/template-manifest.js';
import { parseTemplate } from '../src/template-parser.js';
import { helpPagePresentation } from '../src/help-page-presentation.js';

const here = dirname(fileURLToPath(import.meta.url));
const builtinRoot = join(here, '../templates');
const articleIds = ['CHAT', 'CHILD', 'CHILD-RECORD-DETAIL', 'NYAMNAYM', 'FAMILY-JOIN', 'SETTINGS', 'HOME'];
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });

async function workspace(status = 'active') {
  const root = await mkdtemp(join(tmpdir(), 'help-fragment-'));
  roots.push(root);
  await cp(join(here, 'fixtures/render-ws'), root, { recursive: true });
  const doks = join(root, '.doklo/hub/doks');
  for (const name of await readdir(doks)) await rm(join(doks, name));
  for (const id of articleIds) {
    await writeFile(join(doks, `${id}.json`), JSON.stringify({
      dok_id: id, name: '도움말', status, tags: [], surfaces: [], description: '작업을 완료하는 방법입니다.',
      user_actions: { steps: [{ order: 1, actor: { kind: 'external', label: '사용자' }, intent: '저장을 누르세요.', outcome: '변경한 내용을 확인합니다.', variants: [] }] },
      business_rules: { rules: [{ id: `BR-${id}-01`, type: 'validation', description: '내용을 입력하세요.' }] },
      acceptance_criteria: { criteria: [{ id: `AC-${id}-01`, statement: '저장한 내용이 보입니다.', related_rules: [`BR-${id}-01`] }] },
    }));
  }
  return root;
}

async function render(root: string, directory: string, variables: Record<string, string> = {}, preview = false, dokIds = articleIds) {
  return renderLivedoc({ workspaceRoot: root, templateRef: 'help-page', source: 'builtin', builtinRoot,
    locale: 'ko', format: 'html', outDir: join(root, directory), outputRoot: root, dokIds, variables, preview });
}

describe('embeddable help-page HTML', () => {
  it('keeps article, suffix, and prefix identities distinct even if the Dok ID grammar expands', () => {
    const first = helpPagePresentation('A', 'en', {});
    const suffix = helpPagePresentation('A--title', 'en', {});
    const prefixed = helpPagePresentation('A', 'en', { id_prefix: 'other--copy' });
    expect(first.article_id).toBe('doklo-help--p--d41');
    expect(suffix.article_id).not.toBe(first.title_id);
    expect(new Set([first.article_id, first.title_id, suffix.article_id, suffix.title_id, prefixed.article_id, prefixed.title_id]).size).toBe(6);
  });
  it('composes seven articles beneath the host heading with unique focusable anchors and resolved labels', async () => {
    const root = await workspace();
    await render(root, 'fragments', { html_fragment: 'true', heading_level: '2' });
    const fragments = await Promise.all(articleIds.map((id) => readFile(join(root, 'fragments', `${id}.html`), 'utf8')));
    for (const fragment of fragments) expect(fragment).not.toMatch(/<!doctype|<(?:html|head|body|main|style|script)\b/i);
    const anchors = ['43484154', '4348494c44', '4348494c442d5245434f52442d44455441494c', '4e59414d4e41594d', '46414d494c592d4a4f494e', '53455454494e4753', '484f4d45'];
    const links = anchors.map((id) => `<a href="#doklo-help--p--d${id}">도움말 열기</a>`).join('');
    const body = DOMPurify.sanitize(`<h1>사용 안내</h1><nav>${links}</nav>${fragments.join('')}`, { RETURN_DOM: true });
    expect(body.querySelectorAll('h1')).toHaveLength(1);
    expect(body.querySelectorAll('article.doklo-help[lang="ko"]')).toHaveLength(7);
    expect(body.querySelectorAll('h2.help-title')).toHaveLength(7);
    expect(body.querySelectorAll('h3.help-section-title')).toHaveLength(21);
    const ids = [...body.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const element of body.querySelectorAll('[aria-labelledby]')) {
      const target = body.querySelector(`[id="${element.getAttribute('aria-labelledby')}"]`);
      expect(target?.matches('h2, h3')).toBe(true);
    }
    for (const link of body.querySelectorAll('a[href^="#"]')) {
      const target = body.querySelector(`[id="${link.getAttribute('href')!.slice(1)}"]`);
      expect(target?.getAttribute('tabindex')).toBe('-1');
    }
    for (const target of body.querySelectorAll('[id]')) expect(target.getAttribute('tabindex')).toBe('-1');
  });

  it('namespaces a repeated Dok without shortening its full ID and produces deterministic bytes', async () => {
    const root = await workspace();
    for (const prefix of ['primary', 'sidebar']) {
      await render(root, prefix, { html_fragment: 'true', id_prefix: prefix }, false, ['CHILD-RECORD-DETAIL']);
    }
    const first = await readFile(join(root, 'primary/CHILD-RECORD-DETAIL.html'), 'utf8');
    const second = await readFile(join(root, 'sidebar/CHILD-RECORD-DETAIL.html'), 'utf8');
    const body = DOMPurify.sanitize(first + second, { RETURN_DOM: true });
    const ids = [...body.querySelectorAll('[id]')].map((element) => element.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toContain('doklo-help--p7072696d617279--d4348494c442d5245434f52442d44455441494c');
    expect(ids).toContain('doklo-help--p73696465626172--d4348494c442d5245434f52442d44455441494c');
    await render(root, 'again', { html_fragment: 'true', id_prefix: 'primary' }, false, ['CHILD-RECORD-DETAIL']);
    expect(await readFile(join(root, 'again/CHILD-RECORD-DETAIL.html'), 'utf8')).toBe(first);
  });

  it('preserves document defaults and derives the document title when the heading level changes', async () => {
    const root = await workspace();
    await render(root, 'document', {}, false, ['CHAT']);
    const html = await readFile(join(root, 'document/CHAT.html'), 'utf8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<style>');
    expect(html).toMatch(/<h1\b[^>]*class="help-title"/);
    await render(root, 'level-five', { heading_level: '5' }, false, ['CHAT']);
    const adjusted = await readFile(join(root, 'level-five/CHAT.html'), 'utf8');
    expect(adjusted).toMatch(/<h5\b[^>]*class="help-title"/);
    expect(adjusted).toMatch(/<h6\b[^>]*class="help-section-title"/);
    expect(adjusted).toContain('<title>도움말</title>');
  });

  it('retains sanitization and the engine preview watermark without modifying draft status', async () => {
    const root = await workspace('draft');
    const path = join(root, '.doklo/hub/doks/CHAT.json');
    const before = await readFile(path, 'utf8');
    await render(root, 'preview', { html_fragment: 'true', support_url: 'javascript:alert(1)', index_url: 'https://example.com/\" onclick=\"alert(1)' }, true, ['CHAT']);
    const html = await readFile(join(root, 'preview/CHAT.html'), 'utf8');
    expect(html).toContain('data-doklo-preview="draft"');
    expect(html).toContain('Not reviewed or approved');
    expect(html).not.toMatch(/javascript:|onclick=|<script|<html|<style/i);
    expect(await readFile(path, 'utf8')).toBe(before);
    await expect(render(root, 'official', { html_fragment: 'true' }, false, ['CHAT']))
      .rejects.toMatchObject({ code: 'UNREVIEWED_DOK' });
  });

  it('removes stylesheet and script injection from raw reviewed prose before embedding', async () => {
    const root = await workspace();
    const path = join(root, '.doklo/hub/doks/CHAT.json');
    const dok = JSON.parse(await readFile(path, 'utf8'));
    // Browsers accept the trailing slash on end tags; it also avoids unrelated
    // application-route normalization rewriting a plain </style> closing tag.
    dok.description = '<p>설명입니다.</p/><style>body{display:none}</style/><script>alert(1)</script/><p>안내입니다.</p/>';
    await writeFile(path, JSON.stringify(dok));
    await render(root, 'style-injection', { html_fragment: 'true' }, false, ['CHAT']);
    const html = await readFile(join(root, 'style-injection/CHAT.html'), 'utf8');
    expect(html).toContain('설명입니다.');
    expect(html).toContain('안내입니다.');
    expect(html).not.toMatch(/<(?:style|script)\b|body\{|display:none|alert\(/i);
  });

  it('removes untrusted inline CSS while preserving bounded screenshot geometry and preview styling', async () => {
    const root = await workspace();
    const path = join(root, '.doklo/hub/doks/CHAT.json');
    const dok = JSON.parse(await readFile(path, 'utf8'));
    dok.description = '<span style="position:fixed;inset:0;background:red;z-index:999999">설명입니다.</span/>'
      + '<span class="help-shot-wrap"><span class="help-shot-box" style="left:0%;top:0%;width:100%;height:100%;position:fixed">안내입니다.</span/></span/>';
    await writeFile(path, JSON.stringify(dok));
    const screenshots = join(root, '.doklo/screenshots/CHAT');
    await mkdir(screenshots, { recursive: true });
    await writeFile(join(screenshots, 'step-1.png'), Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000d49444154789c63680000000200015a4d57f50000000049454e44ae426082', 'hex'));
    await writeFile(join(screenshots, 'annotations.json'), JSON.stringify({ regions: [{ step: 1, x: 10, y: 20, w: 30, h: 40 }] }));
    await render(root, 'bounded-styles', { html_fragment: 'true' }, true, ['CHAT']);
    const html = await readFile(join(root, 'bounded-styles/CHAT.html'), 'utf8');
    expect(html).not.toMatch(/position:fixed|inset:|z-index:|background:red/);
    expect(html).toContain('style="left:10%;top:20%;width:30%;height:40%"');
    expect(html).toMatch(/data-doklo-preview="draft"[^>]*style="display:block!important/);
    await writeFile(join(screenshots, 'annotations.json'), JSON.stringify({ regions: [{ step: 1, x: 99, y: 20, w: 30, h: 40 }] }));
    await render(root, 'overflowing-geometry', { html_fragment: 'true' }, false, ['CHAT']);
    const overflow = await readFile(join(root, 'overflowing-geometry/CHAT.html'), 'utf8');
    expect(overflow).not.toMatch(/\bstyle=/);
  });

  it.each([
    { heading_level: '0' }, { heading_level: '6' }, { heading_level: '1.5' },
    { heading_level: '2><script>' }, { id_prefix: 'bad prefix' }, { id_prefix: '\" onclick=\"alert(1)' },
  ])('rejects unsafe presentation variables before producing files: %j', async (variables) => {
    const root = await workspace();
    const manifest = (await parseTemplate(join(builtinRoot, 'help-page'))).manifest;
    expect(() => coerceTemplateVariables(manifest, variables)).toThrow();
    await expect(render(root, 'invalid', variables)).rejects.toMatchObject({ code: 'INVALID_TEMPLATE_VARIABLE' });
    expect(await readdir(root)).not.toContain('invalid');
  });
});
