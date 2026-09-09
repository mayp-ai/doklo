import { describe, it, expect } from 'vitest';
import type { ModelsDb } from '@doklo-beta/generator';
import {
  setRoleModel,
  buildProviderChoices,
  buildModelChoices,
  toModelOption,
} from '../src/commands/model.js';
import { modelGuidance } from '../src/lib/model-guidance.js';
import type { I18nT } from '../src/lib/i18n.js';

// Small fixture db: two builtin providers (anthropic, openai) plus a
// non-builtin one (mistral) that must be filtered out of provider choices.
// anthropic has a richer model set to exercise filter + sort logic.
const fixtureDb: ModelsDb = {
  anthropic: {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    models: {
      // Newer dated text model
      'claude-sonnet-4-5': {
        id: 'claude-sonnet-4-5',
        name: 'Claude Sonnet 4.5',
        release_date: '2025-07-01',
        modalities: { input: ['text'], output: ['text'] },
      },
      // Older dated text model
      'claude-haiku-4-5': {
        id: 'claude-haiku-4-5',
        name: 'Claude Haiku 4.5',
        release_date: '2025-01-15',
        modalities: { input: ['text'], output: ['text'] },
      },
      // Undated text model — no release_date/last_updated
      'claude-legacy': {
        id: 'claude-legacy',
        name: 'Claude Legacy',
        modalities: { input: ['text'], output: ['text'] },
      },
      // Non-text (embedding) model — must be filtered out
      'claude-embed': {
        id: 'claude-embed',
        name: 'Claude Embeddings',
        modalities: { input: ['text'], output: ['embedding'] },
      },
    },
  },
  openai: {
    id: 'openai',
    name: 'OpenAI',
    env: ['OPENAI_API_KEY'],
    models: {
      'gpt-4o': { id: 'gpt-4o', name: 'GPT-4o' },
    },
  },
  mistral: {
    id: 'mistral',
    name: 'Mistral',
    env: ['MISTRAL_API_KEY'],
    models: {
      'mistral-large': { id: 'mistral-large', name: 'Mistral Large' },
    },
  },
};

describe('setRoleModel', () => {
  it('sets the default role model immutably', () => {
    const before = { models: {} };
    const after = setRoleModel(before, 'default', 'anthropic/claude-sonnet-4-5');
    expect(after.models['default']?.primary).toBe('anthropic/claude-sonnet-4-5');
    expect(before.models['default']).toBeUndefined(); // not mutated
  });
  it('sets a per-task role model', () => {
    const after = setRoleModel({ models: {} }, 'consolidate', 'anthropic/claude-haiku-4-5');
    expect(after.models['consolidate']?.primary).toBe('anthropic/claude-haiku-4-5');
  });
});

describe('modelGuidance', () => {
  it('warns for a measured-poor model (exact ref)', () => {
    const g = modelGuidance('anthropic/claude-haiku-4-5', undefined);
    expect(g.tier).toBe('warned');
    expect(g.messageKey).toBe('model.warn_measured');
  });

  it('warns for a measured-poor model via dated-suffix prefix match', () => {
    const g = modelGuidance('anthropic/claude-haiku-4-5-20251001', { input: 1, output: 5 });
    expect(g.tier).toBe('warned');
    expect(g.messageKey).toBe('model.warn_measured');
  });

  it('warns a measured-poor model even when its price is ABOVE the weak threshold', () => {
    // The whole point of the benchmark override: haiku's output price is above
    // $2/1M, so the price-proxy would miss it — the WARNED list still catches it.
    const g = modelGuidance('anthropic/claude-haiku-4-5', { input: 1, output: 5 });
    expect(g.tier).toBe('warned');
  });

  it('recommends claude-sonnet-5 with its hint key', () => {
    const g = modelGuidance('anthropic/claude-sonnet-5', undefined);
    expect(g.tier).toBe('recommended');
    expect(g.messageKey).toBe('model.rec_sonnet5');
  });

  it('recommends the other benchmark picks with their hint keys', () => {
    expect(modelGuidance('anthropic/claude-opus-4-8', undefined).messageKey).toBe('model.rec_opus48');
    expect(modelGuidance('openai/gpt-5.6-sol', undefined).messageKey).toBe('model.rec_sol');
    expect(modelGuidance('openai/gpt-5.6-luna', undefined).messageKey).toBe('model.rec_luna');
  });

  it('recommends via prefix match on a dated snapshot id', () => {
    const g = modelGuidance('anthropic/claude-sonnet-5-20260101', { input: 3, output: 15 });
    expect(g.tier).toBe('recommended');
    expect(g.messageKey).toBe('model.rec_sonnet5');
  });

  it('flags an UNMEASURED cheap model with the weak-price fallback', () => {
    const g = modelGuidance('someco/tiny-model', { input: 0.1, output: 0.5 });
    expect(g.tier).toBe('neutral');
    expect(g.messageKey).toBe('model.weak_warning');
  });

  it('stays neutral + silent for an unmeasured frontier-priced model', () => {
    const g = modelGuidance('someco/frontier-model', { input: 3, output: 15 });
    expect(g.tier).toBe('neutral');
    expect(g.messageKey).toBeNull();
  });

  it('stays neutral + silent for an unmeasured model with unknown cost', () => {
    const g = modelGuidance('someco/unknown-model', undefined);
    expect(g.tier).toBe('neutral');
    expect(g.messageKey).toBeNull();
  });
});

