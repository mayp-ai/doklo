import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rename,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { LexiconTerm, Role } from '@doklo-beta/core';
import { z } from 'zod';
import { revisionOf } from '../lib/load-state';
import { writeJsonForMutation } from '../lib/persistence';
import {
  acceptLexiconSuggestionAction,
  bulkActivateDoksAction,
  createLexiconTermAction,
  deleteLexiconTermAction,
  deleteRoleAction,
  rejectLexiconSuggestionAction,
  saveConsolidatedAction,
  saveDokAction,
  saveOwnedLexiconLocaleAction,
  saveRoleAction,
  upsertLexiconTermAction,
  upsertRoleAction,
} from '../lib/actions';
import { historyClock } from '../lib/history-clock';

const atomicFault = vi.hoisted(() => ({ pathPart: null as string | null }));

vi.mock('@doklo-beta/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@doklo-beta/core')>();
  return {
    ...actual,
    writeFileAtomic: async (...args: Parameters<typeof actual.writeFileAtomic>) => {
      if (
        atomicFault.pathPart !== null &&
        String(args[0]).includes(atomicFault.pathPart)
      ) {
        throw Object.assign(new Error('permission denied by deterministic test fault'), {
          code: 'EACCES',
        });
      }
      return actual.writeFileAtomic(...args);
    },
  };
});

const DEMO = fileURLToPath(new URL('../demo', import.meta.url));
const originalRoot = process.env.DOKLO_WORKSPACE_ROOT;
const scratchRoots: string[] = [];

async function scratchWorkspace(): Promise<string> {
  const dir = await realpath(
    await mkdtemp(join(tmpdir(), 'doklo-studio-actions-')),
  );
  scratchRoots.push(dir);
  await cp(DEMO, dir, { recursive: true });
  process.env.DOKLO_WORKSPACE_ROOT = dir;
  return dir;
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, 'utf-8')) as T;
}

async function bytesAndRevision(path: string): Promise<{
  bytes: string;
  revision: string;
}> {
  const bytes = await readFile(path, 'utf-8');
  return { bytes, revision: revisionOf(bytes) };
}

const originalAuthor = process.env.DOKLO_AUTHOR;
beforeEach(() => {
  process.env.DOKLO_AUTHOR = 'tester';
});

