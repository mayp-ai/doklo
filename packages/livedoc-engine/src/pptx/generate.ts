import { createRequire } from 'node:module';
import type { ResolvedTheme } from '../theme.js';
import { canonicalizeZipBytes } from '../canonical-zip.js';

/**
 * PPTX manual generator (binary renderer).
 *
 * One deck is a user manual in the form Korean public-sector deliverables
 * take: cover → document information and revision history → contents →
 * 1 overview (purpose, readers, notation) → 2 access and roles → 3 menu
 * map → 4 one section per feature (a feature slide, then one slide per
 * screen with its screenshot or, without one, a screen description) →
 * 5 cautions → 6 contact → appendix (feature list). The step-slide
 * geometry (header, screenshot region, right column, number badges,
 * annotation overlay) is the one the earlier per-step deck used, so a
 * captured screenshot lands exactly where it did.
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
  addTable(rows: TableCell[][], options: Record<string, unknown>): void;
  addNotes(notes: string): void;
}
interface TextRun { text: string; options: Record<string, unknown> }
interface TableCell { text: string; options?: Record<string, unknown> }

// ---- geometry (inches, 16:9 = 10 × 5.625) ----
const SLIDE_W = 10;
const SLIDE_H = 5.625;
const PLACEHOLDER_BORDER = 'BBBBBB';
const FONT = {
  coverTitle: 30, coverSubtitle: 14, coverMeta: 11, footer: 9,
  chapter: 9, slideHeader: 20, badge: 11, number: 10,
  body: 12, bodySmall: 10.5, table: 10, tableHead: 10,
  intent: 14, outcome: 12, sectionTitle: 24,
};
const REGIONS = {
  header: { x: 0.4, y: 0.2, w: 9.2, h: 0.5 },
  badge: { x: 7.5, y: 0.25, w: 2.0, h: 0.4 },
  screenshot: { x: 0.4, y: 1.0, w: 6.0, h: 4.3 },
  rightCol: { x: 6.6, y: 1.0, w: 3.0, h: 4.3 },
  body: { x: 0.4, y: 1.0, w: 9.2, h: 4.1 },
};
const CIRCLE_D = 0.28;
const CHROME = {
  margin: 0.4,
  logoY: 0.2,
  logoRatio: 3,
  footerY: 5.25,
  footerH: 0.3,
  footerTextW: 5.0,
  footerCenterX: 3.5,
  footerCenterW: 3.0,
  pageNumX: 8.1,
  pageNumW: 1.5,
  coverBandY: 1.2,
  coverBandH: 2.2,
};
/** Rows a chunked table keeps on one slide. */
const ROWS_PER_SLIDE = { menu: 9, cautions: 7, appendix: 11, revision: 8 };

// ---- view model ----
export interface PptxStep {
  number: number;
  actorLabel: string;
  isSystem: boolean;
  intent: string;
  outcome: string;
  preconditions?: string[];
  platforms?: string[];
  /** Absolute filesystem path to a screenshot, or undefined for placeholder. */
  screenshotPath?: string;
  /** Interaction box as % of the screenshot image; drawn as a crisp overlay. */
  annotation?: { x: number; y: number; w: number; h: number };
}
export interface PptxRule {
  type: string;
  typeLabel: string;
  text: string;
}
export interface PptxFeature {
  dokId: string;
  title: string;
  description: string;
  roles: string[];
  route?: string;
  steps: PptxStep[];
  /** Restriction and policy rules a reader must know before using the feature. */
  cautions: PptxRule[];
  /** Acceptance statements: how a reader tells the feature worked. */
  checks: string[];
}
export interface PptxGroup {
  label: string;
  features: PptxFeature[];
}
export interface PptxRole {
  name: string;
  description: string;
  featureCount: number;
}
export interface PptxDocument {
  /** Document name on the cover, e.g. "사용자 매뉴얼". */
  title: string;
  /** Project or product name, e.g. "핀리 정산 시스템". */
  project: string;
  /** Owning organization printed in the footer; may be empty. */
  organization: string;
  version: string;
  /** Handling label such as "대외비"; may be empty. */
  classification: string;
  /** The Hub's as-of day, already formatted for the locale. */
  asOf: string;
  appUrl?: string;
  supportContact?: string;
}
export interface PptxStrings {
  generatedBy: string;
  step: string;
  actorSystem: string;
  screenshotDrop: string;
  docInfo: string;
  docName: string;
  docSystem: string;
  docVersion: string;
  docAsOf: string;
  docReaders: string;
  revisionHistory: string;
  colVersion: string;
  colDate: string;
  colChange: string;
  colAuthor: string;
  firstEdition: string;
  toc: string;
  ch1: string;
  ch2: string;
  ch3: string;
  ch4: string;
  ch5: string;
  ch6: string;
  appendix: string;
  purposeTitle: string;
  purposeText: string;
  readersTitle: string;
  legendTitle: string;
  legendNumber: string;
  legendPath: string;
  legendButton: string;
  legendNote: string;
  accessTitle: string;
  appUrlLabel: string;
  colRole: string;
  colRoleDesc: string;
  colRoleFeatures: string;
  colGroup: string;
  colFeature: string;
  colDesc: string;
  colSection: string;
  colId: string;
  colScreens: string;
  featureRoute: string;
  featureRoles: string;
  featurePreconditions: string;
  featureScreens: string;
  cautionsTitle: string;
  checksTitle: string;
  stepAction: string;
  stepResult: string;
  stepPrecondition: string;
  stepPlatforms: string;
  screenOf: string;
  screenDescription: string;
  captureNote: string;
  colCaution: string;
  contactText: string;
  supportLabel: string;
  ungrouped: string;
  andMore: string;
  none: string;
  page: string;
}
export interface PptxView {
  locale: string;
  generatedAt: string; // ISO datetime
  theme: ResolvedTheme;
  document: PptxDocument;
  roles: PptxRole[];
  groups: PptxGroup[];
  strings: PptxStrings;
}

