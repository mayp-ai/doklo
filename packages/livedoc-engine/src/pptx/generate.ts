import { createRequire } from 'node:module';
import type { ResolvedTheme } from '../theme.js';
import { canonicalizeZipBytes } from '../canonical-zip.js';

/**
 * PPTX slide generator (binary renderer). Ported + simplified from the
 * preserved-branch spoke-user-guide/render-pptx.ts. The layout/theme know-how
 * (16:9 regions, number circles, autoFit text frames, contain-sizing for
 * screenshots, Korean font face) is kept; the annotation-overlay model is
 * dropped because v5 has no annotations.json — instead each step gets one
 * slide with its real screenshot + a numbered intent/outcome right column.
 *
 * pptxgenjs is CJS-only; loaded via createRequire to avoid the UMD namespace
 * type collision under NodeNext.
 */

const _require = createRequire(import.meta.url);

interface PptxGenJSInstance {
  layout: string;
  addSlide(): SlideInstance;
  write(props: { outputType: string }): Promise<unknown>;
}
interface SlideInstance {
  addText(text: string | TextRun[], options: Record<string, unknown>): void;
  addShape(shapeType: string, options: Record<string, unknown>): void;
  addImage(options: Record<string, unknown>): void;
}
interface TextRun { text: string; options: Record<string, unknown> }

// ---- theme (inlined) ----
const PLACEHOLDER_BORDER = 'BBBBBB';
const FONT = {
  titleSlide: 32, titleSubtitle: 14, footer: 11, slideHeader: 20,
  badge: 12, number: 10, intent: 14, outcome: 12,
};
const REGIONS = {
  header: { x: 0.4, y: 0.2, w: 9.2, h: 0.5 },
  badge: { x: 7.5, y: 0.25, w: 2.0, h: 0.4 },
  screenshot: { x: 0.4, y: 1.0, w: 6.0, h: 4.3 },
  rightCol: { x: 6.6, y: 1.0, w: 3.0, h: 4.3 },
};
const CIRCLE_D = 0.28;
const SLIDE_W = 10;
const SLIDE_H = 5.625; // 16:9 canvas height for LAYOUT_16x9
const CHROME = {
  margin: 0.4,       // matches REGIONS.header.x
  logoY: 0.2,
  logoRatio: 3,      // logo box width = maxHeight * ratio
  footerY: 5.25,
  footerH: 0.3,
  footerTextW: 7.0,
  pageNumX: 8.6,
  pageNumW: 1.0,
  coverBandY: 1.2,
  coverBandH: 2.2,
};

export interface PptxStep {
  number: number;
  actorLabel: string;
  isSystem: boolean;
  intent: string;
  outcome: string;
  /** Absolute filesystem path to a screenshot, or undefined for placeholder. */
  screenshotPath?: string;
  /** Interaction box as % of the screenshot image; drawn as a crisp overlay. */
  annotation?: { x: number; y: number; w: number; h: number };
}

export interface PptxView {
  dokId: string;
  title: string;
  description: string;
  locale: string;
  generatedAt: string; // ISO datetime
  steps: PptxStep[];
  /** Resolved visual theme (colors/fonts/logo/footer/cover). */
  theme: ResolvedTheme;
  /** UI strings (already localized) for fixed labels. */
  strings: {
    generatedBy: string;
    step: string;
    actorSystem: string;
    screenshotDrop: string;
  };
}

function face(view: PptxView): string {
  return view.locale.startsWith('ko') ? view.theme.fonts.bodyKo : view.theme.fonts.bodyEn;
}
function headingFace(view: PptxView): string {
  return view.locale.startsWith('ko') ? view.theme.fonts.headingKo : view.theme.fonts.headingEn;
}

export async function renderPptxBuffer(view: PptxView): Promise<Buffer> {
  const PptxGenJS = _require('pptxgenjs') as {
    new (): PptxGenJSInstance;
  };
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';

  addTitleSlide(pres, view);              // page 1
  let page = 1;
  for (const step of view.steps) {
    page += 1;
    addStepSlide(pres, view, step, page);
  }
  const bytes = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
  return canonicalizeZipBytes(bytes, view.generatedAt);
}

function addTitleSlide(pres: PptxGenJSInstance, view: PptxView): void {
  const slide = pres.addSlide();
  const hf = headingFace(view);
  const f = face(view);

  // Cover branding: full-bleed background image, else a colored band behind the title.
  if (view.theme.cover.backgroundImagePath) {
    slide.addImage({
      path: view.theme.cover.backgroundImagePath,
      x: 0, y: 0, w: SLIDE_W, h: SLIDE_H,
      sizing: { type: 'cover', w: SLIDE_W, h: SLIDE_H },
    });
  } else if (view.theme.cover.backgroundColor) {
    slide.addShape('rect', {
      x: 0, y: CHROME.coverBandY, w: SLIDE_W, h: CHROME.coverBandH,
      fill: { color: view.theme.cover.backgroundColor }, line: { width: 0 },
    });
  }

  slide.addText(view.title, {
    x: 0.5, y: 1.5, w: 9, h: 1.0,
    fontFace: hf, fontSize: FONT.titleSlide, bold: true, color: view.theme.colors.headerText,
  });
  slide.addText(view.description, {
    x: 0.5, y: 2.6, w: 9, h: 1.8,
    fontFace: f, fontSize: FONT.titleSubtitle, color: view.theme.colors.bodyText,
    valign: 'top', autoFit: true,
  });
  slide.addText(`${view.strings.generatedBy} · ${view.generatedAt.slice(0, 10)} · ${view.locale}`, {
    x: 0.5, y: 5.0, w: 9, h: 0.4,
    fontFace: f, fontSize: FONT.footer, color: view.theme.colors.mutedText,
  });

  drawChrome(slide, view, 1);
}

