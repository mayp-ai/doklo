import JSZip from 'jszip';

/**
 * House-style post-processor for kordoc-generated .hwpx packages.
 *
 * Two jobs:
 *
 * 1. **Fix the borderFill id base.** Genuine Hancom-saved files number
 *    borderFills from 1; kordoc numbers from 0. 한컴 resolves the refs
 *    against the 1-based convention, so kordoc's `borderFillIDRef="1"`
 *    (meant: SOLID) lands on the NONE entry — every table renders
 *    borderless. Verified against hwpxlib's Hancom-authored SimpleTable
 *    fixture (borderFills 1/2/3, no id="0" anywhere; charPr/paraPr stay
 *    0-based). When a 0-based registry is detected, all borderFill ids
 *    and every borderFillIDRef shift by +1.
 *
 * 2. **산출물 finishing.** Adds a shaded borderFill for table header
 *    rows (header="1" cells), bolds their text runs, centers the h1
 *    title paragraph style.
 */

const SHADED_FILL = (id: number) => `<hh:borderFill id="${id}" threeD="0" shadow="0" centerLine="0" breakCellSeparateLine="0">
        <hh:slash type="NONE" Crooked="0" isCounter="0"/>
        <hh:backSlash type="NONE" Crooked="0" isCounter="0"/>
        <hh:leftBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:rightBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:topBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:bottomBorder type="SOLID" width="0.12 mm" color="#000000"/>
        <hh:diagonal type="NONE" width="0.1 mm" color="#000000"/>
        <hh:fillInfo><hc:winBrush faceColor="#D9D9D9" hatchColor="#999999" alpha="0"/></hh:fillInfo>
      </hh:borderFill>`;

interface PatchPlan {
  /** Shift all borderFill ids/refs by +1 (kordoc 0-based registry detected). */
  shift: boolean;
  /** Id of the appended shaded header fill. */
  shadedId: number;
}

function planFor(header: string): PatchPlan {
  const ids = [...header.matchAll(/<hh:borderFill id="(\d+)"/g)].map((m) => Number(m[1]));
  const shift = ids.includes(0);
  const maxAfterShift = ids.length ? Math.max(...ids) + (shift ? 1 : 0) : 0;
  return { shift, shadedId: maxAfterShift + 1 };
}

function patchHeaderXml(header: string, plan: PatchPlan): string {
  let out = header;

  if (!out.includes('xmlns:hc=')) {
    out = out.replace(
      'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head"',
      'xmlns:hh="http://www.hancom.co.kr/hwpml/2011/head" xmlns:hc="http://www.hancom.co.kr/hwpml/2011/core"',
    );
  }

  if (plan.shift) {
    out = out.replace(/(<hh:borderFill id=")(\d+)(")/g, (_, a, n, b) => `${a}${Number(n) + 1}${b}`);
    // charPr/paraPr keep their 0-based ids, but their borderFillIDRef
    // attributes point into the shifted registry.
    out = out.replace(/(borderFillIDRef=")(\d+)(")/g, (_, a, n, b) => `${a}${Number(n) + 1}${b}`);
  }

  out = out.replace(
    /<hh:borderFills itemCnt="(\d+)">/,
    (_, n: string) => `<hh:borderFills itemCnt="${Number(n) + 1}">`,
  );
  out = out.replace('</hh:borderFills>', `${SHADED_FILL(plan.shadedId)}\n    </hh:borderFills>`);

  // Center the document title (kordoc maps h1 → paraPr 1, used only by h1).
  out = out.replace(
    /(<hh:paraPr id="1"[^>]*>\s*<hh:align horizontal=")LEFT(")/,
    '$1CENTER$2',
  );

  // Paragraph rhythm. Two problems with kordoc's spacing markup:
  //
  // 1. FORM: kordoc writes `<hh:margin indent=".." prev=".." next=".."/>`
  //    as ATTRIBUTES. Genuine Hancom files write margins as CHILD ELEMENTS
  //    (`<hh:margin><hc:prev value=".." unit="HWPUNIT"/>…`) inside an
  //    <hp:switch> compat block — 한컴 ignores the attribute form entirely,
  //    which is why no spacing ever rendered.
  // 2. VALUES: kordoc ships body paragraphs with zero after-spacing and
  //    headings with ~6pt before — cramped even if the form were right.
  //
  // Convert every paraPr margin+lineSpacing to the genuine child-element
  // switch form, overriding prev/next (units: 1/100 pt) for body/headings.
  const SPACING: Record<string, { prev: number; next: number }> = {
    '0': { prev: 0, next: 300 },    // body
    '1': { prev: 800, next: 600 },  // h1 (title)
    '2': { prev: 1600, next: 500 }, // h2
    '3': { prev: 1200, next: 400 }, // h3
    '4': { prev: 1000, next: 350 }, // h4
  };
  out = out.replace(/<hh:paraPr id="(\d+)"[\s\S]*?<\/hh:paraPr>/g, (block, id: string) =>
    block.replace(
      /<hh:margin indent="(\d+)" left="(\d+)" right="(\d+)" prev="(\d+)" next="(\d+)"\/>\s*<hh:lineSpacing type="(\w+)" value="(\d+)"[^/]*\/>/,
      (_m, indent, left, right, prev, next, lsType, lsValue) => {
        const sp = SPACING[id] ?? { prev: Number(prev), next: Number(next) };
        const margin =
          `<hh:margin><hc:intent value="${indent}" unit="HWPUNIT"/>` +
          `<hc:left value="${left}" unit="HWPUNIT"/><hc:right value="${right}" unit="HWPUNIT"/>` +
          `<hc:prev value="${sp.prev}" unit="HWPUNIT"/><hc:next value="${sp.next}" unit="HWPUNIT"/></hh:margin>` +
          `<hh:lineSpacing type="${lsType}" value="${lsValue}" unit="HWPUNIT"/>`;
        return (
          `<hp:switch><hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">` +
          margin +
          `</hp:case><hp:default>` +
          margin +
          `</hp:default></hp:switch>`
        );
      },
    ),
  );

  return out;
}