function face(view: PptxView): string {
  return view.locale.startsWith('ko') ? view.theme.fonts.bodyKo : view.theme.fonts.bodyEn;
}
function headingFace(view: PptxView): string {
  return view.locale.startsWith('ko') ? view.theme.fonts.headingKo : view.theme.fonts.headingEn;
}
function features(view: PptxView): PptxFeature[] {
  return view.groups.flatMap((group) => group.features);
}
function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out.length > 0 ? out : [[]];
}
function firstSentence(text: string): string {
  const m = /^(.*?[.!?。])(\s|$)/u.exec(text.trim());
  return (m ? m[1]! : text.trim()).slice(0, 120);
}

type Draw = (slide: SlideInstance, page: number, total: number) => void;
interface PlannedSlide { chapter?: keyof PptxStrings; draw: Draw }

export async function renderPptxBuffer(view: PptxView): Promise<Buffer> {
  const PptxGenJS = _require('pptxgenjs') as { new (): PptxGenJSInstance };
  const pres = new PptxGenJS();
  pres.layout = 'LAYOUT_16x9';

  const plan = planDeck(view);
  const total = plan.length;
  plan.forEach((planned, index) => planned.draw(pres.addSlide(), index + 1, total));

  const bytes = (await pres.write({ outputType: 'nodebuffer' })) as Buffer;
  return canonicalizeZipBytes(bytes, view.generatedAt);
}

/**
 * Lay the deck out before drawing so the contents slide can print where each
 * chapter starts. Chapters that have nothing to say (no cautions, no contact
 * details) are left out rather than filled with a placeholder.
 */
function planDeck(view: PptxView): PlannedSlide[] {
  const s = view.strings;
  const all = features(view);
  const slides: PlannedSlide[] = [];
  const chapterPage = new Map<keyof PptxStrings, number>();
  const push = (draw: Draw, chapter?: keyof PptxStrings): void => {
    if (chapter && !chapterPage.has(chapter)) chapterPage.set(chapter, slides.length + 1);
    slides.push({ draw, ...(chapter ? { chapter } : {}) });
  };

  push((slide) => drawCover(slide, view));
  push((slide, page, total) => drawDocInfo(slide, view, page, total));
  const tocIndex = slides.length;
  push(() => undefined); // contents — drawn once every chapter page is known
  push((slide, page, total) => drawOverview(slide, view, page, total), 'ch1');
  push((slide, page, total) => drawAccess(slide, view, page, total), 'ch2');
  const menuRows = all.map((feature, index) => ({ feature, number: `4.${index + 1}` }));
  chunk(menuRows, ROWS_PER_SLIDE.menu).forEach((rows, part, parts) => {
    push((slide, page, total) => drawMenu(slide, view, rows, part + 1, parts.length, page, total), 'ch3');
  });
  all.forEach((feature, index) => {
    const number = `4.${index + 1}`;
    push((slide, page, total) => drawFeature(slide, view, feature, number, page, total), 'ch4');
    feature.steps.forEach((step) => {
      push((slide, page, total) => drawStep(slide, view, feature, number, step, page, total), 'ch4');
    });
  });
  const cautionRows = all.flatMap((feature) => feature.cautions.map((rule) => ({ feature, rule })));
  if (cautionRows.length > 0) {
    chunk(cautionRows, ROWS_PER_SLIDE.cautions).forEach((rows, part, parts) => {
      push((slide, page, total) => drawCautions(slide, view, rows, part + 1, parts.length, page, total), 'ch5');
    });
  }
  if (view.document.appUrl || view.document.supportContact) {
    push((slide, page, total) => drawContact(slide, view, page, total), 'ch6');
  }
  chunk(menuRows, ROWS_PER_SLIDE.appendix).forEach((rows, part, parts) => {
    push((slide, page, total) => drawAppendix(slide, view, rows, part + 1, parts.length, page, total), 'appendix');
  });

  slides[tocIndex] = { draw: (slide, page, total) => drawContents(slide, view, chapterPage, page, total) };
  void s;
  return slides;
}