function addStepSlide(pres: PptxGenJSInstance, view: PptxView, step: PptxStep, pageNumber: number): void {
  const slide = pres.addSlide();
  const f = face(view);
  const hf = headingFace(view);

  // Header: Dok title (manual-style consistency) + step badge on the right.
  slide.addText(view.title, {
    x: REGIONS.header.x, y: REGIONS.header.y,
    w: REGIONS.header.w - REGIONS.badge.w - 0.1, h: REGIONS.header.h,
    fontFace: hf, fontSize: FONT.slideHeader, bold: true, color: view.theme.colors.headerText,
  });
  slide.addText(`${view.strings.step} ${step.number}`, {
    x: REGIONS.badge.x, y: REGIONS.badge.y, w: REGIONS.badge.w, h: REGIONS.badge.h,
    fontFace: f, fontSize: FONT.badge, bold: true, color: view.theme.colors.accent, align: 'right',
  });

  // Screenshot (contain) or dashed placeholder.
  if (step.screenshotPath) {
    // Compute the contain fit OURSELVES from the PNG's real dimensions.
    // pptxgenjs's `sizing: {type:'contain'}` does not reliably letterbox
    // path images (observed: full-frame ext + zero srcRect → vertical
    // stretch), which both distorts the screenshot and breaks any overlay
    // math that assumes the fitted rect.
    const fit = containFit(pngSize(step.screenshotPath), REGIONS.screenshot);
    slide.addImage({
      path: step.screenshotPath,
      x: fit.x, y: fit.y, w: fit.w, h: fit.h,
    });
    // Crisp interaction box drawn as an overlay (not baked into the PNG).
    // Annotation % are relative to the image — the same fitted rect.
    if (step.annotation) {
      drawAnnotationBox(slide, step, view, fit);
    }
  } else {
    slide.addShape('rect', {
      x: REGIONS.screenshot.x, y: REGIONS.screenshot.y,
      w: REGIONS.screenshot.w, h: REGIONS.screenshot.h,
      line: { color: PLACEHOLDER_BORDER, width: 1, dashType: 'dash' },
      fill: { color: view.theme.colors.background },
    });
    slide.addText(`${view.strings.screenshotDrop}\n.doklo/screenshots/${view.dokId}/step-${step.number}.png`, {
      x: REGIONS.screenshot.x, y: REGIONS.screenshot.y + 1.8, w: REGIONS.screenshot.w, h: 0.9,
      fontFace: f, fontSize: FONT.outcome, color: view.theme.colors.mutedText, align: 'center',
    });
  }

  // Right column: number badge + actor + intent (bold) + outcome (muted).
  const cx = REGIONS.rightCol.x;
  const cw = REGIONS.rightCol.w;
  const textX = cx + CIRCLE_D + 0.12;
  const textW = cw - (CIRCLE_D + 0.12);
  const color = step.isSystem ? view.theme.colors.mutedText : view.theme.colors.bodyText;
  const y = REGIONS.rightCol.y + 0.1;

  if (step.isSystem) {
    slide.addText('⚙', {
      x: cx, y, w: CIRCLE_D, h: CIRCLE_D,
      fontFace: f, fontSize: FONT.number, color: view.theme.colors.mutedText, align: 'center', valign: 'middle',
    });
  } else {
    slide.addShape('ellipse', {
      x: cx, y, w: CIRCLE_D, h: CIRCLE_D,
      fill: { color: view.theme.colors.accent }, line: { color: view.theme.colors.accent, width: 0 },
    });
    slide.addText(String(step.number), {
      x: cx, y, w: CIRCLE_D, h: CIRCLE_D,
      fontFace: f, fontSize: FONT.number, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
    });
  }

  slide.addText(step.actorLabel, {
    x: textX, y: y - 0.02, w: textW, h: 0.3,
    fontFace: f, fontSize: 10, bold: true, color: view.theme.colors.accent,
  });
  slide.addText(
    [
      { text: step.intent, options: { bold: true, fontSize: FONT.intent, color, breakLine: true } },
      { text: step.outcome, options: { fontSize: FONT.outcome, color: view.theme.colors.mutedText } },
    ],
    {
      x: textX, y: y + 0.32, w: textW, h: REGIONS.rightCol.h - 0.5,
      fontFace: f, valign: 'top', autoFit: true, paraSpaceAfter: 6,
    },
  );

  drawChrome(slide, view, pageNumber);
}