describe('toModelOption', () => {
  // Identity translator: returns the key so we can assert which hint was chosen.
  const t: I18nT = (key) => key;

  it('prefixes a ★ marker and sets the hint for a recommended model', () => {
    const opt = toModelOption({ title: 'Claude Sonnet 5', value: 'anthropic/claude-sonnet-5' }, t);
    expect(opt.label.startsWith('★ ')).toBe(true);
    expect(opt.label).toContain('Claude Sonnet 5');
    expect(opt.hint).toBe('model.rec_sonnet5');
  });

  it('prefixes a ⚠ marker and no hint for a warned model', () => {
    const opt = toModelOption({ title: 'Claude Haiku 4.5', value: 'anthropic/claude-haiku-4-5' }, t);
    expect(opt.label.startsWith('⚠ ')).toBe(true);
    expect(opt.hint).toBeUndefined();
  });

  it('leaves a neutral model untouched (no marker, no hint)', () => {
    const opt = toModelOption({ title: 'GPT-4o', value: 'openai/gpt-4o' }, t);
    expect(opt.label).toBe('GPT-4o');
    expect(opt.hint).toBeUndefined();
  });
});

describe('buildProviderChoices', () => {
  it('returns one entry per curated builtin provider present in the db', () => {
    const choices = buildProviderChoices(fixtureDb);
    const values = choices.map((c) => c.value);
    // anthropic + openai are builtins present in the fixture; mistral is not builtin.
    expect(values).toContain('anthropic');
    expect(values).toContain('openai');
    expect(values).not.toContain('mistral'); // not a curated builtin
    expect(values).not.toContain('openrouter'); // builtin but absent from db
    expect(values).not.toContain('google'); // builtin but absent from db
    expect(choices).toHaveLength(2);
  });
  it('titles each provider with id and the models.dev display name', () => {
    const choices = buildProviderChoices(fixtureDb);
    const anthropic = choices.find((c) => c.value === 'anthropic');
    expect(anthropic?.title).toContain('anthropic');
    expect(anthropic?.title).toContain('Anthropic');
  });
});

describe('buildModelChoices', () => {
  it('filters out non-text-output models (embeddings, audio, etc.)', () => {
    const choices = buildModelChoices(fixtureDb, 'anthropic');
    const values = choices.map((c) => c.value);
    expect(values).not.toContain('anthropic/claude-embed');
  });

  it('sorts newer-dated models before older-dated models', () => {
    const choices = buildModelChoices(fixtureDb, 'anthropic');
    const values = choices.map((c) => c.value);
    const sonnetIdx = values.indexOf('anthropic/claude-sonnet-4-5');
    const haikuIdx = values.indexOf('anthropic/claude-haiku-4-5');
    expect(sonnetIdx).toBeGreaterThanOrEqual(0);
    expect(haikuIdx).toBeGreaterThanOrEqual(0);
    expect(sonnetIdx).toBeLessThan(haikuIdx); // newer first
  });

  it('sorts undated models after all dated models', () => {
    const choices = buildModelChoices(fixtureDb, 'anthropic');
    const values = choices.map((c) => c.value);
    const legacyIdx = values.indexOf('anthropic/claude-legacy');
    const haikuIdx = values.indexOf('anthropic/claude-haiku-4-5'); // oldest dated
    expect(legacyIdx).toBeGreaterThan(haikuIdx);
  });

  it('returns exactly the three text-output models in order', () => {
    const choices = buildModelChoices(fixtureDb, 'anthropic');
    expect(choices).toEqual([
      { title: 'Claude Sonnet 4.5', value: 'anthropic/claude-sonnet-4-5' },
      { title: 'Claude Haiku 4.5', value: 'anthropic/claude-haiku-4-5' },
      { title: 'Claude Legacy', value: 'anthropic/claude-legacy' },
    ]);
  });

  it('returns a single entry for a provider with one undated model', () => {
    expect(buildModelChoices(fixtureDb, 'openai')).toEqual([
      { title: 'GPT-4o', value: 'openai/gpt-4o' },
    ]);
  });

  it('returns [] for an unknown provider', () => {
    expect(buildModelChoices(fixtureDb, 'does-not-exist')).toEqual([]);
  });

  it('keeps models with undefined modalities (permissive filter)', () => {
    // gpt-4o has no modalities field at all — must not be filtered
    const choices = buildModelChoices(fixtureDb, 'openai');
    expect(choices.map((c) => c.value)).toContain('openai/gpt-4o');
  });
});