// ---- slides ----

function drawCover(slide: SlideInstance, view: PptxView): void {
  const t = view.theme;
  const d = view.document;
  const hf = headingFace(view);
  const f = face(view);
  if (t.cover.backgroundImagePath) {
    slide.addImage({
      path: t.cover.backgroundImagePath,
      x: 0, y: 0, w: SLIDE_W, h: SLIDE_H, sizing: { type: 'cover', w: SLIDE_W, h: SLIDE_H },
    });
  }
  const bandColor = t.cover.backgroundColor ?? t.colors.accent;
  slide.addShape('rect', {
    x: 0, y: CHROME.coverBandY, w: 0.18, h: CHROME.coverBandH,
    fill: { color: bandColor }, line: { color: bandColor, width: 0 },
  });
  if (d.classification) {
    slide.addText(d.classification, {
      x: 7.9, y: 0.35, w: 1.7, h: 0.32, fontFace: f, fontSize: FONT.coverMeta, bold: true,
      color: t.colors.mutedText, align: 'right', valign: 'middle',
    });
  }
  slide.addText(d.project, {
    x: 0.6, y: CHROME.coverBandY - 0.05, w: 8.8, h: 0.45,
    fontFace: f, fontSize: FONT.coverSubtitle, color: t.colors.mutedText, valign: 'middle',
  });
  slide.addText(d.title, {
    x: 0.6, y: CHROME.coverBandY + 0.45, w: 8.8, h: 0.9,
    fontFace: hf, fontSize: FONT.coverTitle, bold: true, color: t.colors.headerText, valign: 'middle',
  });
  const meta = [`${view.strings.docVersion} ${d.version}`, `${view.strings.docAsOf} ${d.asOf}`]
    .filter((part) => part.trim().length > 0)
    .join('   ·   ');
  slide.addText(meta, {
    x: 0.6, y: CHROME.coverBandY + 1.45, w: 8.8, h: 0.4,
    fontFace: f, fontSize: FONT.coverSubtitle, color: t.colors.bodyText, valign: 'middle',
  });
  if (d.organization) {
    slide.addText(d.organization, {
      x: 0.6, y: 4.5, w: 6, h: 0.35, fontFace: f, fontSize: FONT.coverSubtitle, bold: true,
      color: t.colors.headerText, valign: 'middle',
    });
  }
  slide.addText(`${view.strings.generatedBy} · ${view.generatedAt.slice(0, 10)}`, {
    x: 0.6, y: 4.85, w: 6, h: 0.3, fontFace: f, fontSize: FONT.coverMeta, color: t.colors.mutedText, valign: 'middle',
  });
  drawLogo(slide, view);
}

function drawDocInfo(slide: SlideInstance, view: PptxView, page: number, total: number): void {
  const s = view.strings;
  const d = view.document;
  drawHeader(slide, view, s.docInfo);
  const readers = view.roles.map((role) => role.name).join(', ') || s.none;
  drawKeyValueTable(slide, view, [
    [s.docName, d.title],
    [s.docSystem, d.project],
    [s.docVersion, d.version],
    [s.docAsOf, d.asOf],
    [s.docReaders, readers],
  ], { x: 0.4, y: 1.0, w: 9.2 }, [1.8, 7.4]);
  slide.addText(s.revisionHistory, {
    x: 0.4, y: 3.05, w: 9.2, h: 0.35, fontFace: headingFace(view), fontSize: FONT.body, bold: true,
    color: view.theme.colors.headerText, valign: 'middle',
  });
  drawTable(slide, view, [s.colVersion, s.colDate, s.colChange, s.colAuthor], [
    [d.version, d.asOf, s.firstEdition, ''],
    ['', '', '', ''],
    ['', '', '', ''],
  ], { x: 0.4, y: 3.45, w: 9.2 }, [1.2, 1.8, 4.6, 1.6]);
  drawChrome(slide, view, page, total);
}

