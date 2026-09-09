// @vitest-environment jsdom

import {
  act,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  Dok,
  LexiconFile,
  LexiconTerm,
  Role,
  RolesFile,
  Translatable,
  Workspace,
} from '@doklo-beta/core';
import type { DokCatalogData, LoadState } from '../lib/load-state';
import { StudioProvider, useStudio } from '../components/studio-store';
import { DokEditor } from '../components/dok-editor';
import { RoleEditor } from '../components/role-editor';
import { LexiconEditor } from '../components/lexicon-editor';
import { LexiconSuggestions } from '../components/lexicon-suggestions';
import { TranslatableEditor } from '../components/translatable-editor';
import DokEditorPage from '../app/(editor)/doks/[id]/page';
import authDokJson from '../demo/.doklo/hub/doks/AUTH-SOCIAL.json';
import rolesJson from '../demo/.doklo/hub/roles.json';
import lexiconJson from '../demo/.doklo/hub/lexicon.json';

const actions = vi.hoisted(() => ({
  saveDok: vi.fn(),
  saveRole: vi.fn(),
  saveOwnedLocale: vi.fn(),
  createTerm: vi.fn(),
  acceptSuggestion: vi.fn(),
  rejectSuggestion: vi.fn(),
  legacyUpsertTerm: vi.fn(),
  legacyUpsertRole: vi.fn(),
  routerPush: vi.fn(),
}));

vi.mock('../lib/actions', () => ({
  saveDokAction: actions.saveDok,
  saveRoleAction: actions.saveRole,
  saveOwnedLexiconLocaleAction: actions.saveOwnedLocale,
  createLexiconTermAction: actions.createTerm,
  acceptLexiconSuggestionAction: actions.acceptSuggestion,
  rejectLexiconSuggestionAction: actions.rejectSuggestion,
  upsertLexiconTermAction: actions.legacyUpsertTerm,
  upsertRoleAction: actions.legacyUpsertRole,
}));

vi.mock('next/navigation', () => ({
  useParams: () => ({ id: 'AUTH-SOCIAL' }),
  useRouter: () => ({ push: actions.routerPush, refresh: vi.fn() }),
}));

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean })
  .IS_REACT_ACT_ENVIRONMENT = true;

const dok = authDokJson as Dok;
const rolesFile = rolesJson as RolesFile;
const role = rolesFile.roles.find((entry) => entry.role_id === 'ROLE-SELLER') as Role;
const lexiconFile = lexiconJson as LexiconFile;
const owned = lexiconFile.terms.find((term) => term.term_id === 'TERM-ROLE-VISITOR') as LexiconTerm;
const i18n = lexiconFile.terms.find((term) => term.term_id === 'TERM-NAV-MYPAGE') as LexiconTerm;
const constant = lexiconFile.terms.find((term) => term.term_id === 'TERM-BTN-PAY') as LexiconTerm;

const workspaceState: LoadState<Workspace> = {
  kind: 'ready',
  path: '/workspace/workspace.json',
  revision: 'workspace-revision',
  data: {
    workspace_id: 'test-workspace',
    name: 'Workspace',
    default_locale: 'en',
    supported_locales: ['en', 'ko'],
    services: [],
  } as Workspace,
};
const doksState: LoadState<DokCatalogData> = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/doks',
  revision: 'catalog-revision',
  data: {
    doks: [dok],
    revisions: { [dok.dok_id]: 'dok-revision' },
    paths: { [dok.dok_id]: `/workspace/.doklo/hub/doks/${dok.dok_id}.json` },
  },
};
const lexiconState: LoadState<LexiconFile> = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/lexicon.json',
  revision: 'lexicon-revision',
  data: lexiconFile,
};
const rolesState: LoadState<RolesFile> = {
  kind: 'ready',
  path: '/workspace/.doklo/hub/roles.json',
  revision: 'roles-revision',
  data: rolesFile,
};

const roots: Root[] = [];

function provider(child: ReactNode) {
  return (
    <StudioProvider
      layerCounts={{ doks: 1, lexicon: lexiconFile.terms.length, ia: 0, roles: rolesFile.roles.length }}
      workspaceState={workspaceState}
      doksState={doksState}
      lexiconState={lexiconState}
      rolesState={rolesState}
      initialDoks={[dok]}
      initialLexicon={lexiconFile.terms}
      initialRoles={rolesFile.roles}
      projectLocales={['en', 'ko']}
    >
      {child}
    </StudioProvider>
  );
}

function render(child: ReactNode) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() => root.render(provider(child)));
  return container;
}

function SeedDok({ value = dok }: { value?: Dok }) {
  const { setEditingDok } = useStudio();
  useEffect(() => setEditingDok(value), [setEditingDok, value]);
  return <DokEditor />;
}