afterEach(async () => {
  atomicFault.pathPart = null;
  historyClock.now = () => new Date();
  if (originalAuthor === undefined) delete process.env.DOKLO_AUTHOR;
  else process.env.DOKLO_AUTHOR = originalAuthor;
  if (originalRoot === undefined) delete process.env.DOKLO_WORKSPACE_ROOT;
  else process.env.DOKLO_WORKSPACE_ROOT = originalRoot;
  await Promise.all(scratchRoots.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('saveDokAction', () => {
  it('saves a schema-valid Dok through its exact loaded noncanonical filename', async () => {
    const dir = await scratchWorkspace();
    const canonicalPath = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const exactPath = join(dir, '.doklo', 'hub', 'doks', 'authentication-context.json');
    await rename(canonicalPath, exactPath);
    const before = await bytesAndRevision(exactPath);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'saved through the loaded path' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.path).toBe(exactPath);
    expect((await readJson<Record<string, unknown>>(exactPath)).description)
      .toBe('saved through the loaded path');
    await expect(readFile(canonicalPath, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails the whole catalog on duplicate Dok identity before mutating either file', async () => {
    const dir = await scratchWorkspace();
    const canonicalPath = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const duplicatePath = join(dir, '.doklo', 'hub', 'doks', 'duplicate-auth.json');
    const before = await bytesAndRevision(canonicalPath);
    await writeFile(duplicatePath, before.bytes, 'utf-8');

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'must not choose one duplicate' },
      expectedRevision: before.revision,
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID',
      path: duplicatePath,
      preserved: true,
    });
    expect(await readFile(canonicalPath, 'utf-8')).toBe(before.bytes);
    expect(await readFile(duplicatePath, 'utf-8')).toBe(before.bytes);
  });

  it('applies only the narrow patch, marks the Dok, and preserves unknown fields recursively', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const current = await readJson<Record<string, unknown>>(path);
    const seeded = {
      ...current,
      server_extension: { retained: true },
      user_actions: {
        ...(current.user_actions as Record<string, unknown>),
        server_nested: { retained: 'yes' },
      },
    };
    await writeFile(path, JSON.stringify(seeded, null, 2) + '\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'edited via narrow patch' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    expect(result.path).toBe(path);
    const after = await readFile(path, 'utf-8');
    expect(result.revision).toBe(revisionOf(after));
    const saved = JSON.parse(after) as Record<string, any>;
    expect(saved.description).toBe('edited via narrow patch');
    expect(saved._meta.edited_by_human).toBe(true);
    expect(saved.server_extension).toEqual({ retained: true });
    expect(saved.user_actions.server_nested).toEqual({ retained: 'yes' });
  });

  // The load-bearing guarantee of the priority design: editing priority must
  // NOT flag the Dok as human-edited, because that flag makes `doklo sync` skip
  // the whole Dok. Priority is touched across dozens of Doks at a time, so
  // flagging each one would quietly freeze most of the Hub out of regeneration.
  it('saves priority without flagging the Dok as human-edited', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: {
        priority: {
          impact: 'revenue',
          blast_radius: 'degrading',
          signals: [],
          curated: { impact: { reason: 'settlement API is called from this screen' } },
        },
      },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error(result.error);
    const saved = JSON.parse(await readFile(path, 'utf-8')) as Record<string, any>;
    expect(saved.priority.impact).toBe('revenue');
    expect(saved.priority.curated.impact.reason)
      .toBe('settlement API is called from this screen');
    expect(saved._meta.edited_by_human).toBeUndefined();
  });

  it('still flags human editing when a patch also touches authored content', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: {
        description: 'edited prose',
        priority: { impact: 'enabling', blast_radius: 'blocking', signals: [], curated: {} },
      },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = JSON.parse(await readFile(path, 'utf-8')) as Record<string, any>;
    expect(saved._meta.edited_by_human).toBe(true);
  });

  // Signals are generator-authored evidence. A person edits axes, never proof,
  // so a client that sends its own signals must not be able to plant them.
  it('keeps generator-stamped signals and ignores client-supplied ones', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const current = JSON.parse(await readFile(path, 'utf-8')) as Record<string, unknown>;
    current.priority = {
      impact: 'enabling',
      blast_radius: 'degrading',
      signals: [{ file: 'middleware.ts', start_line: 1, detector: 'auth-guard' }],
      curated: {},
    };
    await writeFile(path, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: {
        priority: {
          impact: 'revenue',
          blast_radius: 'degrading',
          signals: [{ file: 'planted.ts', detector: 'money-model' }],
          curated: { impact: { reason: 'client tried to plant evidence' } },
        },
      },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = JSON.parse(await readFile(path, 'utf-8')) as Record<string, any>;
    expect(saved.priority.signals).toEqual([
      { file: 'middleware.ts', start_line: 1, detector: 'auth-guard' },
    ]);
  });

  it('fails closed on an invalid current Dok and leaves exact bytes unchanged', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    await writeFile(path, '{ "dok_id": "AUTH-SOCIAL", "broken": true }\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'must not write' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toMatchObject({ code: 'INVALID', path, preserved: true });
    }
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
  });

  it('fails closed on a stale revision and leaves exact bytes unchanged', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const before = await bytesAndRevision(path);
    const external = `${before.bytes.trimEnd()} \n`;
    await writeFile(path, external, 'utf-8');

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'must not overwrite external edit' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'CONFLICT', path, preserved: true });
    expect(await readFile(path, 'utf-8')).toBe(external);
  });

  it('reports a missing Dok without creating it', async () => {
    const dir = await scratchWorkspace();
    const catalogPath = join(dir, '.doklo', 'hub', 'doks');
    const path = join(catalogPath, 'MISSING.json');

    const result = await saveDokAction({
      dokId: 'MISSING',
      patch: { description: 'must not create' },
      expectedRevision: revisionOf(''),
    });

    expect(result).toEqual({
      ok: false,
      code: 'MISSING',
      path: catalogPath,
      error: expect.any(String),
      preserved: true,
    });
    await expect(readFile(path, 'utf-8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('maps a deterministic atomic-writer permission fault to WRITE_FAILED without changing bytes', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const before = await bytesAndRevision(path);
    atomicFault.pathPart = 'AUTH-SOCIAL.json';

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'must not write' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'WRITE_FAILED', path, preserved: true });
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
  });

  it('classifies a non-directory parent as UNREADABLE rather than MISSING', async () => {
    const dir = await scratchWorkspace();
    const doksPath = join(dir, '.doklo', 'hub', 'doks');
    const displaced = `${doksPath}.original`;
    const originalDok = await readFile(join(doksPath, 'AUTH-SOCIAL.json'), 'utf-8');
    await rename(doksPath, displaced);
    await writeFile(doksPath, 'parent is not a directory\n', 'utf-8');
    const before = await readFile(doksPath, 'utf-8');

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'must not write' },
      expectedRevision: revisionOf(originalDok),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result).toMatchObject({ code: 'UNREADABLE', path: doksPath, preserved: true });
    }
    expect(await readFile(doksPath, 'utf-8')).toBe(before);
    expect(await readFile(join(displaced, 'AUTH-SOCIAL.json'), 'utf-8')).toBe(originalDok);
  });
});