function drawContents(
  slide: SlideInstance,
  view: PptxView,
  chapterPage: Map<keyof PptxStrings, number>,
  page: number,
  total: number,
): void {
  const s = view.strings;
  drawHeader(slide, view, s.toc);
  const entries: Array<[keyof PptxStrings, string]> = [
    ['ch1', s.ch1], ['ch2', s.ch2], ['ch3', s.ch3], ['ch4', s.ch4], ['ch5', s.ch5], ['ch6', s.ch6], ['appendix', s.appendix],
  ];
  const rows = entries
    .filter(([key]) => chapterPage.has(key))
    .map(([key, label]) => [label, String(chapterPage.get(key))]);
  const all = features(view);
  const featureRows = all.map((feature, index) => [`   4.${index + 1} ${feature.title}`, '']);
  const left = rows.slice(0, 4);
  const right = rows.slice(4);
  drawPlainRows(slide, view, left, { x: 0.4, y: 1.0, w: 4.4 }, [3.7, 0.7]);
  drawPlainRows(slide, view, right, { x: 5.2, y: 1.0, w: 4.4 }, [3.7, 0.7]);
  const listY = 1.0 + left.length * 0.38 + 0.25;
  const perColumn = Math.max(0, Math.floor((5.05 - listY) / 0.28));
  const capacity = perColumn * 2;
  const shown = featureRows.slice(0, featureRows.length > capacity ? capacity - 1 : capacity);
  const columns = [shown.slice(0, perColumn), shown.slice(perColumn)];
  if (featureRows.length > capacity) {
    columns[1]!.push([`   … ${s.andMore.replace('{n}', String(featureRows.length - shown.length))}`, '']);
  }
  columns.forEach((column, index) => {
    if (column.length === 0) return;
    slide.addText(
      column.map(([label]) => ({ text: label ?? '', options: { breakLine: true } })),
      {
        x: 0.4 + index * 4.8, y: listY, w: 4.4, h: column.length * 0.28, fontFace: face(view), fontSize: FONT.bodySmall,
        color: view.theme.colors.bodyText, valign: 'top', paraSpaceAfter: 1,
      },
    );
  });
  drawChrome(slide, view, page, total);
}

function drawOverview(slide: SlideInstance, view: PptxView, page: number, total: number): void {
  const s = view.strings;
  const t = view.theme;
  const f = face(view);
  drawHeader(slide, view, s.ch1);
  drawSubtitle(slide, view, s.purposeTitle, 1.0);
  slide.addText(s.purposeText.replace('{project}', view.document.project), {
    x: 0.4, y: 1.35, w: 9.2, h: 0.8, fontFace: f, fontSize: FONT.body, color: t.colors.bodyText, valign: 'top',
  });
  drawSubtitle(slide, view, s.readersTitle, 2.2);
  const readers = view.roles.length > 0
    ? view.roles.map((role) => ({
        text: role.description ? `${role.name} — ${role.description}` : role.name,
        options: { bullet: true, breakLine: true },
      }))
    : [{ text: s.none, options: {} }];
  slide.addText(readers, {
    x: 0.4, y: 2.55, w: 9.2, h: 1.0, fontFace: f, fontSize: FONT.bodySmall, color: t.colors.bodyText, valign: 'top',
  });
  drawSubtitle(slide, view, s.legendTitle, 3.6);
  drawTable(slide, view, [], [
    ['①', s.legendNumber],
    ['[메뉴] > [하위 메뉴]', s.legendPath],
    ['「저장」', s.legendButton],
    ['※', s.legendNote],
  ], { x: 0.4, y: 3.95, w: 9.2 }, [2.2, 7.0], { headless: true, fontSize: FONT.bodySmall });
  drawChrome(slide, view, page, total);
}

function drawAccess(slide: SlideInstance, view: PptxView, page: number, total: number): void {
  const s = view.strings;
  const t = view.theme;
  drawHeader(slide, view, s.ch2);
  let y = 1.0;
  if (view.document.appUrl) {
    drawSubtitle(slide, view, s.accessTitle, y);
    slide.addText(`${s.appUrlLabel}  ${view.document.appUrl}`, {
      x: 0.4, y: y + 0.35, w: 9.2, h: 0.4, fontFace: face(view), fontSize: FONT.body, color: t.colors.bodyText, valign: 'middle',
    });
    y += 0.95;
  }
  drawSubtitle(slide, view, s.colRole, y);
  const rows = view.roles.length > 0
    ? view.roles.map((role) => [role.name, role.description || s.none, String(role.featureCount)])
    : [[s.none, '', '']];
  drawTable(slide, view, [s.colRole, s.colRoleDesc, s.colRoleFeatures], rows, { x: 0.4, y: y + 0.35, w: 9.2 }, [2.0, 5.8, 1.4]);
  drawChrome(slide, view, page, total);
}

