import ExcelJS from 'exceljs';
import {
  actorLabel,
  resolveTranslatable,
  type Actor,
  type Dok,
  type HubModel,
  type Translatable,
  type TranslateCollector,
} from '@doklo-beta/core';
import { expandAcsRows, expandRuleRows } from '../helpers/aggregations.js';
import { buildHelpCategories } from '../helpers/ia-index.js';
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

/** The top-level IA menu each Dok sits under — the "구분" of a feature list. */
function iaGroups(hub: HubModel, doks: Dok[]): Map<string, Translatable> {
  const out = new Map<string, Translatable>();
  for (const category of buildHelpCategories(hub.services, doks, '.html').categories) {
    for (const entry of category.articles) {
      if (!out.has(entry.dok.dok_id)) out.set(entry.dok.dok_id, category.label);
    }
  }
  return out;
}

function buildRows(kind: XlsxSheet['rows'], doks: Dok[], hub: HubModel): unknown[] {
  const groups = iaGroups(hub, doks);
  const withGroup = <T extends { dok: Dok }>(row: T, i: number) => ({
    ...row,
    index: i + 1,
    ia_group: groups.get(row.dok.dok_id),
  });
  switch (kind) {
    case 'doks':
      return doks.map((dok, i) => withGroup({ dok }, i));
    case 'acs':
      return expandAcsRows(doks).map(withGroup);
    case 'rules':
      return expandRuleRows(doks).map(withGroup);
    case 'steps':
      return doks
        .flatMap((dok) => (dok.user_actions?.steps ?? []).map((step) => ({ dok, step })))
        .map(withGroup);
  }
}

function labelOf(value: unknown, col: XlsxColumn, input: XlsxGenerateInput): string | undefined {
  if (!col.label) return undefined;
  if (typeof value !== 'string' && typeof value !== 'number') return undefined;
  return input.strings(`label_${col.label}_${String(value)}`);
}

function resolveOne(value: unknown, col: XlsxColumn, input: XlsxGenerateInput): string {
  if (col.resolve === 'actor') {
    if (!value || typeof value !== 'object') return '';
    return actorLabel(value as Actor, tCtx(input), input.collector).text;
  }
  if (col.resolve === 'role') {
    const id = String(value ?? '');
    const role = input.hub.roles.roles.find((r) => r.role_id === id);
    if (!role) {
      if (id) input.collector.unresolved.add(id);
      return id;
    }
    return resolveTranslatable(role.name, tCtx(input), input.collector);
  }
  const label = labelOf(value, col, input);
  if (label !== undefined) return label;
  if (col.translate) return resolveTranslatable(value as never, tCtx(input), input.collector);
  if (typeof value === 'string' || typeof value === 'number') return String(value);
  return JSON.stringify(value);
}

function resolveCell(
  row: unknown,
  col: XlsxColumn,
  input: XlsxGenerateInput,
): string | number {
  if (col.blank || !col.value) return '';
  let v = getPath(row, col.value);
  if (v == null) return '';
  if (Array.isArray(v)) {
    if (col.count) return v.length;
    const mapped = col.map ? v.map((el) => getPath(el, col.map!)) : v;
    let texts = mapped.map((el) => resolveOne(el, col, input));
    if (col.unique) texts = texts.filter((text, i) => texts.indexOf(text) === i);
    return texts.join(col.join);
  }
  if (col.resolve || col.label || col.translate) {
    return resolveOne(v, col, input);
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

function styleHeaderCell(cell: ExcelJS.Cell, fill: string): void {
  cell.font = { bold: true };
  cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: fill } };
  cell.border = THIN_BORDER;
  cell.alignment = { horizontal: 'center', vertical: 'middle', wrapText: true };
}

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
    const rows = buildRows(sheet.rows, input.doks, input.hub);

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

    // Header band — one tier normally, two tiers when any column declares a
    // group (감리 양식의 단계별 병합 머리글). Ungrouped columns span both tiers.
    const hasGroups = sheet.columns.some((c) => c.group);
    let headerRowIdx: number;
    if (hasGroups) {
      const groupRowIdx = cursor;
      const colRowIdx = cursor + 1;
      let ci = 0;
      while (ci < colCount) {
        const col = sheet.columns[ci]!;
        if (col.group) {
          let end = ci;
          while (end + 1 < colCount && sheet.columns[end + 1]!.group === col.group) {
            end += 1;
          }
          if (end > ci) ws.mergeCells(groupRowIdx, ci + 1, groupRowIdx, end + 1);
          ws.getCell(groupRowIdx, ci + 1).value =
            input.strings(`group_${col.group}`) ?? col.group;
          for (let k = ci; k <= end; k += 1) {
            styleHeaderCell(ws.getCell(groupRowIdx, k + 1), sheet.header_fill);
            const key = sheet.columns[k]!.key;
            const colCell = ws.getCell(colRowIdx, k + 1);
            colCell.value = input.strings(`col_${key}`) ?? key;
            styleHeaderCell(colCell, sheet.header_fill);
          }
          ci = end + 1;
        } else {
          ws.mergeCells(groupRowIdx, ci + 1, colRowIdx, ci + 1);
          ws.getCell(groupRowIdx, ci + 1).value =
            input.strings(`col_${col.key}`) ?? col.key;
          styleHeaderCell(ws.getCell(groupRowIdx, ci + 1), sheet.header_fill);
          styleHeaderCell(ws.getCell(colRowIdx, ci + 1), sheet.header_fill);
          ci += 1;
        }
      }
      ws.getRow(groupRowIdx).height = 20;
      ws.getRow(colRowIdx).height = 22;
      headerRowIdx = colRowIdx;
      cursor = colRowIdx + 1;
    } else {
      headerRowIdx = cursor;
      for (const [ci, col] of sheet.columns.entries()) {
        const cell = ws.getCell(cursor, ci + 1);
        cell.value = input.strings(`col_${col.key}`) ?? col.key;
        styleHeaderCell(cell, sheet.header_fill);
      }
      ws.getRow(cursor).height = 22;
      cursor += 1;
    }

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
