// @doklo-beta/generator — LLM-based Dok generation infrastructure.
//
// This package owns:
// - llm-client    : provider-agnostic LLM client (Vercel AI SDK) with auto-debug saving
// - validate      : LLM response → v5 schema validation
// - (next) consolidator: feature consolidation (LLM-driven domain grouping)
// - (next) prompts: prompt templates per default_locale (en/ko)

export * from './llm-client.js';
export * from './models-registry.js';
export * from './validate.js';
export * from './dok-id-prefix.js';
export * from './id-reconciliation.js';
export * from './consolidator.js';
export * from './ir-to-features.js';
export * from './feature-id.js';
export * from './consolidated-cache.js';
export * from './dok-generator.js';
export * from './lexicon-suggester.js';
export * from './derive-service-meta.js';
export * from './ia-sitemap.js';
export * from './ia-merge.js';
export * from './ia-migrate.js';
export * from './trust-gate.js';
export * from './priority-detectors.js';
export * from './priority-merge.js';
export * from './feature-accounting.js';
export * from './path-containment.js';
export { ConsolidatedFeatureConfigSchema } from './legacy-types.js';
export type * from './legacy-types.js';

export const GENERATOR_VERSION = '0.2.0';
