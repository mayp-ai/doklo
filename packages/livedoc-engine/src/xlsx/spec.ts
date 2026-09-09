import { z } from 'zod';

/**
 * Declarative spreadsheet spec — `sheet.yaml` in an xlsx template directory.
 *
 * Templates stay data (like the pptx theme.yaml): the engine owns the
 * deterministic row joins (`rows` generators) and rendering; the template
 * declares which rows, which columns, and how cells resolve. No code in
 * templates, no LLM at render time.
 */

export const XlsxColumnSchema = z.object({
  /** Header label = strings[`col_${key}`] (locale-resolved), fallback: key. */
  key: z.string().min(1),
  /** Dot-path into the row object, e.g. "dok.dok_id" or "criterion.statement". */
  value: z.string().min(1),
  /** Column width in Excel character units. */
  width: z.number().positive().default(18),
  /** Resolve the value as a Translatable (string | TermRef | locale map). */
  translate: z.boolean().default(false),
  /** When the value is an array: subpath applied to each element before join. */
  map: z.string().optional(),
  /** Array join separator. */
  join: z.string().default(', '),
  /** Render the array length instead of its contents. */
  count: z.boolean().default(false),
  /** Horizontal alignment. */
  align: z.enum(['left', 'center', 'right']).default('left'),
});

export const XlsxSheetSchema = z.object({
  /** Tab label strings key (fallback: literal `name` or "Sheet1"). */
  name_key: z.string().optional(),
  name: z.string().optional(),
  /** Deterministic row generator over the selected Doks. */
  rows: z.enum(['doks', 'acs', 'rules']),
  /** Optional merged title row (strings key). */
  title_key: z.string().optional(),
  /**
   * Optional subtitle/meta row (strings key). Supports tokens:
   * {workspace} {date} {count} — workspace name, render date, row count.
   */
  subtitle_key: z.string().optional(),
  /** Header row fill, ARGB hex. Default: the gray of 공공 산출물 표. */
  header_fill: z.string().regex(/^FF[0-9A-Fa-f]{6}$/).default('FFD9D9D9'),
  freeze_header: z.boolean().default(true),
  zebra: z.boolean().default(false),
  columns: z.array(XlsxColumnSchema).min(1),
});

export const XlsxSpecSchema = z.object({
  sheets: z.array(XlsxSheetSchema).min(1),
});

export type XlsxColumn = z.infer<typeof XlsxColumnSchema>;
export type XlsxSheet = z.infer<typeof XlsxSheetSchema>;
export type XlsxSpec = z.infer<typeof XlsxSpecSchema>;

export function parseXlsxSpec(raw: unknown): XlsxSpec {
  return XlsxSpecSchema.parse(raw);
}