/**
 * Draw the logo, footer text, and optional page number that appear on every
 * slide (title slide page=1, step slides page=2+). When the default theme is
 * active all three fields are empty/none so nothing is drawn — existing slide
 * geometry is unaffected.
 */
function drawChrome(slide: SlideInstance, view: PptxView, pageNumber: number): void {
  const t = view.theme;
  // Logo (contain inside a maxHeight box; ~logoRatio:1 max box width).
  if (t.logo.assetPath && t.logo.position !== 'none') {
    const h = t.logo.maxHeight;
    const w = h * CHROME.logoRatio;
    const x = t.logo.position === 'top-right'
      ? Math.max(CHROME.margin, SLIDE_W - CHROME.margin - w)
      : CHROME.margin;
    slide.addImage({ path: t.logo.assetPath, x, y: CHROME.logoY, w, h, sizing: { type: 'contain', w, h } });
  }
  // Footer text (bottom-left) + optional page number (bottom-right).
  if (t.footer.text) {
    slide.addText(t.footer.text, {
      x: CHROME.margin, y: CHROME.footerY, w: CHROME.footerTextW, h: CHROME.footerH,
      fontFace: face(view), fontSize: FONT.footer, color: t.colors.mutedText, valign: 'middle',
    });
  }
  if (t.footer.showPageNumber) {
    slide.addText(String(pageNumber), {
      x: CHROME.pageNumX, y: CHROME.footerY, w: CHROME.pageNumW, h: CHROME.footerH,
      fontFace: face(view), fontSize: FONT.footer, color: t.colors.mutedText, align: 'right', valign: 'middle',
    });
  }
}

/** A placed rectangle in slide inches. */
interface FitRect { x: number; y: number; w: number; h: number }

/**
 * Object-fit: contain — the image's fitted sub-rect inside a region,
 * centered on the letterboxed axis. Falls back to the full region when
 * the PNG dimensions can't be read.
 */
function containFit(dim: { w: number; h: number } | null, R: FitRect): FitRect {
  if (!dim || dim.w <= 0 || dim.h <= 0) return { ...R };
  const imgAR = dim.w / dim.h;
  const regAR = R.w / R.h;
  if (imgAR > regAR) {
    // image wider → full width, letterbox top/bottom
    const h = R.w / imgAR;
    return { x: R.x, y: R.y + (R.h - h) / 2, w: R.w, h };
  }
  // image taller → full height, pillarbox left/right
  const w = R.h * imgAR;
  return { x: R.x + (R.w - w) / 2, y: R.y, w, h: R.h };
}

/**
 * Draw the interaction box + number badge over the screenshot, mapped onto
 * the same fitted rect the image was placed with. The box is line-only —
 * fill is written as a fully transparent solid because pptxgenjs's
 * `fill: {type:'none'}` emits no fill element at all, which viewers then
 * paint with the theme's default (opaque white) over the screenshot.
 */
function drawAnnotationBox(slide: SlideInstance, step: PptxStep, view: PptxView, fit: FitRect): void {
  const f = face(view);
  const ann = step.annotation!;
  const R = REGIONS.screenshot;

  const bx = fit.x + (ann.x / 100) * fit.w;
  const by = fit.y + (ann.y / 100) * fit.h;
  const bw = Math.max(0.05, (ann.w / 100) * fit.w);
  const bh = Math.max(0.05, (ann.h / 100) * fit.h);

  slide.addShape('rect', {
    x: bx, y: by, w: bw, h: bh,
    line: { color: view.theme.colors.accent, width: 2.25 },
    fill: { color: 'FFFFFF', transparency: 100 },
  });

  // number badge tucked at the box's top-left (slight overlap), matching the
  // right-column number so reader can connect them.
  const d = CIRCLE_D;
  const badgeX = Math.max(R.x, bx - d + 0.05);
  const badgeY = Math.max(R.y, by - d + 0.05);
  slide.addShape('ellipse', {
    x: badgeX, y: badgeY, w: d, h: d,
    fill: { color: view.theme.colors.accent }, line: { color: view.theme.colors.accent, width: 0 },
  });
  slide.addText(String(step.number), {
    x: badgeX, y: badgeY, w: d, h: d,
    fontFace: f, fontSize: FONT.number, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
  });
}

/** Read a PNG's pixel dimensions from the IHDR chunk (bytes 16-24). */
function pngSize(path: string): { w: number; h: number } | null {
  try {
    const { readFileSync } = _require('node:fs') as typeof import('node:fs');
    const buf = readFileSync(path) as Buffer;
    // PNG signature (8) + IHDR length (4) + "IHDR" (4) + width (4) + height (4)
    if (buf.length < 24) return null;
    if (buf.toString('latin1', 1, 4) !== 'PNG') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}
