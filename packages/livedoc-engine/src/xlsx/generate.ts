import ExcelJS from 'exceljs';
import {
  resolveTranslatable,
  type Dok,
  type HubModel,
  type TranslateCollector,
} from '@doklo-beta/core';
import { expandAcsRows, expandRuleRows } from '../helpers/aggregations.js';
import type { XlsxColumn, XlsxSheet, XlsxSpec } from './spec.js';
import { canonicalizeZipBytes } from '../canonical-zip.js';

export interface XlsxGenerateInput {
  spec: XlsxSpec;
  doks: Dok[];
  hub: HubModel;
  locale: string;
  primaryLocale: string;
  /** Locale-resolved strings table (already flattened for the active locale chain). */
  strings: (key: string) => string | undefined;
  collector: TranslateCollector;
  /** Render date — injected so callers control determinism in tests. */
  now?: Date;
}

/** Resolve "a.b.c" against an object; undefined-safe. */
function getPath(obj: unknown, path: string): unknown {
  let cur: unknown = obj;
  for (const part of path.split('.')) {
    if (cur == null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function buildRows(kind: XlsxSheet['rows'], doks: Dok[]): unknown[] {
  switch (kind) {
    case 'doks':
      return doks.map((dok, i) => ({ dok, index: i + 1 }));
    case 'acs':
      return expandAcsRows(doks).map((r, i) => ({ ...r, index: i + 1 }));
    case 'rules':
      return expandRuleRows(doks).map((r, i) => ({ ...r, index: i + 1 }));
  }
}

function resolveCell(
  row: unknown,
  col: XlsxColumn,
  input: XlsxGenerateInput,
): string | number {
  let v = getPath(row, col.value);
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (col.count) return v.length;
    const mapped = col.map ? v.map((el) => getPath(el, col.map!)) : v;
    const texts = mapped.map((el) =>
      col.translate
        ? resolveTranslatable(el as never, tCtx(input), input.collector)
        : typeof el === 'string' || typeof el === 'number'
          ? String(el)
          : JSON.stringify(el),
    );
    return texts.join(col.join);
  }
  if (col.translate) {
    return resolveTranslatable(v as never, tCtx(input), input.collector);
  }
  if (typeof v === 'number') return v;
  if (typeof v === 'string') return v;
  return JSON.stringify(v);
}

function tCtx(input: XlsxGenerateInput) {
  return {
    locale: input.locale,
    primaryLocale: input.primaryLocale,
    lexicon: input.hub.lexicon,
    roles: input.hub.roles,
  };
}

const THIN_BORDER: Partial<ExcelJS.Borders> = {
  top: { style: 'thin' },
  left: { style: 'thin' },
  bottom: { style: 'thin' },
  right: { style: 'thin' },
};

/**
 * Build the workbook buffer. Layout per sheet (공공 산출물 표 관행):
 * merged bold title row → optional meta row (right-aligned, small) →
 * filled header row with borders → bordered data rows (wrap, top-aligned).
 */
export async function generateXlsxBuffer(input: XlsxGenerateInput): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Doklo Live Docs';
  const documentDate = input.now ?? new Date();
  wb.created = documentDate;
  wb.modified = documentDate;

  for (const [si, sheet] of input.spec.sheets.entries()) {
    const name =
      (sheet.name_key ? input.strings(sheet.name_key) : undefined) ??
      sheet.name ??
      `Sheet${si + 1}`;
    const ws = wb.addWorksheet(name.slice(0, 31));
    const colCount = sheet.columns.length;
    const rows = buildRows(sheet.rows, input.doks);

    ws.columns = sheet.columns.map((c) => ({ width: c.width }));

    let cursor = 1;
    if (sheet.title_key) {
      const title = input.strings(sheet.title_key) ?? sheet.title_key;
      ws.mergeCells(cursor, 1, cursor, colCount);
      const cell = ws.getCell(cursor, 1);
      cell.value = title;
      cell.font = { bold: true, size: 16 };
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      ws.getRow(cursor).height = 30;
      cursor += 1;
    }
    if (sheet.subtitle_key) {
      const raw = input.strings(sheet.subtitle_key) ?? '';
      const date = (input.now ?? new Date()).toISOString().slice(0, 10);
      const text = raw
        .replaceAll('{workspace}', resolveTranslatable(input.hub.workspace.name as never, tCtx(input), input.collector))
        .replaceAll('{date}', date)
        .replaceAll('{count}', String(rows.length));
      ws.mergeCells(cursor, 1, cursor, colCount);
      const cell = ws.getCell(cursor, 1);
      cell.value = text;
      cell.font = { size: 10, color: { argb: 'FF555555' } };
      cell.alignment = { horizontal: 'right', vertical: 'middle' };
      cursor += 1;
    }

    const headerRowIdx = cursor;
    for (const [ci, col] of sheet.columns.entries()) {
      const cell = ws.getCell(cursor, ci + 1);
      cell.value = input.strings(`col_${col.key}`) ?? col.key;
      cell.font = { bold: true };
      cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: sheet.header_fill } };
      cell.border = THIN_BORDER;
      cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
    }
    ws.getRow(cursor).height = 22;
    cursor += 1;

    for (const [ri, row] of rows.entries()) {
      for (const [ci, col] of sheet.columns.entries()) {
        const cell = ws.getCell(cursor, ci + 1);
        cell.value = resolveCell(row, col, input);
        cell.border = THIN_BORDER;
        cell.alignment = { horizontal: col.align, vertical: 'top', wrapText: true };
        if (sheet.zebra && ri % 2 === 1) {
          cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FFF5F5F5' } };
        }
      }
      cursor += 1;
    }

    if (sheet.freeze_header) {
      ws.views = [{ state: 'frozen', ySplit: headerRowIdx }];
    }
  }

  const buf = await wb.xlsx.writeBuffer();
  return canonicalizeZipBytes(
    Buffer.from(buf as ArrayBuffer),
    documentDate.toISOString(),
  );
}