function SeedRole() {
  const { setEditingRole } = useStudio();
  useEffect(() => setEditingRole(role), [setEditingRole]);
  return <RoleEditor />;
}

function SeedTerm({ term }: { term: LexiconTerm }) {
  const { setEditingTerm } = useStudio();
  useEffect(() => setEditingTerm(term), [setEditingTerm, term]);
  return <LexiconEditor />;
}

function InlineTermHarness() {
  const [value, setValue] = useState<Translatable>('Original wording');
  return (
    <TranslatableEditor
      value={value}
      onChange={setValue}
      terms={[]}
      termByIdLocale={{}}
      ariaLabel="Inline wording"
    />
  );
}

async function change(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      Object.getPrototypeOf(element),
      'value',
    )?.set;
    setter?.call(element, value);
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
  });
}

function button(container: HTMLElement, label: string): HTMLButtonElement {
  const found = [...container.querySelectorAll<HTMLButtonElement>('button')]
    .find((candidate) => candidate.textContent?.trim() === label);
  if (!found) throw new Error(`Expected button "${label}".`);
  return found;
}

beforeEach(() => {
  vi.useFakeTimers();
  document.body.replaceChildren();
  for (const action of Object.values(actions)) action.mockReset();
  actions.saveDok.mockResolvedValue({
    ok: true,
    path: `/workspace/.doklo/hub/doks/${dok.dok_id}.json`,
    revision: 'dok-revision-2',
  });
  actions.saveRole.mockResolvedValue({
    ok: true,
    path: '/workspace/.doklo/hub/roles.json',
    revision: 'roles-revision-2',
  });
  actions.saveOwnedLocale.mockResolvedValue({
    ok: true,
    path: '/workspace/.doklo/hub/lexicon.json',
    revision: 'lexicon-revision-2',
  });
  actions.createTerm.mockResolvedValue({
    ok: false,
    code: 'WRITE_FAILED',
    path: '/workspace/.doklo/hub/lexicon.json',
    error: 'disk is read only',
    preserved: true,
  });
  actions.acceptSuggestion.mockResolvedValue({
    ok: true,
    path: '/workspace/.doklo/hub/lexicon.json',
    revision: 'lexicon-revision-2',
  });
  actions.rejectSuggestion.mockResolvedValue({
    ok: true,
    path: '/workspace/.doklo/cache/lexicon-suggestions.json',
    revision: 'suggestions-revision-2',
  });
  actions.legacyUpsertTerm.mockResolvedValue({
    ok: false,
    code: 'INVALID',
    path: '/workspace/.doklo/hub/lexicon.json',
    error: 'legacy call',
    preserved: true,
  });
  actions.legacyUpsertRole.mockResolvedValue({
    ok: false,
    code: 'INVALID',
    path: '/workspace/.doklo/hub/roles.json',
    error: 'legacy call',
    preserved: true,
  });
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.useRealTimers();
});