function patchSectionXml(section: string, plan: PatchPlan): string {
  let out = section;

  if (plan.shift) {
    out = out.replace(/(borderFillIDRef=")(\d+)(")/g, (_, a, n, b) => `${a}${Number(n) + 1}${b}`);
  }

  // Table-header cells: shaded fill + bold runs.
  out = out.replace(
    /<hp:tc ([^>]*)>([\s\S]*?)<\/hp:tc>/g,
    (whole, attrs: string, body: string) => {
      if (!/\bheader="1"/.test(attrs)) return whole;
      const newAttrs = attrs.replace(/borderFillIDRef="\d+"/, `borderFillIDRef="${plan.shadedId}"`);
      const newBody = body.replace(/charPrIDRef="0"/g, 'charPrIDRef="1"');
      return `<hp:tc ${newAttrs}>${newBody}</hp:tc>`;
    },
  );

  // Table breathing room (units: 1/100 pt): kordoc ships zero outer margin
  // (tables glued to surrounding text) and 1.4pt cell padding (text touches
  // the rules). 3.5pt above / 5pt below the table, 2.2pt cell padding.
  out = out.replace(
    /<hp:outMargin left="0" right="0" top="0" bottom="0"\/>/g,
    '<hp:outMargin left="0" right="0" top="350" bottom="500"/>',
  );
  out = out.replace(
    /(<hp:inMargin left="[^"]*" right="[^"]*" top=")141(" bottom=")141("\/>)/g,
    '$1220$2220$3',
  );

  // Column widths: kordoc splits every table into EQUAL columns, so a
  // two-digit "번호" column gets the same width as a sentence column.
  // Redistribute each table's total width by per-column content weight
  // (max visual length over the column's cells; CJK counts double).
  out = out.replace(/<hp:tbl [\s\S]*?<\/hp:tbl>/g, (tbl) => redistributeColumns(tbl));

  return out;
}

function visualLen(text: string): number {
  let n = 0;
  for (const ch of text) {
    n += /[ᄀ-ᇿ　-鿿가-힯豈-﫿]/.test(ch) ? 2 : 1;
  }
  return n;
}

