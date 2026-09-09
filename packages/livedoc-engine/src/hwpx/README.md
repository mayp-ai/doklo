# Generating .hwpx that 한컴오피스 actually renders

Hard-won knowledge from shipping the first Doklo .hwpx deliverables
(2026-06-04, three rounds of real-한컴 eyeball testing). Read this before
touching anything under `src/hwpx/` or `writers/hwpx.ts`.

## Pipeline

```
Handlebars template → Markdown body → kordoc markdownToHwpx() → applyHwpxHouseStyle() → .hwpx
```

- **kordoc** (MIT, npm) handles the OPC container + base OWPML. Its output
  *opens* in 한컴 but does not *render* like a document — every fix below
  lives in the `applyHwpxHouseStyle()` post-processor (`style.ts`).
- Templates must emit **plain Markdown only**: `#`–`####` headings,
  paragraphs, GFM tables, bold/italic. No raw HTML, no nested lists, no
  blank lines inside table rows.

## The four 한컴 rendering traps

All verified by diffing against a genuine Hancom-authored fixture:
`https://github.com/neolord0/hwpxlib` → `testFile/reader_writer/SimpleTable.hwpx`.
When in doubt, diff against a real file — kordoc round-tripping its own
output proves nothing about 한컴.

### 1. borderFill ids are 1-based
Genuine files never contain `borderFill id="0"`. kordoc numbers from 0,
so its `borderFillIDRef="1"` (meant: SOLID) resolves to the NONE entry —
**every table renders borderless**. `charPr`/`paraPr` ids stay 0-based;
only the borderFill registry shifts. The post-processor detects a 0-based
registry and shifts all ids + refs by +1.

### 2. Paragraph margins must be child elements, not attributes
kordoc writes `<hh:margin indent=".." prev=".." next=".."/>` — 한컴
**silently ignores the attribute form**, so no spacing value matters.
Genuine form (what we emit):

```xml
<hp:switch>
  <hp:case hp:required-namespace="http://www.hancom.co.kr/hwpml/2016/HwpUnitChar">
    <hh:margin><hc:intent value="0" unit="HWPUNIT"/>…<hc:prev value="1600" unit="HWPUNIT"/>
    <hc:next value="500" unit="HWPUNIT"/></hh:margin>
    <hh:lineSpacing type="PERCENT" value="170" unit="HWPUNIT"/>
  </hp:case>
  <hp:default>…same…</hp:default>
</hp:switch>
```

Units are 1/100 pt. House values: body `next=300`; h1 `800/600`
(centered); h2 `1600/500`; h3 `1200/400`; h4 `1000/350`.

### 3. Equal column splits read as broken
kordoc gives every column `tableWidth / colCnt`, so a "번호" column is as
wide as a sentence column — and word-shaped cells wrap mid-word
(관리↵자). The post-processor reweights per table:

- weight = max visual length per column (CJK counts double, capped at 60)
- **label columns** (weight ≤ 12) get a fixed width that fits their
  longest entry on one line: `weight * 500 + 1600` units
- prose columns share the remainder proportionally (sanity: ≥ ~60pt each,
  else plain proportional fallback)
- tables containing merged cells (colSpan > 1) are left untouched

### 4. Zero default spacing everywhere
kordoc ships table `outMargin` 0 (tables glued to text) and 1.41pt cell
padding (text touches rules). House style: `outMargin top=350 bottom=500`,
cell `inMargin top/bottom 220`.

## Also handled by the post-processor

- Table header rows (`<hp:tc header="1">`): shaded borderFill
  (`#D9D9D9` winBrush) + bold runs (charPr 0 → 1, kordoc's bold variant).
  The `hc` namespace must be declared on the `<hh:head>` root for winBrush.
- Repack keeps the OPC rule: `mimetype` first, STORED (uncompressed).
  Side effect: proper deflate shrinks files ~25x vs kordoc's output.

## Verification discipline

What each check does and does not prove:

| Check | Proves | Does NOT prove |
|---|---|---|
| `kordoc parseHwpx` round-trip | container/XML well-formed | 한컴 renders it |
| diff vs Hancom fixture | markup conventions match | visual quality |
| 한컴 human eyeball | the only real render check | — |

A change to this pipeline is **not done** until a human opens the file in
한컴오피스. There is no headless 한컴 renderer; do not claim "verified"
from round-trips alone (we made that mistake — three times).

## Backlog

- 결재란 merged-cell grid box, page headers/footers, 명조 font binding —
  needs hand-built OWPML beyond kordoc's markdown subset
- locale-conditional Gherkin/markdown bridging for en workspaces