describe('durable editor bindings', () => {
  it('keeps the Dok list navigation and single save action above the Dok identity row', () => {
    const container = render(<DokEditorPage />);
    const article = container.querySelector<HTMLElement>('article');
    const actionBar = container.querySelector<HTMLElement>('nav[aria-label="Dok editor actions"]');
    if (!article || !actionBar) throw new Error('Expected the Dok editor action bar.');

    const back = button(container, 'Back to Doks');
    const savedActions = [...container.querySelectorAll<HTMLButtonElement>('button')]
      .filter((candidate) => candidate.textContent?.trim() === 'Saved');
    const idBadge = [...article.querySelectorAll('span')]
      .find((candidate) => candidate.textContent?.trim() === 'AUTH-SOCIAL');
    if (!idBadge) throw new Error('Expected the Dok identity badge.');

    expect(actionBar.contains(back)).toBe(true);
    expect(savedActions).toHaveLength(1);
    expect(actionBar.contains(savedActions[0])).toBe(true);
    expect(
      actionBar.compareDocumentPosition(idBadge) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).not.toBe(0);
  });

  it('returns to the Dok list from the editor action bar', async () => {
    const container = render(<DokEditorPage />);

    await act(async () => {
      button(container, 'Back to Doks').click();
      await Promise.resolve();
    });

    expect(actions.routerPush).toHaveBeenCalledOnce();
    expect(actions.routerPush).toHaveBeenCalledWith('/doks');
  });

  it('keeps a Dok edit local until the explicit save button is clicked', async () => {
    const container = render(<SeedDok />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Dok name"]');
    if (!input) throw new Error('Expected the Dok name input.');

    await change(input, 'Edited but not saved');
    await act(async () => {
      vi.advanceTimersByTime(10_000);
      await Promise.resolve();
    });

    expect(actions.saveDok).not.toHaveBeenCalled();
    expect(button(container, 'Save as draft').disabled).toBe(false);
  });

  it('saves changed active Dok wording and draft status in one patch', async () => {
    const container = render(<SeedDok />);
    const description = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Description"]',
    );
    if (!description) throw new Error('Expected the Dok description.');

    await change(description, 'Reviewed wording changed.');
    await act(async () => {
      button(container, 'Save as draft').click();
      await Promise.resolve();
    });

    expect(actions.saveDok).toHaveBeenCalledOnce();
    expect(actions.saveDok).toHaveBeenCalledWith({
      dokId: 'AUTH-SOCIAL',
      patch: {
        description: 'Reviewed wording changed.',
        status: 'draft',
      },
      expectedRevision: 'dok-revision',
    });
    expect(button(container, 'Saved').disabled).toBe(true);
    expect(button(container, 'draft')).toBeDefined();
  });

  it('explicitly saves an existing draft without changing its lifecycle', async () => {
    const draftDok = { ...dok, status: 'draft' as const };
    const container = render(<SeedDok value={draftDok} />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="Dok name"]');
    if (!input) throw new Error('Expected the Dok name input.');

    await change(input, 'Draft wording');
    expect(button(container, 'Save').disabled).toBe(false);
    await act(async () => {
      button(container, 'Save').click();
      await Promise.resolve();
    });

    expect(actions.saveDok).toHaveBeenCalledWith({
      dokId: 'AUTH-SOCIAL',
      patch: { name: 'Draft wording' },
      expectedRevision: 'dok-revision',
    });
  });

  it('does not offer an in-place save retry after Studio restarts', async () => {
    actions.saveDok.mockRejectedValueOnce(
      new Error('Server Action "abc123" was not found on the server.'),
    );
    const container = render(<SeedDok />);
    const description = container.querySelector<HTMLTextAreaElement>(
      'textarea[aria-label="Description"]',
    );
    if (!description) throw new Error('Expected the Dok description.');

    await change(description, 'Unsaved after restart.');
    await act(async () => {
      button(container, 'Save as draft').click();
      await Promise.resolve();
    });

    expect(button(container, 'Reload required').disabled).toBe(true);
    expect(
      [...container.querySelectorAll('button')]
        .some((candidate) => candidate.textContent?.trim() === 'Retry save'),
    ).toBe(false);
  });

  it('saves only the changed Role fields against roles.json revision', async () => {
    const container = render(<SeedRole />);
    const name = container.querySelector<HTMLInputElement>('input[aria-label="Role display name"]');
    const description = container.querySelector<HTMLTextAreaElement>('textarea[placeholder="Describe this role…"]');
    if (!name || !description) throw new Error('Expected editable Role fields.');

    await change(name, 'Merchant');
    await change(description, 'Owns product listings.');
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(actions.saveRole).toHaveBeenCalledOnce();
    expect(actions.saveRole).toHaveBeenCalledWith({
      roleId: 'ROLE-SELLER',
      patch: { name: 'Merchant', description: 'Owns product listings.' },
      expectedRevision: 'roles-revision',
    });
  });

  it('writes an owned locale through the revision-checked locale action', async () => {
    const container = render(<SeedTerm term={owned} />);
    const input = container.querySelector<HTMLInputElement>('input[aria-label="en translation"]');
    if (!input) throw new Error('Expected the owned English locale input.');
    expect(input.readOnly).toBe(false);

    await change(input, 'Guest');
    await act(async () => {
      vi.advanceTimersByTime(800);
      await Promise.resolve();
    });

    expect(actions.saveOwnedLocale).toHaveBeenCalledOnce();
    expect(actions.saveOwnedLocale).toHaveBeenCalledWith({
      termId: 'TERM-ROLE-VISITOR',
      locale: 'en',
      text: 'Guest',
      expectedRevision: 'lexicon-revision',
    });
  });

  it.each([
    {
      term: i18n,
      locale: 'en',
      hint: 'i18n source files are the source of truth. Edit them in your codebase.',
    },
    {
      term: constant,
      locale: 'en',
      hint: 'Code constants are the source of truth. Studio shows the cached snapshot.',
    },
  ])('keeps $term.binding.type locale rows read-only with a truthful hint', ({ term, locale, hint }) => {
    const container = render(<SeedTerm term={term} />);
    const input = container.querySelector<HTMLInputElement>(`input[aria-label="${locale} translation"]`);
    if (!input) throw new Error(`Expected the ${locale} locale input.`);

    expect(input.readOnly).toBe(true);
    expect(input.getAttribute('aria-readonly')).toBe('true');
    expect(container.textContent).toContain(hint);
  });

  it('presents binding cards as non-interactive v0.1 information', () => {
    const container = render(<SeedTerm term={owned} />);
    const bindingLabel = [...container.querySelectorAll('span')].find(
      (node) => node.textContent === 'Binding',
    );
    const section = bindingLabel?.closest('section');
    if (!section) throw new Error('Expected the Binding section.');

    expect(section.querySelectorAll('button')).toHaveLength(0);
    expect(section.textContent).toContain('owned');
  });

  it('creates inline terms with the Lexicon revision and keeps the original string selected on failure', async () => {
    const container = render(<InlineTermHarness />);
    const toggle = container.querySelector<HTMLButtonElement>('button[aria-label="Link to a Lexicon term"]');
    if (!toggle) throw new Error('Expected the term picker toggle.');
    act(() => toggle.click());
    const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent?.includes('Create a new owned term'),
    );
    if (!create) throw new Error('Expected inline term creation.');

    await act(async () => create.click());

    expect(actions.createTerm).toHaveBeenCalledOnce();
    expect(actions.createTerm.mock.calls[0]?.[0]).toMatchObject({
      expectedRevision: 'lexicon-revision',
      term: {
        binding: { type: 'owned' },
        locales: { en: 'Original wording', ko: 'Original wording' },
      },
    });
    expect(container.querySelector<HTMLInputElement>('input[aria-label="Inline wording"]')?.value)
      .toBe('Original wording');
  });

  it('adopts a successful inline creation revision for the next creation', async () => {
    actions.createTerm
      .mockResolvedValueOnce({
        ok: true,
        path: '/workspace/.doklo/hub/lexicon.json',
        revision: 'lexicon-revision-2',
      })
      .mockResolvedValueOnce({
        ok: true,
        path: '/workspace/.doklo/hub/lexicon.json',
        revision: 'lexicon-revision-3',
      });
    const container = render(<InlineTermHarness />);

    const createCurrentString = async () => {
      const link = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Link to a Lexicon term"]',
      );
      if (!link) throw new Error('Expected the term picker toggle.');
      act(() => link.click());
      const create = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
        (button) => button.textContent?.includes('Create a new owned term'),
      );
      if (!create) throw new Error('Expected inline term creation.');
      await act(async () => create.click());
    };

    await createCurrentString();
    const unlink = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Convert TermRef to plain text"]',
    );
    if (!unlink) throw new Error('Expected the TermRef unlink control.');
    act(() => unlink.click());
    await createCurrentString();

    expect(actions.createTerm).toHaveBeenCalledTimes(2);
    expect(actions.createTerm.mock.calls[0]?.[0].expectedRevision)
      .toBe('lexicon-revision');
    expect(actions.createTerm.mock.calls[1]?.[0].expectedRevision)
      .toBe('lexicon-revision-2');
  });

  it('blocks further suggestion actions after success until refreshed revisions arrive', async () => {
    const suggestions = [
      {
        text: 'Settlement',
        category: 'concept' as const,
        reason: 'Used by multiple Doks',
        dok_refs: ['AUTH-SOCIAL'],
      },
      {
        text: 'Disbursement',
        category: 'concept' as const,
        reason: 'Used by payment Doks',
        dok_refs: ['AUTH-SOCIAL'],
      },
    ];
    const container = render(
      <LexiconSuggestions
        initialSuggestions={suggestions}
        generatedAt="2026-07-17T00:00:00.000Z"
        corpusSize={2}
        defaultLocale="en"
        suggestionsRevision="suggestions-revision"
        suggestionsPath="/workspace/.doklo/cache/lexicon-suggestions.json"
      />,
    );
    const accept = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Accept',
    );
    if (!accept) throw new Error('Expected an Accept button.');

    await act(async () => accept.click());

    const remainingReject = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Reject',
    );
    if (!remainingReject) throw new Error('Expected the remaining Reject button.');
    expect(remainingReject.disabled).toBe(true);
    expect(container.querySelector('section')?.getAttribute('aria-busy')).toBe('true');
    expect(container.textContent).toContain('Refreshing suggestions…');
    act(() => remainingReject.click());

    expect(actions.acceptSuggestion).toHaveBeenCalledOnce();
    expect(actions.rejectSuggestion).not.toHaveBeenCalled();

    const root = roots[roots.length - 1];
    if (!root) throw new Error('Expected the rendered root.');
    await act(async () => {
      root.render(provider(
        <LexiconSuggestions
          initialSuggestions={[suggestions[1]]}
          generatedAt="2026-07-17T00:00:00.000Z"
          corpusSize={2}
          defaultLocale="en"
          suggestionsRevision="suggestions-revision-2"
          suggestionsPath="/workspace/.doklo/cache/lexicon-suggestions.json"
        />,
      ));
      await Promise.resolve();
    });

    const refreshedReject = [...container.querySelectorAll<HTMLButtonElement>('button')].find(
      (button) => button.textContent === 'Reject',
    );
    expect(refreshedReject?.disabled).toBe(false);
    expect(container.querySelector('section')?.hasAttribute('aria-busy')).toBe(false);
    expect(container.textContent).not.toContain('Refreshing suggestions…');
  });
});