function drawMenu(
  slide: SlideInstance,
  view: PptxView,
  rows: Array<{ feature: PptxFeature; number: string }>,
  part: number,
  parts: number,
  page: number,
  total: number,
): void {
  const s = view.strings;
  drawHeader(slide, view, parts > 1 ? `${s.ch3} (${part}/${parts})` : s.ch3);
  const groupOf = new Map<string, string>();
  for (const group of view.groups) for (const feature of group.features) groupOf.set(feature.dokId, group.label);
  const grouped = view.groups.length > 1 || (view.groups[0] !== undefined && view.groups[0].label !== s.ungrouped);
  if (grouped) {
    drawTable(slide, view, [s.colSection, s.colGroup, s.colFeature, s.colDesc], rows.map(({ feature, number }) => [
      number, groupOf.get(feature.dokId) ?? s.ungrouped, feature.title, firstSentence(feature.description),
    ]), { x: 0.4, y: 1.0, w: 9.2 }, [0.8, 1.6, 2.2, 4.6]);
  } else {
    drawTable(slide, view, [s.colSection, s.colFeature, s.colDesc], rows.map(({ feature, number }) => [
      number, feature.title, firstSentence(feature.description),
    ]), { x: 0.4, y: 1.0, w: 9.2 }, [0.8, 2.4, 6.0]);
  }
  drawChrome(slide, view, page, total);
}

function drawFeature(
  slide: SlideInstance,
  view: PptxView,
  feature: PptxFeature,
  number: string,
  page: number,
  total: number,
): void {
  const s = view.strings;
  const t = view.theme;
  const f = face(view);
  drawHeader(slide, view, `${number} ${feature.title}`, s.ch4);
  slide.addText(feature.description, {
    x: 0.4, y: 1.0, w: 9.2, h: 0.85, fontFace: f, fontSize: FONT.body, color: t.colors.bodyText, valign: 'top',
  });
  // The section slide is a summary: a few items each, first sentence only,
  // so nothing runs into the footer. The full text is on the screen slides.
  const preconditions = [...new Set(feature.steps.flatMap((step) => step.preconditions ?? []))];
  const preconditionText = preconditions.length === 0
    ? s.none
    : preconditions.slice(0, 3).map(firstSentence).join(' / ')
      + (preconditions.length > 3 ? ` ${s.andMore.replace('{n}', String(preconditions.length - 3))}` : '');
  drawKeyValueTable(slide, view, [
    [s.featureRoute, feature.route ?? s.none],
    [s.featureRoles, feature.roles.join(', ') || s.none],
    [s.featurePreconditions, preconditionText],
    [s.featureScreens, String(feature.steps.length)],
  ], { x: 0.4, y: 1.9, w: 4.4 }, [1.3, 3.1]);
  const colX = 5.1;
  let y = 1.9;
  if (feature.cautions.length > 0) {
    drawSubtitle(slide, view, s.cautionsTitle, y, colX, 4.5);
    const items = feature.cautions.slice(0, 3).map((rule) => ({
      text: `※ ${firstSentence(rule.text)}`, options: { breakLine: true },
    }));
    const h = 0.3 * items.length + 0.5;
    slide.addText(items, {
      x: colX, y: y + 0.33, w: 4.5, h, fontFace: f, fontSize: FONT.bodySmall, color: t.colors.bodyText, valign: 'top',
      paraSpaceAfter: 3,
    });
    y += 0.33 + h + 0.15;
  }
  if (feature.checks.length > 0 && y < 3.9) {
    drawSubtitle(slide, view, s.checksTitle, y, colX, 4.5);
    const room = 5.05 - (y + 0.33);
    const count = Math.max(1, Math.min(2, Math.floor(room / 0.55)));
    const items = feature.checks.slice(0, count).map((check) => ({
      text: firstSentence(check), options: { bullet: true, breakLine: true },
    }));
    slide.addText(items, {
      x: colX, y: y + 0.33, w: 4.5, h: room, fontFace: f, fontSize: FONT.bodySmall,
      color: t.colors.bodyText, valign: 'top', paraSpaceAfter: 3,
    });
  }
  drawChrome(slide, view, page, total);
}