describe('bulkActivateDoksAction', () => {
  it('activates multiple revision-bound Draft Doks and preserves extension fields', async () => {
    const dir = await scratchWorkspace();
    const firstPath = join(dir, '.doklo', 'hub', 'doks', 'PAY.json');
    const secondPath = join(dir, '.doklo', 'hub', 'doks', 'SHOP-CART-PAY.json');
    const first = await readJson<Record<string, any>>(firstPath);
    first.server_extension = { retained: true };
    first._meta = {
      ...(first._meta as Record<string, unknown>),
      server_meta_extension: { retained: true },
    };
    await writeFile(firstPath, JSON.stringify(first, null, 2) + '\n', 'utf-8');
    const [firstBefore, secondBefore] = await Promise.all([
      bytesAndRevision(firstPath),
      bytesAndRevision(secondPath),
    ]);

    const result = await bulkActivateDoksAction({
      mode: 'selected',
      targets: [
        { dokId: 'PAY', expectedRevision: firstBefore.revision },
        { dokId: 'SHOP-CART-PAY', expectedRevision: secondBefore.revision },
      ],
    });

    expect(result).toMatchObject({
      ok: true,
      activated: [
        { dokId: 'PAY', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) },
        { dokId: 'SHOP-CART-PAY', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ],
    });
    const [savedFirst, savedSecond] = await Promise.all([
      readJson<Record<string, any>>(firstPath),
      readJson<Record<string, any>>(secondPath),
    ]);
    expect(savedFirst.status).toBe('active');
    expect(savedSecond.status).toBe('active');
    expect(savedFirst._meta.edited_by_human).toBe(true);
    expect(savedSecond._meta.edited_by_human).toBe(true);
    expect(savedFirst.server_extension).toEqual({ retained: true });
    expect(savedFirst._meta.server_meta_extension).toEqual({ retained: true });
  });

  it.each([
    {
      label: 'duplicate target',
      input: async (dir: string) => {
        const pay = await bytesAndRevision(join(dir, '.doklo', 'hub', 'doks', 'PAY.json'));
        return {
          mode: 'selected' as const,
          targets: [
            { dokId: 'PAY', expectedRevision: pay.revision },
            { dokId: 'PAY', expectedRevision: pay.revision },
          ],
        };
      },
      code: 'INVALID',
    },
    {
      label: 'missing target',
      input: async () => ({
        mode: 'selected' as const,
        targets: [{ dokId: 'MISSING', expectedRevision: revisionOf('{}') }],
      }),
      code: 'PREFLIGHT_FAILED',
    },
    {
      label: 'non-Draft target',
      input: async (dir: string) => {
        const active = await bytesAndRevision(
          join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json'),
        );
        return {
          mode: 'selected' as const,
          targets: [{ dokId: 'AUTH-SOCIAL', expectedRevision: active.revision }],
        };
      },
      code: 'PREFLIGHT_FAILED',
    },
    {
      label: 'stale revision',
      input: async () => ({
        mode: 'selected' as const,
        targets: [{ dokId: 'PAY', expectedRevision: revisionOf('stale') }],
      }),
      code: 'PREFLIGHT_FAILED',
    },
  ])('rejects a $label before changing any Dok', async ({ input, code }) => {
    const dir = await scratchWorkspace();
    const payPath = join(dir, '.doklo', 'hub', 'doks', 'PAY.json');
    const shopPath = join(dir, '.doklo', 'hub', 'doks', 'SHOP-CART-PAY.json');
    const before = await Promise.all([
      readFile(payPath, 'utf-8'),
      readFile(shopPath, 'utf-8'),
    ]);

    const result = await bulkActivateDoksAction(await input(dir));

    expect(result).toMatchObject({ ok: false, code, activated: [] });
    await expect(Promise.all([
      readFile(payPath, 'utf-8'),
      readFile(shopPath, 'utf-8'),
    ])).resolves.toEqual(before);
  });

  it('rejects an outdated all-Drafts membership before changing any Dok', async () => {
    const dir = await scratchWorkspace();
    const payPath = join(dir, '.doklo', 'hub', 'doks', 'PAY.json');
    const shopPath = join(dir, '.doklo', 'hub', 'doks', 'SHOP-CART-PAY.json');
    const [pay, shop] = await Promise.all([
      bytesAndRevision(payPath),
      bytesAndRevision(shopPath),
    ]);
    const before = [pay.bytes, shop.bytes];

    const missingDraft = await bulkActivateDoksAction({
      mode: 'all_drafts',
      targets: [{ dokId: 'PAY', expectedRevision: pay.revision }],
    });
    expect(missingDraft).toMatchObject({
      ok: false,
      code: 'PREFLIGHT_FAILED',
      activated: [],
    });
    await expect(Promise.all([
      readFile(payPath, 'utf-8'),
      readFile(shopPath, 'utf-8'),
    ])).resolves.toEqual(before);

    const activePath = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json');
    const active = await bytesAndRevision(activePath);
    const extraNonDraft = await bulkActivateDoksAction({
      mode: 'all_drafts',
      targets: [
        { dokId: 'PAY', expectedRevision: pay.revision },
        { dokId: 'SHOP-CART-PAY', expectedRevision: shop.revision },
        { dokId: 'AUTH-SOCIAL', expectedRevision: active.revision },
      ],
    });
    expect(extraNonDraft).toMatchObject({
      ok: false,
      code: 'PREFLIGHT_FAILED',
      activated: [],
    });
    await expect(Promise.all([
      readFile(payPath, 'utf-8'),
      readFile(shopPath, 'utf-8'),
    ])).resolves.toEqual(before);
  });

  it('reports deterministic partial success when a later atomic write fails', async () => {
    const dir = await scratchWorkspace();
    const firstPath = join(dir, '.doklo', 'hub', 'doks', 'PAY.json');
    const secondPath = join(dir, '.doklo', 'hub', 'doks', 'SHOP-CART-PAY.json');
    const [first, second] = await Promise.all([
      bytesAndRevision(firstPath),
      bytesAndRevision(secondPath),
    ]);
    atomicFault.pathPart = 'SHOP-CART-PAY.json';

    const result = await bulkActivateDoksAction({
      mode: 'selected',
      targets: [
        { dokId: 'PAY', expectedRevision: first.revision },
        { dokId: 'SHOP-CART-PAY', expectedRevision: second.revision },
      ],
    });

    expect(result).toMatchObject({
      ok: false,
      code: 'PARTIAL_FAILURE',
      activated: [
        { dokId: 'PAY', revision: expect.stringMatching(/^[a-f0-9]{64}$/u) },
      ],
      failures: [{
        dokId: 'SHOP-CART-PAY',
        code: 'WRITE_FAILED',
        error: expect.any(String),
        preserved: true,
      }],
    });
    expect((await readJson<Record<string, unknown>>(firstPath)).status).toBe('active');
    expect(await readFile(secondPath, 'utf-8')).toBe(second.bytes);
  });
});