/** Reweight one <hp:tbl> block's cellSz widths by column content. */
function redistributeColumns(tbl: string): string {
  const szMatch = /<hp:sz width="(\d+)"/.exec(tbl);
  const colMatch = /colCnt="(\d+)"/.exec(tbl);
  if (!szMatch?.[1] || !colMatch?.[1]) return tbl;
  const total = Number(szMatch[1]);
  const colCnt = Number(colMatch[1]);
  if (colCnt < 2) return tbl;
  if (/<hp:cellSpan colSpan="(?!1")\d+"/.test(tbl)) return tbl; // merged cells — leave as-is

  // Pass 1: max content weight per column.
  const weights = new Array<number>(colCnt).fill(4); // floor so "번호" never collapses
  for (const tc of tbl.matchAll(/<hp:tc [\s\S]*?<\/hp:tc>/g)) {
    const col = /<hp:cellAddr colAddr="(\d+)"/.exec(tc[0]);
    if (!col?.[1]) continue;
    const c = Number(col[1]);
    if (c >= colCnt) continue;
    const text = [...tc[0].matchAll(/<hp:t>([^<]*)<\/hp:t>/g)].map((m) => m[1]).join('');
    weights[c] = Math.max(weights[c]!, Math.min(visualLen(text), 60)); // cap so one huge cell doesn't starve the rest
  }

  // Pass 2: two tiers. Short "label" columns (단계, 수행 주체, IDs…) hold
  // word-shaped content that must NOT wrap mid-word — they get exactly the
  // width their longest entry needs (≈500 units per visual char + padding).
  // Prose columns share whatever remains, proportionally.
  const LABEL_MAX_WEIGHT = 12;
  const labelWidth = (w: number) => w * 500 + 1600;
  const isLabel = weights.map((w) => w <= LABEL_MAX_WEIGHT);
  let widths: number[];
  const labelTotal = weights.reduce((a, w, i) => a + (isLabel[i] ? labelWidth(w) : 0), 0);
  const proseWeight = weights.reduce((a, w, i) => a + (isLabel[i] ? 0 : w), 0);
  const proseCols = isLabel.filter((l) => !l).length;
  const remaining = total - labelTotal;
  // Sanity: prose columns must keep at least ~60pt each after labels take
  // their fixed share — otherwise fall back to a plain proportional split.
  if (proseWeight > 0 && remaining >= proseCols * 6000) {
    widths = weights.map((w, i) =>
      isLabel[i] ? labelWidth(w) : Math.round((remaining * w) / proseWeight),
    );
  } else {
    // No prose columns (or labels would overflow) — plain proportional split.
    const sum = weights.reduce((a, b) => a + b, 0);
    widths = weights.map((w) => Math.round((total * w) / sum));
  }
  const over = widths.reduce((a, b) => a + b, 0) - total;
  widths[widths.length - 1] = Math.max(1600, widths[widths.length - 1]! - over);

  // Pass 3: write each cell's width per its column.
  return tbl.replace(/<hp:tc [\s\S]*?<\/hp:tc>/g, (tc) => {
    const col = /<hp:cellAddr colAddr="(\d+)"/.exec(tc);
    if (!col?.[1]) return tc;
    const w = widths[Number(col[1])];
    if (!w) return tc;
    return tc.replace(/(<hp:cellSz width=")\d+(")/, `$1${w}$2`);
  });
}

export async function applyHwpxHouseStyle(buf: ArrayBuffer | Buffer): Promise<Buffer> {
  const zip = await JSZip.loadAsync(buf);
  const headerFile = zip.file('Contents/header.xml');
  const sectionFile = zip.file('Contents/section0.xml');
  if (!headerFile || !sectionFile) return Buffer.from(buf as ArrayBuffer); // not a layout we know — pass through

  const header = await headerFile.async('string');
  const plan = planFor(header);
  zip.file('Contents/header.xml', patchHeaderXml(header, plan));
  zip.file('Contents/section0.xml', patchSectionXml(await sectionFile.async('string'), plan));

  // Rebuild keeping the OPC convention: `mimetype` first and STORED.
  const out = new JSZip();
  const mimetype = zip.file('mimetype');
  if (mimetype) {
    out.file('mimetype', await mimetype.async('uint8array'), { compression: 'STORE' });
  }
  for (const [name, entry] of Object.entries(zip.files)) {
    if (name === 'mimetype' || entry.dir) continue;
    out.file(name, await entry.async('uint8array'), { compression: 'DEFLATE' });
  }
  return out.generateAsync({ type: 'nodebuffer' });
}