function drawStep(
  slide: SlideInstance,
  view: PptxView,
  feature: PptxFeature,
  number: string,
  step: PptxStep,
  page: number,
  total: number,
): void {
  const t = view.theme;
  const s = view.strings;
  const f = face(view);
  drawHeader(slide, view, `${number} ${feature.title}`, s.ch4);
  slide.addText(`${s.screenOf} ${step.number} / ${feature.steps.length}`, {
    x: REGIONS.badge.x, y: REGIONS.badge.y, w: REGIONS.badge.w, h: REGIONS.badge.h,
    fontFace: f, fontSize: FONT.badge, bold: true, color: t.colors.accent, align: 'right', valign: 'middle',
  });

  const R = REGIONS.screenshot;
  if (step.screenshotPath) {
    const fit = containFit(pngSize(step.screenshotPath), R);
    slide.addImage({
      path: step.screenshotPath, x: fit.x, y: fit.y, w: fit.w, h: fit.h,
      sizing: { type: 'contain', w: fit.w, h: fit.h },
    });
    if (step.annotation) drawAnnotationBox(slide, step, view, fit);
  } else {
    // No screenshot: the screen is described in words, the way text-only
    // manuals do it, and the capture instruction goes to the speaker notes.
    slide.addShape('rect', {
      x: R.x, y: R.y, w: R.w, h: R.h,
      fill: { color: 'F7F7F7' }, line: { color: PLACEHOLDER_BORDER, width: 0.75 },
    });
    slide.addText(s.screenDescription, {
      x: R.x + 0.25, y: R.y + 0.2, w: R.w - 0.5, h: 0.35, fontFace: f, fontSize: FONT.bodySmall, bold: true,
      color: t.colors.mutedText, valign: 'middle',
    });
    const lines: TextRun[] = [
      { text: `${s.stepAction}  `, options: { bold: true, color: t.colors.headerText } },
      { text: step.intent, options: { breakLine: true, color: t.colors.bodyText } },
      { text: `${s.stepResult}  `, options: { bold: true, color: t.colors.headerText } },
      { text: step.outcome, options: { breakLine: true, color: t.colors.bodyText } },
    ];
    if (step.preconditions && step.preconditions.length > 0) {
      lines.push({ text: `${s.stepPrecondition}  `, options: { bold: true, color: t.colors.headerText } });
      lines.push({ text: step.preconditions.join(' / '), options: { breakLine: true, color: t.colors.bodyText } });
    }
    slide.addText(lines, {
      x: R.x + 0.25, y: R.y + 0.6, w: R.w - 0.5, h: R.h - 0.8, fontFace: f, fontSize: FONT.intent, valign: 'top',
      paraSpaceAfter: 8,
    });
    slide.addNotes(`${s.captureNote}: ${feature.dokId}/step-${step.number} — ${step.intent}`);
  }

  // Right column: number badge, actor, intent, outcome, preconditions, platforms.
  const C = REGIONS.rightCol;
  const d = CIRCLE_D;
  if (step.isSystem) {
    slide.addText('⚙', {
      x: C.x, y: C.y, w: d, h: d, fontFace: f, fontSize: FONT.number, color: t.colors.accent, align: 'center', valign: 'middle',
    });
  } else {
    slide.addShape('ellipse', {
      x: C.x, y: C.y, w: d, h: d, fill: { color: t.colors.accent }, line: { color: t.colors.accent, width: 0 },
    });
    slide.addText(String(step.number), {
      x: C.x, y: C.y, w: d, h: d, fontFace: f, fontSize: FONT.number, bold: true, color: 'FFFFFF', align: 'center', valign: 'middle',
    });
  }
  slide.addText(step.isSystem ? s.actorSystem : step.actorLabel, {
    x: C.x + d + 0.1, y: C.y, w: C.w - d - 0.1, h: d, fontFace: f, fontSize: FONT.number, bold: true,
    color: t.colors.accent, valign: 'middle',
  });
  const column: TextRun[] = [
    { text: step.intent, options: { bold: true, fontSize: FONT.intent, color: t.colors.headerText, breakLine: true } },
    { text: `${s.stepResult} `, options: { bold: true, fontSize: FONT.outcome, color: t.colors.mutedText } },
    { text: step.outcome, options: { fontSize: FONT.outcome, color: t.colors.mutedText, breakLine: true } },
  ];
  if (step.preconditions && step.preconditions.length > 0) {
    column.push({ text: `${s.stepPrecondition} `, options: { bold: true, fontSize: FONT.outcome, color: t.colors.mutedText } });
    column.push({ text: step.preconditions.join(' / '), options: { fontSize: FONT.outcome, color: t.colors.mutedText, breakLine: true } });
  }
  if (step.platforms && step.platforms.length > 0) {
    column.push({ text: `${s.stepPlatforms} `, options: { bold: true, fontSize: FONT.outcome, color: t.colors.mutedText } });
    column.push({ text: step.platforms.join(' · '), options: { fontSize: FONT.outcome, color: t.colors.mutedText } });
  }
  slide.addText(column, {
    x: C.x, y: C.y + d + 0.1, w: C.w, h: C.h - d - 0.1, fontFace: f, valign: 'top', paraSpaceAfter: 6,
  });
  drawChrome(slide, view, page, total);
}