describe('server action input validation', () => {
  it('returns INVALID instead of throwing for malformed runtime payloads', async () => {
    const dir = await scratchWorkspace();
    const guardedPaths = [
      join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json'),
      join(dir, '.doklo', 'hub', 'lexicon.json'),
      join(dir, '.doklo', 'hub', 'roles.json'),
      join(dir, '.doklo', 'cache', 'web.consolidated.json'),
    ];
    const before = await Promise.all(guardedPaths.map((path) => readFile(path, 'utf-8')));
    const actions = [
      () => saveDokAction(null as never),
      () => upsertLexiconTermAction(null as never),
      () => upsertRoleAction(null as never),
      () => saveConsolidatedAction(null as never),
    ];

    for (const run of actions) {
      const result = await run();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result).toMatchObject({ code: 'INVALID', preserved: true });
    }
    await expect(Promise.all(guardedPaths.map((path) => readFile(path, 'utf-8'))))
      .resolves.toEqual(before);
  });
});

describe('Lexicon mutations', () => {
  it('edits one owned locale while preserving root, term, binding, and locale extensions', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    const current = await readJson<Record<string, any>>(path);
    current.server_extension = { retained: true };
    current.terms[0].server_term_extension = { retained: true };
    current.terms[0].binding.server_binding_extension = { retained: true };
    current.terms[0].locales.ja = '訪問者';
    await writeFile(path, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveOwnedLexiconLocaleAction({
      termId: current.terms[0].term_id,
      locale: 'en',
      text: 'Guest',
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<Record<string, any>>(path);
    expect(saved.terms[0].locales).toMatchObject({ en: 'Guest', ja: '訪問者' });
    expect(saved.server_extension).toEqual({ retained: true });
    expect(saved.terms[0].server_term_extension).toEqual({ retained: true });
    expect(saved.terms[0].binding.server_binding_extension).toEqual({ retained: true });
  });

  it('fails closed on an invalid current Lexicon and leaves exact bytes unchanged', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    await writeFile(path, '{ this is invalid JSON\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveOwnedLexiconLocaleAction({
      termId: 'TERM-ROLE-VISITOR',
      locale: 'en',
      text: 'must not write',
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('INVALID');
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
  });

  it('rejects a non-owned term with the specified truthful result and unchanged bytes', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    const before = await bytesAndRevision(path);

    const result = await saveOwnedLexiconLocaleAction({
      termId: 'TERM-NAV-MYPAGE',
      locale: 'en',
      text: 'must not write',
      expectedRevision: before.revision,
    });

    expect(result).toEqual({
      ok: false,
      code: 'INVALID',
      path,
      error: 'Only owned Lexicon locales are editable in Studio.',
      preserved: true,
    });
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
  });

  it('creates and deletes terms only against the expected catalog revision', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    const file = await readJson<{ terms: LexiconTerm[] }>(path);
    const first = await bytesAndRevision(path);
    const fresh: LexiconTerm = {
      term_id: 'TERM-CONCEPT-TESTONLY',
      category: 'concept',
      binding: { type: 'owned' },
      locales: { en: 'Test only' },
      related_doks: [],
    };

    const created = await createLexiconTermAction({
      term: fresh,
      expectedRevision: first.revision,
    });
    expect(created.ok).toBe(true);
    if (!created.ok) throw new Error(created.error);
    expect((await readJson<{ terms: LexiconTerm[] }>(path)).terms).toHaveLength(file.terms.length + 1);

    const staleDelete = await deleteLexiconTermAction({
      termId: fresh.term_id,
      expectedRevision: first.revision,
    });
    expect(staleDelete.ok).toBe(false);
    if (!staleDelete.ok) expect(staleDelete.code).toBe('CONFLICT');

    const deleted = await deleteLexiconTermAction({
      termId: fresh.term_id,
      expectedRevision: created.revision,
    });
    expect(deleted.ok).toBe(true);
    expect((await readJson<{ terms: LexiconTerm[] }>(path)).terms).toHaveLength(file.terms.length);
  });

  it('returns INVALID and preserves bytes when a passthrough extension is not JSON-serializable', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'lexicon.json');
    const before = await bytesAndRevision(path);
    const schema = z.object({ version: z.number() }).passthrough();
    const value: z.infer<typeof schema> = {
      version: 1,
      server_extension: 1n,
    };

    const result = await writeJsonForMutation({
      root: dir,
      relativePath: '.doklo/hub/lexicon.json',
      expectedRevision: before.revision,
      value,
      schema,
      label: 'Non-JSON fixture',
    }).catch(() => null);

    expect(result).toMatchObject({
      ok: false,
      code: 'INVALID',
      path,
      preserved: true,
    });
    expect(await readFile(path, 'utf-8')).toBe(before.bytes);
  });
});

