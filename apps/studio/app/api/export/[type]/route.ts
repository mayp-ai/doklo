import ExcelJS from 'exceljs';
import { type NextRequest } from 'next/server';
import { loadAllDoks, translatable } from '../../../../lib/data';

export const dynamic = 'force-dynamic';

interface Params {
  params: Promise<{ type: string }>;
}

export async function GET(_req: NextRequest, { params }: Params) {
  const { type } = await params;
  if (type !== 'feature-spec') {
    return new Response('Unsupported spoke type', { status: 404 });
  }

  const doks = await loadAllDoks();
  const wb = new ExcelJS.Workbook();
  wb.creator = 'Doklo Studio';
  wb.created = new Date();

  // ── Sheet 1: feature-spec summary ─────────────────────────────
  const summary = wb.addWorksheet('Feature spec');
  summary.columns = [
    { header: 'ID', key: 'id', width: 14 },
    { header: 'Name', key: 'name', width: 24 },
    { header: 'Status', key: 'status', width: 12 },
    { header: 'Service', key: 'surfaces', width: 16 },
    { header: 'Tags', key: 'tags', width: 20 },
    { header: 'Description', key: 'description', width: 64 },
    { header: 'Steps', key: 'steps', width: 8 },
    { header: 'Rules', key: 'rules', width: 8 },
    { header: 'AC', key: 'ac', width: 8 },
    { header: 'Version', key: 'version', width: 8 },
    { header: 'updated_at', key: 'updated', width: 24 },
  ];
  summary.getRow(1).font = { bold: true };
  summary.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEF1F4' },
  };
  summary.views = [{ state: 'frozen', ySplit: 1 }];

  for (const d of doks) {
    summary.addRow({
      id: d.dok_id,
      name: translatable(d.name),
      status: d.status,
      surfaces: d.surfaces.join(', '),
      tags: d.tags.join(', '),
      description: translatable(d.description),
      steps: d.user_actions?.steps.length ?? 0,
      rules: d.business_rules?.rules.length ?? 0,
      ac: d.acceptance_criteria?.criteria.length ?? 0,
      version: d._meta.version,
      updated: d._meta.updated_at ?? '',
    });
  }

  // ── Sheet 2: User Actions (flattened steps across all Doks) ────
  const actions = wb.addWorksheet('User Actions');
  actions.columns = [
    { header: 'Dok ID', key: 'dok', width: 14 },
    { header: '#', key: 'order', width: 6 },
    { header: 'Actor', key: 'actor', width: 18 },
    { header: 'Intent', key: 'intent', width: 56 },
    { header: 'Outcome', key: 'outcome', width: 56 },
    { header: 'Preconditions', key: 'preconditions', width: 40 },
    { header: 'Variants', key: 'variants', width: 32 },
  ];
  actions.getRow(1).font = { bold: true };
  actions.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEF1F4' },
  };
  actions.views = [{ state: 'frozen', ySplit: 1 }];

  for (const d of doks) {
    const steps = d.user_actions?.steps ?? [];
    for (const s of steps) {
      const actorStr =
        s.actor.kind === 'role'
          ? `role:${s.actor.role_ref}`
          : s.actor.kind === 'system'
            ? 'system'
            : `external:${s.actor.label}`;
      actions.addRow({
        dok: d.dok_id,
        order: s.order,
        actor: actorStr,
        intent: translatable(s.intent),
        outcome: translatable(s.outcome),
        preconditions: (s.preconditions ?? []).join('; '),
        variants: s.variants.map((v) => `${v.platform}:${v.interaction}`).join(', '),
      });
    }
  }

  // ── Sheet 3: Business Rules ────────────────────────────────
  const rules = wb.addWorksheet('Business Rules');
  rules.columns = [
    { header: 'Dok ID', key: 'dok', width: 14 },
    { header: 'Rule ID', key: 'id', width: 20 },
    { header: 'Type', key: 'type', width: 14 },
    { header: 'Description', key: 'desc', width: 64 },
    { header: 'Applies to roles', key: 'roles', width: 28 },
  ];
  rules.getRow(1).font = { bold: true };
  rules.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEF1F4' },
  };
  rules.views = [{ state: 'frozen', ySplit: 1 }];

  for (const d of doks) {
    const rs = d.business_rules?.rules ?? [];
    for (const r of rs) {
      rules.addRow({
        dok: d.dok_id,
        id: r.id,
        type: r.type,
        desc: translatable(r.description),
        roles: (r.applies_to_roles ?? []).join(', '),
      });
    }
  }

  // ── Sheet 4: Acceptance Criteria ───────────────────────────
  const ac = wb.addWorksheet('Acceptance Criteria');
  ac.columns = [
    { header: 'Dok ID', key: 'dok', width: 14 },
    { header: 'AC ID', key: 'id', width: 20 },
    { header: 'Statement', key: 'stmt', width: 72 },
    { header: 'Related rules', key: 'related', width: 28 },
  ];
  ac.getRow(1).font = { bold: true };
  ac.getRow(1).fill = {
    type: 'pattern',
    pattern: 'solid',
    fgColor: { argb: 'FFEEF1F4' },
  };
  ac.views = [{ state: 'frozen', ySplit: 1 }];

  for (const d of doks) {
    const cs = d.acceptance_criteria?.criteria ?? [];
    for (const c of cs) {
      ac.addRow({
        dok: d.dok_id,
        id: c.id,
        stmt: translatable(c.statement),
        related: c.related_rules.join(', '),
      });
    }
  }

  const buffer = await wb.xlsx.writeBuffer();
  const today = new Date().toISOString().split('T')[0];

  return new Response(buffer, {
    headers: {
      'Content-Type':
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="feature-spec-${today}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