function drawCautions(
  slide: SlideInstance,
  view: PptxView,
  rows: Array<{ feature: PptxFeature; rule: PptxRule }>,
  part: number,
  parts: number,
  page: number,
  total: number,
): void {
  const s = view.strings;
  drawHeader(slide, view, parts > 1 ? `${s.ch5} (${part}/${parts})` : s.ch5);
  drawTable(slide, view, [s.colFeature, s.colCaution], rows.map(({ feature, rule }) => [
    feature.title, `※ ${rule.text}`,
  ]), { x: 0.4, y: 1.0, w: 9.2 }, [2.4, 6.8]);
  drawChrome(slide, view, page, total);
}

function drawContact(slide: SlideInstance, view: PptxView, page: number, total: number): void {
  const s = view.strings;
  const t = view.theme;
  const d = view.document;
  drawHeader(slide, view, s.ch6);
  slide.addText(s.contactText, {
    x: 0.4, y: 1.0, w: 9.2, h: 0.6, fontFace: face(view), fontSize: FONT.body, color: t.colors.bodyText, valign: 'top',
  });
  const rows: string[][] = [];
  if (d.appUrl) rows.push([s.appUrlLabel, d.appUrl]);
  if (d.supportContact) rows.push([s.supportLabel, d.supportContact]);
  drawKeyValueTable(slide, view, rows, { x: 0.4, y: 1.7, w: 9.2 }, [1.8, 7.4]);
  drawChrome(slide, view, page, total);
}

function drawAppendix(
  slide: SlideInstance,
  view: PptxView,
  rows: Array<{ feature: PptxFeature; number: string }>,
  part: number,
  parts: number,
  page: number,
  total: number,
): void {
  const s = view.strings;
  drawHeader(slide, view, parts > 1 ? `${s.appendix} (${part}/${parts})` : s.appendix);
  drawTable(slide, view, [s.colSection, s.colFeature, s.colId, s.colScreens], rows.map(({ feature, number }) => [
    number, feature.title, feature.dokId, String(feature.steps.length),
  ]), { x: 0.4, y: 1.0, w: 9.2 }, [0.9, 4.3, 2.8, 1.2]);
  drawChrome(slide, view, page, total);
}

// ---- building blocks ----

function drawHeader(slide: SlideInstance, view: PptxView, title: string, chapter?: string): void {
  const t = view.theme;
  if (chapter) {
    slide.addText(chapter, {
      x: REGIONS.header.x, y: 0.05, w: 6, h: 0.22, fontFace: face(view), fontSize: FONT.chapter,
      color: t.colors.mutedText, valign: 'middle',
    });
  }
  slide.addText(title, {
    x: REGIONS.header.x, y: REGIONS.header.y, w: REGIONS.header.w, h: REGIONS.header.h,
    fontFace: headingFace(view), fontSize: FONT.slideHeader, bold: true, color: t.colors.headerText, valign: 'middle',
  });
  slide.addShape('line', {
    x: REGIONS.header.x, y: REGIONS.header.y + REGIONS.header.h + 0.08, w: REGIONS.header.w, h: 0,
    line: { color: t.colors.accent, width: 1.25 },
  });
}

function drawSubtitle(slide: SlideInstance, view: PptxView, text: string, y: number, x = 0.4, w = 9.2): void {
  slide.addText(text, {
    x, y, w, h: 0.32, fontFace: headingFace(view), fontSize: FONT.body, bold: true,
    color: view.theme.colors.accent, valign: 'middle',
  });
}

function cell(text: string, options: Record<string, unknown>): TableCell {
  return { text, options };
}

function drawTable(
  slide: SlideInstance,
  view: PptxView,
  head: string[],
  rows: string[][],
  box: { x: number; y: number; w: number },
  colW: number[],
  opts: { headless?: boolean; fontSize?: number } = {},
): void {
  const t = view.theme;
  const f = face(view);
  const fontSize = opts.fontSize ?? FONT.table;
  const border = { type: 'solid', pt: 0.5, color: 'C8C8C8' };
  const body = rows.map((row) => row.map((text) => cell(text, {
    fontFace: f, fontSize, color: t.colors.bodyText, border, valign: 'middle', margin: [3, 6, 3, 6],
  })));
  const table = opts.headless || head.length === 0
    ? body
    : [head.map((text) => cell(text, {
        fontFace: f, fontSize: FONT.tableHead, bold: true, color: t.colors.headerText, fill: { color: 'EFEFEF' },
        border, valign: 'middle', margin: [3, 6, 3, 6],
      })), ...body];
  slide.addTable(table, { x: box.x, y: box.y, w: box.w, colW, rowH: 0.3, autoPage: false });
}