describe('Role mutations', () => {
  it('applies a narrow role patch and preserves extraction plus unknown fields recursively', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'roles.json');
    const current = await readJson<Record<string, any>>(path);
    current.server_extension = { retained: true };
    current.roles[0]._meta = {
      extraction: {
        confidence: 'high',
        evidence: ['app/auth/roles.ts:12'],
        server_nested: { retained: true },
      },
      server_meta: { retained: true },
    };
    current.roles[0].server_role_extension = { retained: true };
    await writeFile(path, JSON.stringify(current, null, 2) + '\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveRoleAction({
      roleId: current.roles[0].role_id,
      patch: { description: 'edited by narrow patch', scope: 'tenant' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<Record<string, any>>(path);
    expect(saved.roles[0].description).toBe('edited by narrow patch');
    expect(saved.roles[0].scope).toBe('tenant');
    expect(saved.roles[0]._meta).toEqual(current.roles[0]._meta);
    expect(saved.roles[0].server_role_extension).toEqual({ retained: true });
    expect(saved.server_extension).toEqual({ retained: true });
  });

  it('classifies a deterministic unreadable Roles path without replacing it', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'roles.json');
    const displaced = `${path}.original`;
    await rename(path, displaced);
    await mkdir(path);
    const sentinel = join(path, 'sentinel.txt');
    await writeFile(sentinel, 'unchanged\n', 'utf-8');

    const result = await saveRoleAction({
      roleId: 'ROLE-VISITOR',
      patch: { description: 'must not write' },
      expectedRevision: revisionOf('irrelevant'),
    });

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result).toMatchObject({ code: 'UNREADABLE', path, preserved: true });
    expect(await readFile(sentinel, 'utf-8')).toBe('unchanged\n');
    expect(await readFile(displaced, 'utf-8')).toContain('ROLE-VISITOR');
  });

  it('deletes a role only when the catalog revision matches', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'roles.json');
    const before = await bytesAndRevision(path);

    const result = await deleteRoleAction({
      roleId: 'ROLE-SELLER',
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<{ roles: Role[] }>(path);
    expect(saved.roles.some((role) => role.role_id === 'ROLE-SELLER')).toBe(false);
  });
});

