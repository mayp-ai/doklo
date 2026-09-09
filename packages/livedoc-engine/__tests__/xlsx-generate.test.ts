import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { makeCollector, type Dok, type HubModel } from '@doklo-beta/core';
import { generateXlsxBuffer } from '../src/xlsx/generate.js';
import { parseXlsxSpec } from '../src/xlsx/spec.js';

const DOKS = [
  {
    dok_id: 'AUTH',
    name: '이메일 로그인',
    status: 'active',
    user_actions: { steps: [] },
    business_rules: {
      rules: [{ id: 'BR-1', description: '이메일 형식 검증', type: 'validation' }],
    },
    acceptance_criteria: {
      criteria: [
        { id: 'AC-1', statement: '로그인 성공 시 메인 이동', related_rules: ['BR-1'] },
        { id: 'AC-2', statement: '오류 메시지 표시', related_rules: [] },
      ],
    },
    _meta: { version: 1, history: [], source_anchors: [{ file: 'src/auth.ts' }] },
  },
] as unknown as Dok[];

const HUB = {
  workspace: { name: 'demo-ws', supported_locales: ['ko'], default_locale: 'ko', services: [] },
  doks: DOKS,
  services: [],
  lexicon: { terms: [] },
  roles: { roles: [] },
} as unknown as HubModel;

const SPEC = parseXlsxSpec({
  sheets: [
    {
      name_key: 'sheet_main',
      rows: 'acs',
      title_key: 'doc_title',
      subtitle_key: 'doc_meta',
      columns: [
        { key: 'req_id', value: 'dok.dok_id', width: 14 },
        { key: 'req_name', value: 'dok.name', width: 24, translate: true },
        { key: 'tc_id', value: 'criterion.id', width: 16 },
        { key: 'rules', value: 'rules', map: 'id', width: 18 },
        { key: 'impl', value: 'anchors', width: 30 },
        { key: 'rule_count', value: 'rules', count: true, width: 8 },
      ],
    },
  ],
});

const STRINGS: Record<string, string> = {
  sheet_main: '요구사항추적표',
  doc_title: '요구사항 추적표',
  doc_meta: '{workspace} · {date} · 총 {count}건',
  col_req_id: '요구사항ID',
  col_req_name: '요구사항명',
  col_tc_id: '시험케이스',
  col_rules: '관련 규칙',
  col_impl: '구현 프로그램',
  col_rule_count: '규칙수',
};

describe('generateXlsxBuffer', () => {
  it('produces canonical-identical bytes for identical inputs', async () => {
    const input = () => ({
      spec: SPEC,
      doks: DOKS,
      hub: HUB,
      locale: 'ko',
      primaryLocale: 'ko',
      strings: (key: string) => STRINGS[key],
      collector: makeCollector(),
      now: new Date('2026-06-04T00:00:00Z'),
    });

    const first = await generateXlsxBuffer(input());
    await new Promise((resolve) => setTimeout(resolve, 2_100));
    const second = await generateXlsxBuffer(input());

    expect(second.equals(first)).toBe(true);
  }, 10_000);

  it('builds a styled workbook with title, meta, headers, and joined rows', async () => {
    const buf = await generateXlsxBuffer({
      spec: SPEC,
      doks: DOKS,
      hub: HUB,
      locale: 'ko',
      primaryLocale: 'ko',
      strings: (k) => STRINGS[k],
      collector: makeCollector(),
      now: new Date('2026-06-04T00:00:00Z'),
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('요구사항추적표')!;
    expect(ws).toBeDefined();

    // row 1: merged title; row 2: meta with tokens replaced
    expect(ws.getCell('A1').value).toBe('요구사항 추적표');
    expect(String(ws.getCell('A2').value)).toBe('demo-ws · 2026-06-04 · 총 2건');

    // row 3: header labels from strings
    expect(ws.getCell('A3').value).toBe('요구사항ID');
    expect(ws.getCell('E3').value).toBe('구현 프로그램');

    // row 4: first AC row — translate, array map+join, count
    expect(ws.getCell('A4').value).toBe('AUTH');
    expect(ws.getCell('B4').value).toBe('이메일 로그인');
    expect(ws.getCell('C4').value).toBe('AC-1');
    expect(ws.getCell('D4').value).toBe('BR-1');
    expect(ws.getCell('E4').value).toBe('src/auth.ts');
    expect(ws.getCell('F4').value).toBe(1);

    // row 5: second AC with no rules
    expect(ws.getCell('C5').value).toBe('AC-2');
    expect(ws.getCell('D5').value).toBe('');
    expect(ws.getCell('F5').value).toBe(0);

    // header row frozen
    expect(ws.views?.[0]?.state).toBe('frozen');
  });
});
