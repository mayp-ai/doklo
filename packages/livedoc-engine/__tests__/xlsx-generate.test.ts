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

  it('renders a two-tier grouped header with blank human-entry columns', async () => {
    const spec = parseXlsxSpec({
      sheets: [
        {
          name_key: 'sheet_main',
          rows: 'acs',
          title_key: 'doc_title',
          subtitle_key: 'doc_meta',
          columns: [
            { key: 'req_id', value: 'dok.dok_id', width: 14, group: 'req' },
            { key: 'req_name', value: 'dok.name', width: 24, translate: true, group: 'req' },
            { key: 'screen_id', blank: true, width: 14, group: 'design' },
            { key: 'impl', value: 'anchors', width: 30, group: 'impl' },
            { key: 'tc_id', value: 'criterion.id', width: 16, group: 'test' },
            { key: 'result', blank: true, width: 10, group: 'test' },
            { key: 'remark', blank: true, width: 12 },
          ],
        },
      ],
    });
    const strings: Record<string, string> = {
      ...STRINGS,
      group_req: '요구사항',
      group_design: '설계',
      group_impl: '구현',
      group_test: '시험',
      col_screen_id: '화면 ID',
      col_result: '시험 결과',
      col_remark: '비고',
    };

    const buf = await generateXlsxBuffer({
      spec,
      doks: DOKS,
      hub: HUB,
      locale: 'ko',
      primaryLocale: 'ko',
      strings: (k) => strings[k],
      collector: makeCollector(),
      now: new Date('2026-06-04T00:00:00Z'),
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.getWorksheet('요구사항추적표')!;

    // Row 3 = group tier. Adjacent same-group columns merge horizontally.
    expect(ws.getCell('A3').value).toBe('요구사항');
    expect(ws.getCell('B3').value).toBe('요구사항'); // merged with A3
    expect(ws.getCell('C3').value).toBe('설계');
    expect(ws.getCell('D3').value).toBe('구현');
    expect(ws.getCell('E3').value).toBe('시험');
    expect(ws.getCell('F3').value).toBe('시험'); // merged with E3
    // Ungrouped column spans both header tiers vertically.
    expect(ws.getCell('G3').value).toBe('비고');
    expect(ws.getCell('G4').value).toBe('비고');

    // Row 4 = column tier for grouped columns.
    expect(ws.getCell('A4').value).toBe('요구사항ID');
    expect(ws.getCell('C4').value).toBe('화면 ID');
    expect(ws.getCell('F4').value).toBe('시험 결과');

    // Row 5 = first data row; blank columns stay empty for human entry.
    expect(ws.getCell('A5').value).toBe('AUTH');
    expect(ws.getCell('C5').value).toBe('');
    expect(ws.getCell('F5').value).toBe('');
    expect(ws.getCell('G5').value).toBe('');

    // Freeze includes both header tiers.
    expect(ws.views?.[0]?.state).toBe('frozen');
    expect(ws.views?.[0]?.ySplit).toBe(4);
  });

  it('prints enum labels, Hub role and actor names, unique actors, step rows and the IA group', async () => {
    const doks = [
      {
        dok_id: 'PAY',
        name: '결제하기',
        status: 'active',
        user_actions: {
          steps: [
            { order: 1, actor: { kind: 'role', role_ref: 'ROLE-CUSTOMER' }, intent: '결제 수단 선택', outcome: '결제 창 표시', variants: [] },
            { order: 2, actor: { kind: 'system' }, intent: 'PG 승인 요청', outcome: '승인 결과 수신', variants: [], preconditions: ['결제 수단 선택 완료'] },
            { order: 3, actor: { kind: 'role', role_ref: 'ROLE-CUSTOMER' }, intent: '영수증 확인', outcome: '주문 완료 화면', variants: [] },
          ],
        },
        business_rules: {
          rules: [{ id: 'BR-PAY-01', description: '관리자만 환불 가능', type: 'permission', applies_to_roles: ['ROLE-ADMIN', 'ROLE-UNKNOWN'] }],
        },
        acceptance_criteria: { criteria: [] },
        _meta: { version: 1, history: [] },
      },
      {
        dok_id: 'CART',
        name: '장바구니',
        status: 'draft',
        user_actions: { steps: [] },
        business_rules: { rules: [] },
        acceptance_criteria: { criteria: [] },
        _meta: { version: 1, history: [] },
      },
    ] as unknown as Dok[];
    const hub = {
      ...HUB,
      doks,
      roles: {
        roles: [
          { role_id: 'ROLE-CUSTOMER', name: '고객', kind: 'actor_type', extends: [], scope: 'global' },
          { role_id: 'ROLE-ADMIN', name: '관리자', kind: 'access', extends: [], scope: 'global' },
        ],
      },
      services: [
        {
          service_id: 'web',
          ia: {
            service_id: 'web',
            version: 1,
            trees: [{ tree_id: 'nav', type: 'navigation', platform: 'all', source: 'manual', nodes: [
              { label: '주문', children: [{ label: '결제', dok_ref: 'PAY', children: [] }] },
            ] }],
            edges: [],
          },
        },
      ],
    } as unknown as HubModel;
    const spec = parseXlsxSpec({
      sheets: [
        {
          name: 'features',
          rows: 'doks',
          columns: [
            { key: 'group', value: 'ia_group', translate: true },
            { key: 'id', value: 'dok.dok_id' },
            { key: 'actors', value: 'dok.user_actions.steps', map: 'actor', resolve: 'actor', unique: true, join: ', ' },
            { key: 'status', value: 'dok.status', label: 'status' },
          ],
        },
        {
          name: 'steps',
          rows: 'steps',
          columns: [
            { key: 'id', value: 'dok.dok_id' },
            { key: 'no', value: 'step.order' },
            { key: 'actor', value: 'step.actor', resolve: 'actor' },
            { key: 'pre', value: 'step.preconditions', join: '\n' },
          ],
        },
        {
          name: 'rules',
          rows: 'rules',
          columns: [
            { key: 'id', value: 'rule.id' },
            { key: 'type', value: 'rule.type', label: 'rule_type' },
            { key: 'roles', value: 'rule.applies_to_roles', resolve: 'role', join: ', ' },
          ],
        },
      ],
    });
    const strings: Record<string, string> = {
      label_status_active: '확정',
      label_rule_type_permission: '접근 제어',
    };
    const collector = makeCollector();
    const buf = await generateXlsxBuffer({
      spec, doks, hub, locale: 'ko', primaryLocale: 'ko',
      strings: (key) => strings[key], collector, now: new Date('2026-06-04T00:00:00Z'),
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);

    const features = wb.getWorksheet('features')!;
    // IA group, de-duplicated actor labels (role name + system), enum label.
    expect(features.getCell('A2').value).toBe('주문');
    expect(features.getCell('C2').value).toBe('고객, 시스템');
    expect(features.getCell('D2').value).toBe('확정');
    // A Dok outside the IA tree has no group; a status without a label prints raw.
    expect(features.getCell('A3').value ?? '').toBe('');
    expect(features.getCell('D3').value).toBe('draft');

    const steps = wb.getWorksheet('steps')!;
    expect(steps.actualRowCount).toBe(1 + 3);
    expect(steps.getCell('C3').value).toBe('시스템');
    expect(steps.getCell('D3').value).toBe('결제 수단 선택 완료');

    const rules = wb.getWorksheet('rules')!;
    expect(rules.getCell('B2').value).toBe('접근 제어');
    // Known roles print their names; an unknown id stays as is and is reported.
    expect(rules.getCell('C2').value).toBe('관리자, ROLE-UNKNOWN');
    expect(collector.unresolved.has('ROLE-UNKNOWN')).toBe(true);
  });

  it('rejects a non-blank column without a value path', () => {
    expect(() =>
      parseXlsxSpec({
        sheets: [
          {
            rows: 'doks',
            columns: [{ key: 'oops', width: 10 }],
          },
        ],
      }),
    ).toThrow();
  });
});