// ---------------------------------------------------------------------------
// Dedupe / alias / image-filter tests (new fixture)
// ---------------------------------------------------------------------------

// Fixture with: alias+dated twin, a newer model, and an image model.
const dedupeFixtureDb: ModelsDb = {
  myprovider: {
    id: 'myprovider',
    name: 'My Provider',
    env: ['MY_API_KEY'],
    models: {
      // Alias entry: name has "(latest)"
      'x-4-5': {
        id: 'x-4-5',
        name: 'X 4.5 (latest)',
        release_date: '2025-11-01',
        modalities: { input: ['text'], output: ['text'] },
      },
      // Dated snapshot twin for x-4-5
      'x-4-5-20251101': {
        id: 'x-4-5-20251101',
        name: 'X 4.5',
        release_date: '2025-11-01',
        modalities: { input: ['text'], output: ['text'] },
      },
      // Newer model (no alias twin)
      'x-4-8': {
        id: 'x-4-8',
        name: 'X 4.8',
        release_date: '2025-12-01',
        modalities: { input: ['text'], output: ['text'] },
      },
      // Image model — must be filtered out by id regex
      'x-image-1': {
        id: 'x-image-1',
        name: 'X Image',
        release_date: '2025-12-15',
        modalities: { input: ['text'], output: ['image'] },
      },
    },
  },
};

describe('buildModelChoices (dedupe + alias + image-filter)', () => {
  it('filters out the image model by id pattern', () => {
    const choices = buildModelChoices(dedupeFixtureDb, 'myprovider');
    const values = choices.map((c) => c.value);
    expect(values).not.toContain('myprovider/x-image-1');
  });

  it('dedupes alias/snapshot pair — keeps the alias (x-4-5), drops dated twin (x-4-5-20251101)', () => {
    const choices = buildModelChoices(dedupeFixtureDb, 'myprovider');
    const values = choices.map((c) => c.value);
    expect(values).toContain('myprovider/x-4-5');
    expect(values).not.toContain('myprovider/x-4-5-20251101');
  });

  it('X 4.5 appears exactly once', () => {
    const choices = buildModelChoices(dedupeFixtureDb, 'myprovider');
    const x45 = choices.filter((c) => c.title === 'X 4.5');
    expect(x45).toHaveLength(1);
  });

  it('strips "(latest)" from the displayed title', () => {
    const choices = buildModelChoices(dedupeFixtureDb, 'myprovider');
    const entry = choices.find((c) => c.value === 'myprovider/x-4-5');
    expect(entry?.title).toBe('X 4.5');
    expect(entry?.title).not.toMatch(/\(latest\)/i);
  });

  it('preserves newest-first order (x-4-8 before x-4-5)', () => {
    const choices = buildModelChoices(dedupeFixtureDb, 'myprovider');
    const values = choices.map((c) => c.value);
    const idx48 = values.indexOf('myprovider/x-4-8');
    const idx45 = values.indexOf('myprovider/x-4-5');
    expect(idx48).toBeGreaterThanOrEqual(0);
    expect(idx45).toBeGreaterThanOrEqual(0);
    expect(idx48).toBeLessThan(idx45);
  });

  it('returns exactly two text models in order: x-4-8, x-4-5', () => {
    const choices = buildModelChoices(dedupeFixtureDb, 'myprovider');
    expect(choices).toEqual([
      { title: 'X 4.8', value: 'myprovider/x-4-8' },
      { title: 'X 4.5', value: 'myprovider/x-4-5' },
    ]);
  });
});
