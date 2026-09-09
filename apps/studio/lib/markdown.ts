// Lightweight markdown-to-HTML renderer for Spoke documents.
// First pass: handles headings, paragraphs, ordered/unordered lists,
// code blocks (fenced), blockquotes, inline code, bold, italic, and links.
// Tables, footnotes, and HTML pass-through are intentionally not supported.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function inline(text: string): string {
  let s = escapeHtml(text);
  // Inline code first so we don't double-escape its contents
  s = s.replace(/`([^`]+)`/g, (_, code) => `<code>${code}</code>`);
  // Bold **x**
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  // Italic *x* — repurposed as medium emphasis in CSS (em rule)
  s = s.replace(/(^|[^*])\*([^*\s][^*]*?)\*(?!\*)/g, '$1<em>$2</em>');
  // Links [text](url)
  s = s.replace(
    /\[([^\]]+)\]\(([^)]+)\)/g,
    (_, label, url) => `<a href="${url}">${label}</a>`,
  );
  return s;
}

const HEADING = /^(#{1,6})\s+(.*)$/;
const UL = /^[-*]\s+(.*)$/;
const OL = /^\d+\.\s+(.*)$/;
const FENCE = /^```\s*(.*)$/;
const BLOCKQUOTE = /^>\s?(.*)$/;

export function parseMarkdown(md: string): string {
  const lines = md.split('\n');
  const out: string[] = [];
  let i = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Heading
    const h = line.match(HEADING);
    if (h) {
      const level = h[1].length;
      out.push(`<h${level}>${inline(h[2])}</h${level}>`);
      i++;
      continue;
    }

    // Fenced code
    const fence = line.match(FENCE);
    if (fence) {
      const lang = fence[1].trim();
      i++;
      const code: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        code.push(lines[i]);
        i++;
      }
      i++; // closing fence (or EOF)
      const langAttr = lang ? ` class="language-${escapeHtml(lang)}"` : '';
      out.push(
        `<pre><code${langAttr}>${escapeHtml(code.join('\n'))}</code></pre>`,
      );
      continue;
    }

    // Unordered list
    if (UL.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(UL);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(`<ul>${items.join('')}</ul>`);
      continue;
    }

    // Ordered list
    if (OL.test(line)) {
      const items: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(OL);
        if (!m) break;
        items.push(`<li>${inline(m[1])}</li>`);
        i++;
      }
      out.push(`<ol>${items.join('')}</ol>`);
      continue;
    }

    // Blockquote
    if (BLOCKQUOTE.test(line)) {
      const inner: string[] = [];
      while (i < lines.length) {
        const m = lines[i].match(BLOCKQUOTE);
        if (!m) break;
        inner.push(m[1]);
        i++;
      }
      out.push(
        `<blockquote><p>${inline(inner.join(' '))}</p></blockquote>`,
      );
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      i++;
      continue;
    }

    // Paragraph
    const para: string[] = [];
    while (i < lines.length) {
      const next = lines[i];
      if (
        next.trim() === '' ||
        HEADING.test(next) ||
        UL.test(next) ||
        OL.test(next) ||
        FENCE.test(next) ||
        BLOCKQUOTE.test(next)
      ) {
        break;
      }
      para.push(next);
      i++;
    }
    out.push(`<p>${inline(para.join(' '))}</p>`);
  }

  return out.join('\n');
}