function drawKeyValueTable(
  slide: SlideInstance,
  view: PptxView,
  rows: string[][],
  box: { x: number; y: number; w: number },
  colW: number[],
): void {
  const t = view.theme;
  const f = face(view);
  const border = { type: 'solid', pt: 0.5, color: 'C8C8C8' };
  const table = rows.map(([key, value]) => [
    cell(key ?? '', { fontFace: f, fontSize: FONT.table, bold: true, color: t.colors.headerText, fill: { color: 'EFEFEF' }, border, valign: 'middle', margin: [3, 6, 3, 6] }),
    cell(value ?? '', { fontFace: f, fontSize: FONT.table, color: t.colors.bodyText, border, valign: 'middle', margin: [3, 6, 3, 6] }),
  ]);
  slide.addTable(table, { x: box.x, y: box.y, w: box.w, colW, rowH: 0.32, autoPage: false });
}

function drawPlainRows(
  slide: SlideInstance,
  view: PptxView,
  rows: string[][],
  box: { x: number; y: number; w: number },
  colW: number[],
): void {
  if (rows.length === 0) return;
  const t = view.theme;
  const f = face(view);
  const border = { type: 'solid', pt: 0.5, color: 'E0E0E0' };
  const table = rows.map(([label, pageNo]) => [
    cell(label ?? '', { fontFace: f, fontSize: FONT.body, bold: true, color: t.colors.headerText, border: [border, { type: 'none' }, border, { type: 'none' }], valign: 'middle', margin: [4, 4, 4, 4] }),
    cell(pageNo ?? '', { fontFace: f, fontSize: FONT.body, color: t.colors.mutedText, align: 'right', border: [border, { type: 'none' }, border, { type: 'none' }], valign: 'middle', margin: [4, 4, 4, 4] }),
  ]);
  slide.addTable(table, { x: box.x, y: box.y, w: box.w, colW, rowH: 0.38, autoPage: false });
}

function drawLogo(slide: SlideInstance, view: PptxView): void {
  const t = view.theme;
  if (t.logo.assetPath && t.logo.position !== 'none') {
    const h = t.logo.maxHeight;
    const w = h * CHROME.logoRatio;
    const x = t.logo.position === 'top-right'
      ? Math.max(CHROME.margin, SLIDE_W - CHROME.margin - w)
      : CHROME.margin;
    slide.addImage({ path: t.logo.assetPath, x, y: CHROME.logoY, w, h, sizing: { type: 'contain', w, h } });
  }
}

/**
 * Per-slide chrome: logo, footer (organization · project, or the theme's own
 * text), classification in the middle, "page / total" on the right when the
 * theme shows page numbers. Everything is driven by the theme or the document
 * fields; nothing is drawn for an empty value.
 */
function drawChrome(slide: SlideInstance, view: PptxView, pageNumber: number, total: number): void {
  const t = view.theme;
  const d = view.document;
  const f = face(view);
  drawLogo(slide, view);
  const left = t.footer.text || [d.organization, d.project].filter((part) => part.trim().length > 0).join(' · ');
  if (left) {
    slide.addText(left, {
      x: CHROME.margin, y: CHROME.footerY, w: CHROME.footerTextW, h: CHROME.footerH,
      fontFace: f, fontSize: FONT.footer, color: t.colors.mutedText, valign: 'middle',
    });
  }
  if (d.classification) {
    slide.addText(d.classification, {
      x: CHROME.footerCenterX, y: CHROME.footerY, w: CHROME.footerCenterW, h: CHROME.footerH,
      fontFace: f, fontSize: FONT.footer, color: t.colors.mutedText, align: 'center', valign: 'middle',
    });
  }
  if (t.footer.showPageNumber) {
    slide.addText(`${pageNumber} / ${total}`, {
      x: CHROME.pageNumX, y: CHROME.footerY, w: CHROME.pageNumW, h: CHROME.footerH,
      fontFace: f, fontSize: FONT.footer, color: t.colors.mutedText, align: 'right', valign: 'middle',
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
    const h = R.w / imgAR;
    return { x: R.x, y: R.y + (R.h - h) / 2, w: R.w, h };
  }
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
    if (buf.length < 24) return null;
    if (buf.toString('latin1', 1, 4) !== 'PNG') return null;
    return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
  } catch {
    return null;
  }
}