describe('Lexicon suggestion mutations', () => {
  async function seedSuggestions(dir: string): Promise<{
    path: string;
    revision: string;
  }> {
    const path = join(dir, '.doklo', 'cache', 'lexicon-suggestions.json');
    const contents = JSON.stringify({
      generated_at: '2026-07-17T00:00:00.000Z',
      corpus_size: 2,
      server_extension: { retained: true },
      suggestions: [
        {
          text: 'Settlement',
          category: 'concept',
          reason: 'Used by multiple Doks',
          dok_refs: ['PAY'],
          server_nested: { retained: true },
        },
      ],
    }, null, 2) + '\n';
    await writeFile(path, contents, 'utf-8');
    return { path, revision: revisionOf(contents) };
  }

  it('CAS-reads both files, accepts once, and removes only the matching suggestion', async () => {
    const dir = await scratchWorkspace();
    const lexiconPath = join(dir, '.doklo', 'hub', 'lexicon.json');
    const lexicon = await bytesAndRevision(lexiconPath);
    const suggestions = await seedSuggestions(dir);

    const result = await acceptLexiconSuggestionAction({
      text: 'Settlement',
      category: 'concept',
      dok_refs: ['PAY'],
      defaultLocale: 'en',
      expectedRevision: lexicon.revision,
      expectedSuggestionsRevision: suggestions.revision,
    });

    expect(result.ok).toBe(true);
    const savedLexicon = await readJson<{ terms: LexiconTerm[] }>(lexiconPath);
    expect(savedLexicon.terms.filter((term) => term.locales?.en === 'Settlement')).toHaveLength(1);
    const savedSuggestions = await readJson<Record<string, any>>(suggestions.path);
    expect(savedSuggestions.suggestions).toEqual([]);
    expect(savedSuggestions.server_extension).toEqual({ retained: true });
  });

  it('is retry-safe when the Lexicon write succeeded but suggestion removal failed', async () => {
    const dir = await scratchWorkspace();
    const lexiconPath = join(dir, '.doklo', 'hub', 'lexicon.json');
    const lexicon = await bytesAndRevision(lexiconPath);
    const suggestions = await seedSuggestions(dir);
    const input = {
      text: 'Settlement',
      category: 'concept' as const,
      dok_refs: ['PAY'],
      defaultLocale: 'en',
      expectedRevision: lexicon.revision,
      expectedSuggestionsRevision: suggestions.revision,
    };
    const suggestionsBefore = await readFile(suggestions.path, 'utf-8');
    atomicFault.pathPart = 'lexicon-suggestions.json';

    const first = await acceptLexiconSuggestionAction(input);

    expect(first.ok).toBe(false);
    if (!first.ok) expect(first).toMatchObject({ code: 'WRITE_FAILED', path: suggestions.path, preserved: true });
    expect(await readFile(suggestions.path, 'utf-8')).toBe(suggestionsBefore);
    atomicFault.pathPart = null;

    const retried = await acceptLexiconSuggestionAction(input);

    expect(retried.ok).toBe(true);
    const saved = await readJson<{ terms: LexiconTerm[] }>(lexiconPath);
    expect(saved.terms.filter((term) => term.locales?.en === 'Settlement')).toHaveLength(1);
    expect((await readJson<{ suggestions: unknown[] }>(suggestions.path)).suggestions).toEqual([]);
  });

  it('rejects a suggestion only against the expected cache revision', async () => {
    const dir = await scratchWorkspace();
    const suggestions = await seedSuggestions(dir);
    const before = await readFile(suggestions.path, 'utf-8');

    const stale = await rejectLexiconSuggestionAction({
      text: 'Settlement',
      expectedRevision: revisionOf('stale'),
    });
    expect(stale.ok).toBe(false);
    if (!stale.ok) expect(stale.code).toBe('CONFLICT');
    expect(await readFile(suggestions.path, 'utf-8')).toBe(before);

    const rejected = await rejectLexiconSuggestionAction({
      text: 'Settlement',
      expectedRevision: suggestions.revision,
    });
    expect(rejected.ok).toBe(true);
    expect((await readJson<{ suggestions: unknown[] }>(suggestions.path)).suggestions).toEqual([]);
  });
});


// ── History pipeline (§0b propose-and-approve) ────────────────

