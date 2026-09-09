'use client';
import { useReducer } from 'react';
import type { ConsolidatedFeatureConfig } from '../consolidation';
import {
  renameGroup, mergeGroups, splitGroup, moveFeature,
  toggleExcludeFeature, excludeGroup, newGroupId, setDokIdPrefix,
} from '../consolidation-edit';

export type ConsolidationAction =
  | { type: 'reset'; config: ConsolidatedFeatureConfig }
  | { type: 'renameGroup'; groupId: string; label: string }
  | { type: 'mergeGroups'; groupIds: string[]; label?: string }
  | { type: 'splitGroup'; groupId: string; canonicalIds: string[]; label: string }
  | { type: 'moveFeature'; canonicalId: string; toGroupId: string }
  | { type: 'toggleExclude'; canonicalId: string }
  | { type: 'excludeGroup'; groupId: string; exclude: boolean }
  | { type: 'editDokIdPrefix'; canonicalId: string; dokIdPrefix: string };

export function consolidationReducer(
  state: ConsolidatedFeatureConfig,
  action: ConsolidationAction,
): ConsolidatedFeatureConfig {
  switch (action.type) {
    case 'reset': return action.config;
    case 'renameGroup': return renameGroup(state, action.groupId, action.label);
    case 'mergeGroups': return mergeGroups(state, action.groupIds, action.label);
    case 'splitGroup':
      return splitGroup(state, action.groupId, action.canonicalIds, {
        group_id: newGroupId(state), label: action.label,
      });
    case 'moveFeature': return moveFeature(state, action.canonicalId, action.toGroupId);
    case 'toggleExclude': return toggleExcludeFeature(state, action.canonicalId);
    case 'excludeGroup': return excludeGroup(state, action.groupId, action.exclude);
    case 'editDokIdPrefix': return setDokIdPrefix(state, action.canonicalId, action.dokIdPrefix);
    default: return state;
  }
}

export function useConsolidationReducer(initial: ConsolidatedFeatureConfig) {
  return useReducer(consolidationReducer, initial);
}
