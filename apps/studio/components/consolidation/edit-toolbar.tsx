'use client';
import { Combine, SplitSquareHorizontal } from 'lucide-react';

export function EditToolbar({
  selectedGroupCount, selectedFeatureCount, splitBlocked, onMerge, onSplit,
}: {
  selectedGroupCount: number;
  selectedFeatureCount: number;
  /** True when the feature selection spans >1 group — split is disabled. */
  splitBlocked: boolean;
  onMerge: (trigger: HTMLButtonElement) => void;
  onSplit: (trigger: HTMLButtonElement) => void;
}) {
  return (
    <div className="mb-4 flex items-center gap-2">
      <button type="button" disabled={selectedGroupCount < 2} onClick={(event) => onMerge(event.currentTarget)}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-ink enabled:hover:bg-surface disabled:opacity-40">
        <Combine size={14} aria-hidden /> Merge selected groups ({selectedGroupCount})
      </button>
      <button type="button" disabled={selectedFeatureCount < 1 || splitBlocked} onClick={(event) => onSplit(event.currentTarget)}
        title={splitBlocked ? 'You can only split Doks that share one group' : undefined}
        className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-[12.5px] text-ink enabled:hover:bg-surface disabled:opacity-40">
        <SplitSquareHorizontal size={14} aria-hidden /> Split selected Doks ({selectedFeatureCount})
        {splitBlocked && <span className="text-ink-faint"> · one group only</span>}
      </button>
    </div>
  );
}