describe('saveDokAction history entries', () => {
  it('records an edited entry with a bumped version when a note is given', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-SOCIAL.json'); // active, version 3, 3 legacy entries
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-SOCIAL',
      patch: { description: 'Sign-in with Apple added', status: 'draft' },
      expectedRevision: before.revision,
      note: 'Added Apple as a provider',
      category: 'added',
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<{
      status: string;
      _meta: { version: number; edited_by_human?: boolean; history: Array<Record<string, unknown>> };
    }>(path);
    expect(saved.status).toBe('draft');
    expect(saved._meta.edited_by_human).toBe(true);
    expect(saved._meta.version).toBe(4);
    expect(saved._meta.history).toHaveLength(4);
    expect(saved._meta.history[3]).toEqual({
      version: 4,
      date: '2026-08-16',
      change: 'Added Apple as a provider',
      author: 'tester',
      kind: 'edited',
      from: 'active',
      to: 'draft',
      category: 'added',
    });
  });

  it('records a status entry (no note) and inserts a baseline for a legacy active Dok with empty history', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const path = join(dir, '.doklo', 'hub', 'doks', 'AUTH-FORGOT.json');
    const legacy = await readJson<Record<string, unknown> & { _meta: Record<string, unknown> }>(path);
    legacy._meta = { ...legacy._meta, version: 1, history: [] };
    await writeFile(path, JSON.stringify(legacy, null, 2) + '\n', 'utf-8');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'AUTH-FORGOT',
      patch: { status: 'deprecated' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<{ _meta: { version: number; history: unknown[] } }>(path);
    expect(saved._meta.version).toBe(2);
    expect(saved._meta.history).toEqual([
      { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
      {
        version: 2, date: '2026-08-16', change: 'Deprecated', author: 'tester',
        kind: 'status', from: 'active', to: 'deprecated',
      },
    ]);
  });

  it('bumps version without an entry for a silent authored edit, and leaves meta untouched for priority-only saves', async () => {
    const dir = await scratchWorkspace();
    const path = join(dir, '.doklo', 'hub', 'doks', 'PAY.json'); // draft, version 1, 1 legacy entry
    const before = await bytesAndRevision(path);
    const silent = await saveDokAction({
      dokId: 'PAY',
      patch: { description: 'quiet edit' },
      expectedRevision: before.revision,
    });
    expect(silent.ok).toBe(true);
    const afterSilent = await readJson<{
      _meta: { version: number; history: unknown[]; edited_by_human?: boolean };
    }>(path);
    expect(afterSilent._meta.version).toBe(2);
    expect(afterSilent._meta.history).toHaveLength(1);
    expect(afterSilent._meta.edited_by_human).toBe(true);

    const rev2 = (await bytesAndRevision(path)).revision;
    const prio = await saveDokAction({
      dokId: 'PAY',
      patch: {
        priority: {
          impact: 'revenue',
          blast_radius: 'degrading',
          signals: [],
          curated: {},
        },
      },
      expectedRevision: rev2,
    });
    expect(prio.ok).toBe(true);
    const afterPrio = await readJson<{ _meta: { version: number; history: unknown[] } }>(path);
    expect(afterPrio._meta.version).toBe(2);
    expect(afterPrio._meta.history).toHaveLength(1);
  });

  it('accepts a note-only save (empty patch) and rejects blank notes and unknown categories', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const path = join(dir, '.doklo', 'hub', 'doks', 'CART.json'); // active, version 2, 2 entries
    const before = await bytesAndRevision(path);
    const ok = await saveDokAction({
      dokId: 'CART',
      patch: {},
      expectedRevision: before.revision,
      note: 'Verified with QA',
    });
    expect(ok.ok).toBe(true);
    const saved = await readJson<{
      status: string;
      _meta: { version: number; history: Array<Record<string, unknown>>; edited_by_human?: boolean };
    }>(path);
    expect(saved.status).toBe('active');
    expect(saved._meta.version).toBe(3);
    expect(saved._meta.history.at(-1)).toEqual({
      version: 3, date: '2026-08-16', change: 'Verified with QA', author: 'tester', kind: 'edited',
    });
    expect(saved._meta.edited_by_human).toBeUndefined();

    const rev = (await bytesAndRevision(path)).revision;
    const blank = await saveDokAction({
      dokId: 'CART', patch: {}, expectedRevision: rev, note: '   ',
    });
    expect(blank.ok).toBe(false);
    const badCategory = await saveDokAction({
      dokId: 'CART', patch: {}, expectedRevision: rev, note: 'x', category: 'nope' as never,
    });
    expect(badCategory.ok).toBe(false);
    expect(await readFile(path, 'utf-8')).toBe((await bytesAndRevision(path)).bytes);
  });
});

