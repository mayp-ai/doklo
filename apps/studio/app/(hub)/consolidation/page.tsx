import { listConsolidatedServices, loadConsolidatedState } from '../../../lib/data';
import { ConsolidationBoard } from '../../../components/consolidation/consolidation-board';
import { LoadRecovery } from '../../../components/load-recovery';

export const dynamic = 'force-dynamic';

export default async function ConsolidationPage({
  searchParams,
}: {
  searchParams: Promise<{ service?: string }>;
}) {
  const services = await listConsolidatedServices();
  const { service } = await searchParams;
  const active = service && services.includes(service) ? service : services[0];

  if (!active) {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-ink-muted">
        <div>
          <p className="text-sm">No consolidated cache found.</p>
          <p className="mt-1 text-xs">Run <code>doklo consolidate</code> in the terminal to create it.</p>
        </div>
      </div>
    );
  }

  const state = await loadConsolidatedState(active);
  if (state.kind === 'missing') {
    return (
      <div className="flex h-full items-center justify-center p-8 text-center text-ink-muted">
        <div>
          <p className="text-sm">No consolidated cache found for {active}.</p>
          <p className="mt-1 break-all font-mono text-xs">{state.path}</p>
          <p className="mt-1 text-xs">Run <code>doklo consolidate</code> to create it.</p>
        </div>
      </div>
    );
  }
  if (state.kind === 'invalid' || state.kind === 'unreadable') {
    return <LoadRecovery layer="consolidation" state={state} />;
  }

  return (
    <ConsolidationBoard
      key={active}
      initialConfig={state.data}
      initialRevision={state.revision}
      path={state.path}
      services={services}
      activeService={active}
    />
  );
}
