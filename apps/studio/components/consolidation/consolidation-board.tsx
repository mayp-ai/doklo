'use client';
import { useRef, useState } from 'react';
import { Boxes } from 'lucide-react';
import type { ConsolidatedFeatureConfig } from '../../lib/consolidation';
import { countDoks, countDomains, countExcluded } from '../../lib/consolidation-edit';
import {
  useConsolidationReducer,
  type ConsolidationAction,
} from '../../lib/hooks/use-consolidation-reducer';
import { GroupColumn } from './group-column';
import { EditToolbar } from './edit-toolbar';
import { SaveBar } from './save-bar';
import { useSafeNavigation } from '../../lib/hooks/use-safe-navigation';
import {
  ConfirmationDialog,
  type ConfirmationCopy,
} from '../confirmation-dialog';

interface ConfirmationRequest extends ConfirmationCopy {
  returnFocus: HTMLElement;
  onConfirm: () => void;
}

export function ConsolidationBoard({
  initialConfig,
  initialRevision,
  path,
  services,
  activeService,
}: {
  initialConfig: ConsolidatedFeatureConfig;
  initialRevision: string;
  path: string;
  services: string[];
  activeService: string;
}) {
  const { push } = useSafeNavigation();
  const [config, dispatch] = useConsolidationReducer(initialConfig);
  const [dirty, setDirty] = useState(false);
  const [editVersion, setEditVersion] = useState(0);
  const editVersionRef = useRef(0);
  const headingRef = useRef<HTMLHeadingElement>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [selectedGroups, setSelectedGroups] = useState<Set<string>>(new Set());
  const [confirmation, setConfirmation] = useState<ConfirmationRequest | null>(null);

  // Any dispatch that mutates marks the board dirty (reset does not).
  const act = (action: ConsolidationAction) => {
    if (action.type !== 'reset') {
      editVersionRef.current += 1;
      setEditVersion(editVersionRef.current);
      setDirty(true);
    }
    dispatch(action);
  };

  const toggleFeature = (id: string) =>
    setSelected((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  const toggleGroup = (id: string) =>
    setSelectedGroups((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  const requestConfirmation = (
    copy: ConfirmationCopy,
    returnFocus: HTMLElement,
    onConfirm: () => void,
  ) => setConfirmation({ ...copy, returnFocus, onConfirm });

  const onMerge = (trigger: HTMLButtonElement) => {
    if (selectedGroups.size < 2) return;
    requestConfirmation({
      title: 'Merge selected groups?',
      description: 'This replaces the selected group structure in the generation plan and cannot be undone from this screen.',
      confirmLabel: 'Merge groups',
    }, trigger, () => {
      act({ type: 'mergeGroups', groupIds: [...selectedGroups] });
      setSelectedGroups(new Set());
    });
  };
  // Split requires all selected features to share one origin group — enforce
  // it here so a cross-group selection can't silently drop the other group's
  // picks (the toolbar disables the button when this is true).
  const selectedFeatureGroups = new Set(
    config.groups.filter((g) => g.features.some((f) => selected.has(f.canonical_id))).map((g) => g.group_id),
  );
  const splitBlocked = selectedFeatureGroups.size > 1;

  const onSplit = (trigger: HTMLButtonElement) => {
    if (selected.size === 0 || splitBlocked) return;
    const originGroup = config.groups.find((g) => g.features.some((f) => selected.has(f.canonical_id)));
    if (!originGroup) return;
    const ids = originGroup.features.filter((f) => selected.has(f.canonical_id)).map((f) => f.canonical_id);
    requestConfirmation({
      title: 'Split selected Doks?',
      description: `This moves ${ids.length} selected Dok${ids.length === 1 ? '' : 's'} into a new group in the generation plan.`,
      confirmLabel: 'Split Doks',
    }, trigger, () => {
      act({ type: 'splitGroup', groupId: originGroup.group_id, canonicalIds: ids, label: 'New group' });
      setSelected(new Set());
    });
  };

  const switchService = (next: string, select: HTMLSelectElement) => {
    if (next === activeService) return;
    const navigate = () => {
      void push(`?service=${encodeURIComponent(next)}`).then((navigated) => {
        if (!navigated) select.value = activeService;
      });
    };
    if (dirty) {
      select.value = activeService;
      requestConfirmation({
        title: `Save changes and switch to ${next}?`,
        description: `Studio will save the consolidation changes for ${activeService} and only switch after the save succeeds. If saving fails, you will stay on ${activeService} with the error and Retry available.`,
        confirmLabel: 'Save and switch service',
      }, select, navigate);
      return;
    }
    navigate();
  };

  const confirmAction = (
    action: ConsolidationAction,
    copy: ConfirmationCopy,
    trigger: HTMLButtonElement,
  ) => requestConfirmation(copy, trigger, () => act(action));

  return (
    <div className="flex h-full flex-col">
      <header className="border-b border-border bg-canvas px-8 pb-4 pt-6">
        <div className="mb-1 flex items-center gap-2.5">
          <Boxes size={18} aria-hidden className="text-ink-muted" />
          <h1 ref={headingRef} tabIndex={-1} className="text-[22px] font-semibold tracking-tight text-ink-strong">
            Consolidation · Edit generation plan
          </h1>
        </div>
        <p className="max-w-[680px] text-[13.5px] text-ink-muted">
          Organize domain groups and exclude Doks you don&apos;t want to generate. Edits are saved to the cache only; generation is a separate step.
        </p>
        <div className="mt-3.5 flex items-center gap-x-[22px] font-mono text-xs text-ink-muted">
          {services.length > 1 && (
            <label className="inline-flex items-center gap-2">
              Service
              <select
                defaultValue={activeService}
                onChange={(e) => switchService(e.currentTarget.value, e.currentTarget)}
                className="rounded border border-border bg-surface px-2 py-1 text-ink"
              >
                {services.map((s) => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>
          )}
          <span><b className="text-ink">{countDoks(config)}</b> Dok</span>
          <span><b className="text-ink">{countDomains(config)}</b> domains</span>
          <span><b className="text-status-draft-fg">{countExcluded(config)}</b> excluded</span>
          {dirty && <span className="text-accent-ink">● Unsaved</span>}
        </div>
      </header>

      <div className="flex-1 overflow-y-auto px-8 py-6">
        <EditToolbar selectedGroupCount={selectedGroups.size} selectedFeatureCount={selected.size}
          splitBlocked={splitBlocked} onMerge={onMerge} onSplit={onSplit} />
        <div className="grid grid-cols-[repeat(auto-fill,minmax(280px,1fr))] gap-4">
          {config.groups.map((g) => (
            <GroupColumn key={g.group_id} group={g} groups={config.groups} onAct={act}
              onConfirmAct={confirmAction}
              selectedFeatures={selected} onToggleFeature={toggleFeature}
              groupSelected={selectedGroups.has(g.group_id)}
              onToggleSelectGroup={() => toggleGroup(g.group_id)} />
          ))}
        </div>
      </div>
      <SaveBar
        service={activeService}
        config={config}
        dirty={dirty}
        editVersion={editVersion}
        initialRevision={initialRevision}
        path={path}
        onSaved={(savedVersion) => {
          if (savedVersion !== editVersionRef.current) return false;
          setDirty(false);
          return true;
        }}
      />
      {confirmation && (
        <ConfirmationDialog
          title={confirmation.title}
          description={confirmation.description}
          confirmLabel={confirmation.confirmLabel}
          returnFocus={confirmation.returnFocus}
          fallbackFocus={headingRef.current}
          onCancel={() => setConfirmation(null)}
          onConfirm={() => {
            const action = confirmation.onConfirm;
            setConfirmation(null);
            action();
          }}
        />
      )}
    </div>
  );
}