describe('saveDokAction pending_change approval', () => {
  async function seedPending(dir: string, dokId: string): Promise<string> {
    const path = join(dir, '.doklo', 'hub', 'doks', `${dokId}.json`);
    const dok = await readJson<Record<string, unknown> & { _meta: Record<string, unknown> }>(path);
    dok['status'] = 'draft';
    dok._meta = {
      ...dok._meta,
      version: 2,
      history: [],
      pending_change: {
        summary: 'Updated the description.',
        source: 'diff',
        base_version: 1,
        previous_status: 'active',
      },
    };
    await writeFile(path, JSON.stringify(dok, null, 2) + '\n', 'utf-8');
    return path;
  }

  it('confirms the staged proposal as a regenerated entry on activation and clears it', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const path = await seedPending(dir, 'PAY');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'PAY',
      patch: { status: 'active' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<{
      status: string;
      _meta: { version: number; history: unknown[]; pending_change?: unknown };
    }>(path);
    expect(saved.status).toBe('active');
    expect(saved._meta.pending_change).toBeUndefined();
    expect(saved._meta.history).toEqual([
      { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
      {
        version: 3, date: '2026-08-16', change: 'Updated the description.', author: 'tester',
        kind: 'regenerated', from: 'draft', to: 'active',
      },
    ]);
    expect(saved._meta.version).toBe(3);
  });

  it('lets a typed note beat the proposal at approval', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const path = await seedPending(dir, 'PAY');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'PAY',
      patch: { status: 'active' },
      expectedRevision: before.revision,
      note: 'Checkout now supports escrow.',
      category: 'added',
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<{
      _meta: { history: Array<Record<string, unknown>>; pending_change?: unknown };
    }>(path);
    expect(saved._meta.pending_change).toBeUndefined();
    expect(saved._meta.history.at(-1)).toMatchObject({
      kind: 'regenerated',
      change: 'Checkout now supports escrow.',
      category: 'added',
      from: 'draft',
      to: 'active',
    });
  });

  it('keeps the proposal staged across non-activation saves', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const path = await seedPending(dir, 'PAY');
    const before = await bytesAndRevision(path);

    const result = await saveDokAction({
      dokId: 'PAY',
      patch: { status: 'review' },
      expectedRevision: before.revision,
    });

    expect(result.ok).toBe(true);
    const saved = await readJson<{
      _meta: { history: Array<Record<string, unknown>>; pending_change?: Record<string, unknown> };
    }>(path);
    expect(saved._meta.pending_change).toMatchObject({ source: 'diff' });
    expect(saved._meta.history.at(-1)).toMatchObject({ kind: 'status', from: 'draft', to: 'review' });
  });
});

describe('bulkActivateDoksAction history entries', () => {
  it('confirms proposals where staged and records plain activations elsewhere', async () => {
    const dir = await scratchWorkspace();
    historyClock.now = () => new Date(2026, 7, 16, 12);
    const payPath = join(dir, '.doklo', 'hub', 'doks', 'PAY.json');
    const pay = await readJson<Record<string, unknown> & { _meta: Record<string, unknown> }>(payPath);
    pay._meta = {
      ...pay._meta,
      version: 2,
      history: [],
      pending_change: {
        summary: 'Added 1 rule.',
        source: 'diff',
        base_version: 1,
        previous_status: 'active',
        category: 'changed',
      },
    };
    await writeFile(payPath, JSON.stringify(pay, null, 2) + '\n', 'utf-8');
    const cartPayPath = join(dir, '.doklo', 'hub', 'doks', 'SHOP-CART-PAY.json'); // draft, no pending
    const payRev = (await bytesAndRevision(payPath)).revision;
    const cartPayRev = (await bytesAndRevision(cartPayPath)).revision;

    const result = await bulkActivateDoksAction({
      mode: 'selected',
      targets: [
        { dokId: 'PAY', expectedRevision: payRev },
        { dokId: 'SHOP-CART-PAY', expectedRevision: cartPayRev },
      ],
    });

    expect(result.ok).toBe(true);
    const pay2 = await readJson<{
      status: string;
      _meta: { version: number; history: Array<Record<string, unknown>>; pending_change?: unknown };
    }>(payPath);
    expect(pay2.status).toBe('active');
    expect(pay2._meta.pending_change).toBeUndefined();
    expect(pay2._meta.history).toEqual([
      { version: 1, date: '2026-08-16', change: 'Active before history tracking began', kind: 'baseline' },
      {
        version: 3, date: '2026-08-16', change: 'Added 1 rule.', author: 'tester',
        kind: 'regenerated', from: 'draft', to: 'active', category: 'changed',
      },
    ]);
    const cartPay = await readJson<{
      _meta: { version: number; history: Array<Record<string, unknown>> };
    }>(cartPayPath);
    expect(cartPay._meta.version).toBe(2);
    expect(cartPay._meta.history.at(-1)).toEqual({
      version: 2, date: '2026-08-16', change: 'Activated', author: 'tester',
      kind: 'status', from: 'draft', to: 'active',
    });
  });
});
