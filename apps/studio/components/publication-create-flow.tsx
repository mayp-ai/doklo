'use client';

import {
  ArrowLeft,
  Check,
  ChevronLeft,
  ChevronRight,
  FileOutput,
  Languages,
  RefreshCw,
  SlidersHorizontal,
} from 'lucide-react';
import Link from 'next/link';
import {
  useMemo,
  useReducer,
  useState,
  type ReactNode,
} from 'react';
import {
  publicationCopy,
  publicationErrorMessage,
  type PublicationUiLocale,
} from '../lib/publication-copy';
import type {
  PublicationTemplateReadModel,
  PublicationWorkspaceModel,
} from '../lib/publication-read-model';
import type { StudioPublicationCreateInput } from '../lib/publication-run';
import { PublicationTemplatePicker } from './publication-template-picker';

type CreateStep = 1 | 2 | 3 | 4 | 5;
type SelectionDraft =
  | { mode: 'all_eligible' }
  | {
      mode: 'filter';
      include_tags: string[];
      exclude_tags: string[];
      statuses: Array<
        'draft'
        | 'review'
        | 'active'
        | 'planned'
        | 'deprecated'
        | 'archived'
      >;
    }
  | { mode: 'explicit'; dok_ids: string[] };

type CreateState = {
  step: CreateStep;
  template: string;
  selection: SelectionDraft;
  updateMode: 'manual' | 'review';
  locale: string;
  format: StudioPublicationCreateInput['format'];
  displayName: string;
  name: string;
  destination: string;
  vars: Record<string, string>;
};

type CreateAction =
  | { type: 'step'; step: CreateStep }
  | {
      type: 'template';
      template: PublicationTemplateReadModel;
      model: PublicationWorkspaceModel;
    }
  | { type: 'selection'; selection: SelectionDraft }
  | { type: 'updateMode'; value: 'manual' | 'review' }
  | { type: 'field'; field: 'locale' | 'displayName' | 'name' | 'destination'; value: string }
  | { type: 'format'; value: StudioPublicationCreateInput['format'] }
  | { type: 'variable'; name: string; value: string };

const STEP_ICONS = [
  FileOutput,
  SlidersHorizontal,
  RefreshCw,
  Languages,
  Check,
] as const;
const STUDIO_SELECTION_KINDS = ['all_eligible', 'explicit'] as const;

export function PublicationCreateFlow({
  initialModel,
}: {
  initialModel: PublicationWorkspaceModel;
}) {
  const [state, dispatch] = useReducer(
    reducer,
    initialModel,
    initialState,
  );
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [createdPublication, setCreatedPublication] = useState<string | null>(
    null,
  );
  const copy = publicationCopy(initialModel.locale);
  const template = initialModel.templates.find(
    (entry) => entry.name === state.template,
  ) ?? initialModel.templates[0];
  // TODO(publication-filter-selection):
  // Restore only with the criteria builder and zero-criterion guard defined in
  // docs/superpowers/tasks/2026-07-28-publication-filter-selection-handoff.md.
  const visibleKinds = STUDIO_SELECTION_KINDS.filter(
    (kind) => template?.selection.allowed_kinds.includes(kind),
  );
  const resolvedDokIds = useMemo(
    () => resolveDraftDoks(initialModel, template, state.selection),
    [initialModel, state.selection, template],
  );
  const steps = [
    copy.steps.document,
    copy.steps.content,
    copy.steps.update,
    copy.steps.output,
    copy.steps.review,
  ];
  const canContinue = template !== undefined
    && (
      state.step !== 2
      || resolvedDokIds.length > 0
    )
    && (
      state.step !== 4
      || (
        state.name.trim().length > 0
        && state.displayName.trim().length > 0
      )
    );

  const submit = async () => {
    if (!template || pending || resolvedDokIds.length === 0) return;
    setPending(true);
    setError(null);
    setCreatedPublication(null);
    try {
      const response = await fetch('/api/livedocs', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          name: state.name,
          display_name: state.displayName,
          template: template.name,
          selection: state.selection,
          update_mode: state.updateMode,
          locale: state.locale,
          format: state.format,
          vars: state.vars,
          ...(state.destination.trim()
            ? { destination: state.destination.trim() }
            : {}),
        } satisfies StudioPublicationCreateInput),
      });
      const body = await response.json() as {
        status?: 'success' | 'partial';
        completed?: string[];
        failed?: string;
        code?: string;
        error?: string;
      };
      if (
        response.status === 207
        || (
          body.status === 'partial'
          && body.completed?.includes('create')
          && body.failed === 'render'
        )
      ) {
        setCreatedPublication(state.name);
        setError(copy.create.initialRenderFailed);
        setPending(false);
        return;
      }
      if (!response.ok) {
        throw new Error(publicationErrorMessage(
          initialModel.locale,
          body.code,
        ));
      }
      window.location.assign(
        `/livedocs?publication=${encodeURIComponent(state.name)}`,
      );
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setPending(false);
    }
  };

  if (!template) {
    return (
      <main className="flex h-full items-center justify-center p-8">
        <div className="max-w-lg text-center">
          <h1 className="text-xl font-bold text-ink-strong">
            {copy.selection.noEligible}
          </h1>
          <Link className="mt-5 inline-flex text-sm text-accent" href="/livedocs">
            {copy.common.back}
          </Link>
        </div>
      </main>
    );
  }

  return (
    <main className="publication-create h-full overflow-y-auto bg-canvas">
      <header className="border-b border-border bg-surface px-5 py-4 lg:px-8">
        <div className="mx-auto flex max-w-[1180px] items-start justify-between gap-6">
          <div>
            <Link
              href="/livedocs"
              className="mb-3 inline-flex items-center gap-1.5 text-xs font-semibold text-ink-muted no-underline hover:text-ink"
            >
              <ArrowLeft size={14} aria-hidden />
              {copy.common.back}
            </Link>
            <h1 className="text-xl font-bold tracking-tight text-ink-strong">
              {copy.create.title}
            </h1>
            <p className="mt-1 max-w-[68ch] text-sm text-ink-muted">
              {copy.create.lead}
            </p>
          </div>
          <span className="rounded-pill bg-accent-soft px-3 py-1 font-mono text-xs font-semibold text-accent-ink">
            {state.step} / 5
          </span>
        </div>
      </header>

      <div className="mx-auto max-w-[1180px] px-4 py-5 lg:px-8 lg:py-8">
        <ol
          aria-label={copy.create.title}
          className="mb-7 grid grid-cols-5 gap-1 border-b border-border"
        >
          {steps.map((label, index) => {
            const step = (index + 1) as CreateStep;
            const Icon = STEP_ICONS[index]!;
            const active = state.step === step;
            const complete = state.step > step;
            return (
              <li key={label} className="min-w-0">
                <button
                  type="button"
                  data-create-step={step}
                  aria-label={label}
                  onClick={() => dispatch({ type: 'step', step })}
                  className={[
                    'flex w-full items-center justify-center gap-2 border-b-2 px-2 py-3 text-xs font-semibold transition-colors',
                    active
                      ? 'border-accent text-accent-ink'
                      : complete
                        ? 'border-success text-ink-secondary'
                        : 'border-transparent text-ink-faint hover:text-ink',
                  ].join(' ')}
                >
                  <Icon size={14} aria-hidden />
                  <span className="hidden truncate sm:inline">{label}</span>
                  <span className="sm:hidden">{step}</span>
                </button>
              </li>
            );
          })}
        </ol>

        <div
          className="publication-create-layout grid items-start gap-8 lg:grid-cols-[minmax(0,1fr)_320px]"
          data-active-create-step={state.step}
        >
          <section
            aria-labelledby={`publication-create-step-${state.step}`}
            className="min-w-0"
          >
            <StepPanel active={state.step === 1}>
              <StepHeading
                id="publication-create-step-1"
                eyebrow="01"
                title={copy.steps.document}
                description={copy.create.template}
              />
              <PublicationTemplatePicker
                templates={initialModel.templates}
                locale={initialModel.locale}
                selectedName={template.name}
                onSelect={(entry) => dispatch({
                  type: 'template',
                  template: entry,
                  model: initialModel,
                })}
                onConfirm={(entry) => {
                  dispatch({
                    type: 'template',
                    template: entry,
                    model: initialModel,
                  });
                  dispatch({ type: 'step', step: 2 });
                }}
              />
            </StepPanel>

            <StepPanel active={state.step === 2}>
              <StepHeading
                id="publication-create-step-2"
                eyebrow="02"
                title={copy.steps.content}
                description={`${copy.selection.resolved}: ${resolvedDokIds.length} ${copy.common.doks}`}
              />
              <fieldset className="space-y-3">
                <legend className="sr-only">{copy.selection.title}</legend>
                {visibleKinds.map((kind) => {
                  const value = kind === 'all_eligible'
                    ? { mode: 'all_eligible' } as const
                    : {
                        mode: 'explicit' as const,
                        dok_ids: template.selection.eligible_dok_ids.slice(0, 1),
                      };
                  const label = kind === 'all_eligible'
                    ? copy.selection.allEligible
                    : copy.selection.explicit;
                  const body = kind === 'all_eligible'
                    ? copy.selection.allEligibleBody
                    : copy.selection.explicitBody;
                  return (
                    <label
                      key={kind}
                      className={[
                        'flex cursor-pointer items-start gap-3 rounded-md border p-4',
                        state.selection.mode === value.mode
                          ? 'border-accent bg-accent-soft'
                          : 'border-border bg-surface hover:border-border-strong',
                      ].join(' ')}
                    >
                      <input
                        type="radio"
                        name="selection-kind"
                        checked={state.selection.mode === value.mode}
                        onChange={() => dispatch({
                          type: 'selection',
                          selection: value,
                        })}
                        className="mt-1 accent-accent"
                      />
                      <span>
                        <span
                          className="block text-sm font-semibold text-ink-strong"
                          data-selection-label
                        >
                          {label}
                        </span>
                        <span className="mt-1 block text-xs leading-relaxed text-ink-muted">
                          {body} {template.selection.eligible_dok_ids.length} {copy.common.doks}
                        </span>
                      </span>
                    </label>
                  );
                })}
              </fieldset>

              {state.selection.mode === 'explicit' ? (
                <div className="mt-5 border-t border-border pt-4">
                  <p className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-muted">
                    {copy.selection.resolved}
                  </p>
                  <div className="grid gap-2 sm:grid-cols-2">
                    {template.selection.eligible_dok_ids.map((dokId) => {
                      const dok = initialModel.doks.find(
                        (entry) => entry.dok_id === dokId,
                      );
                      const checked = state.selection.mode === 'explicit'
                        && state.selection.dok_ids.includes(dokId);
                      return (
                        <label
                          key={dokId}
                          className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-surface p-3 text-sm"
                        >
                          <input
                            type="checkbox"
                            checked={checked}
                            onChange={() => {
                              if (state.selection.mode !== 'explicit') return;
                              dispatch({
                                type: 'selection',
                                selection: {
                                  mode: 'explicit',
                                  dok_ids: checked
                                    ? state.selection.dok_ids.filter((id) => id !== dokId)
                                    : [...state.selection.dok_ids, dokId],
                                },
                              });
                            }}
                            className="mt-0.5 accent-accent"
                          />
                          <span>
                            <span className="block font-medium text-ink">
                              {dok?.name ?? dokId}
                            </span>
                            <span className="font-mono text-[11px] text-ink-faint">
                              {dokId}
                            </span>
                          </span>
                        </label>
                      );
                    })}
                  </div>
                </div>
              ) : null}

              <ResolvedSelection
                model={initialModel}
                ids={resolvedDokIds}
                locale={initialModel.locale}
              />
            </StepPanel>

            <StepPanel active={state.step === 3}>
              <StepHeading
                id="publication-create-step-3"
                eyebrow="03"
                title={copy.steps.update}
                description={copy.update.localNote}
              />
              <fieldset className="grid gap-4 md:grid-cols-2">
                <legend className="sr-only">{copy.update.title}</legend>
                <UpdateChoice
                  checked={state.updateMode === 'review'}
                  name={copy.update.review}
                  body={copy.update.reviewBody}
                  onChange={() => dispatch({
                    type: 'updateMode',
                    value: 'review',
                  })}
                />
                <UpdateChoice
                  checked={state.updateMode === 'manual'}
                  name={copy.update.manual}
                  body={copy.update.manualBody}
                  onChange={() => dispatch({
                    type: 'updateMode',
                    value: 'manual',
                  })}
                />
              </fieldset>
            </StepPanel>

            <StepPanel active={state.step === 4}>
              <StepHeading
                id="publication-create-step-4"
                eyebrow="04"
                title={copy.steps.output}
                description={copy.create.destinationHint}
              />
              <div className="grid gap-5 sm:grid-cols-2">
                <Field label={copy.create.name} htmlFor="publication-name">
                  <input
                    id="publication-name"
                    value={state.name}
                    onChange={(event) => dispatch({
                      type: 'field',
                      field: 'name',
                      value: event.target.value,
                    })}
                    pattern="[a-z0-9-]+"
                    className={inputClass}
                  />
                  <span className="mt-1 block text-xs text-ink-faint">
                    {copy.create.nameHint}
                  </span>
                </Field>
                <Field label={copy.create.displayName} htmlFor="publication-display-name">
                  <input
                    id="publication-display-name"
                    value={state.displayName}
                    onChange={(event) => dispatch({
                      type: 'field',
                      field: 'displayName',
                      value: event.target.value,
                    })}
                    className={inputClass}
                  />
                </Field>
                <Field label={copy.create.outputLocale} htmlFor="publication-locale">
                  <select
                    id="publication-locale"
                    value={state.locale}
                    onChange={(event) => dispatch({
                      type: 'field',
                      field: 'locale',
                      value: event.target.value,
                    })}
                    className={inputClass}
                  >
                    {template.supported_locales.map((locale) => (
                      <option key={locale} value={locale}>
                        {locale.toUpperCase()}
                      </option>
                    ))}
                  </select>
                </Field>
                <Field label={copy.create.format} htmlFor="publication-format">
                  <select
                    id="publication-format"
                    value={state.format}
                    onChange={(event) => dispatch({
                      type: 'format',
                      value: event.target.value as StudioPublicationCreateInput['format'],
                    })}
                    className={inputClass}
                  >
                    {template.output_formats.map((format) => (
                      <option key={format} value={format}>{format}</option>
                    ))}
                  </select>
                </Field>
                <div className="sm:col-span-2">
                  <Field label={copy.create.destination} htmlFor="publication-destination">
                    <input
                      id="publication-destination"
                      value={state.destination}
                      onChange={(event) => dispatch({
                        type: 'field',
                        field: 'destination',
                        value: event.target.value,
                      })}
                      placeholder="docs/help"
                      className={inputClass}
                    />
                  </Field>
                </div>
                {Object.entries(template.variables).map(([name, definition]) => (
                  <Field
                    key={name}
                    label={`${name}${definition.required ? ' *' : ''}`}
                    htmlFor={`publication-var-${name}`}
                  >
                    <input
                      id={`publication-var-${name}`}
                      value={state.vars[name] ?? ''}
                      onChange={(event) => dispatch({
                        type: 'variable',
                        name,
                        value: event.target.value,
                      })}
                      placeholder={definition.description}
                      className={inputClass}
                    />
                  </Field>
                ))}
              </div>
            </StepPanel>

            <StepPanel active={state.step === 5}>
              <StepHeading
                id="publication-create-step-5"
                eyebrow="05"
                title={copy.steps.review}
                description={copy.update.localNote}
              />
              <dl className="divide-y divide-border border-y border-border">
                <ReviewRow label={copy.create.template} value={template.display_name} />
                <ReviewRow label={copy.selection.title} value={`${resolvedDokIds.length} ${copy.common.doks}`} />
                <ReviewRow
                  label={copy.update.title}
                  value={state.updateMode === 'review'
                    ? copy.update.review
                    : copy.update.manual}
                />
                <ReviewRow
                  label={copy.create.outputLocale}
                  value={`${state.locale.toUpperCase()} · ${state.format}`}
                />
                <ReviewRow
                  label={copy.create.destination}
                  value={state.destination || copy.workbench.noDestination}
                />
              </dl>
              {error ? (
                <div
                  role="alert"
                  className="mt-5 rounded-md border border-danger bg-danger-bg p-3 text-sm text-danger"
                >
                  <p>{error}</p>
                  {createdPublication ? (
                    <Link
                      href={`/livedocs?publication=${encodeURIComponent(createdPublication)}`}
                      className="mt-3 inline-flex font-semibold text-danger underline"
                    >
                      {copy.create.openCreated}
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </StepPanel>

            <div className="mt-8 flex items-center justify-between border-t border-border pt-5">
              <button
                type="button"
                disabled={state.step === 1 || pending}
                onClick={() => dispatch({
                  type: 'step',
                  step: Math.max(1, state.step - 1) as CreateStep,
                })}
                className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-2 text-sm font-semibold text-ink-secondary hover:bg-surface-2 disabled:opacity-40"
              >
                <ChevronLeft size={16} aria-hidden />
                {copy.common.back}
              </button>
              {state.step < 5 ? (
                <button
                  type="button"
                  disabled={!canContinue}
                  onClick={() => dispatch({
                    type: 'step',
                    step: (state.step + 1) as CreateStep,
                  })}
                  className="inline-flex items-center gap-1.5 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas shadow-sm hover:bg-accent-hover disabled:opacity-40"
                >
                  {copy.common.continue}
                  <ChevronRight size={16} aria-hidden />
                </button>
              ) : (
                <button
                  type="button"
                  disabled={pending || resolvedDokIds.length === 0}
                  onClick={() => void submit()}
                  className="inline-flex items-center gap-2 rounded-md bg-accent px-4 py-2 text-sm font-semibold text-canvas shadow-sm hover:bg-accent-hover disabled:opacity-50"
                >
                  {pending ? <RefreshCw size={15} className="animate-spin" aria-hidden /> : <Check size={15} aria-hidden />}
                  {copy.common.create}
                </button>
              )}
            </div>
          </section>

          <aside
            aria-label={copy.create.summary}
            className="publication-create-summary rounded-lg border border-border bg-surface p-5 shadow-sm lg:sticky lg:top-5"
          >
            <p className="font-mono text-[10px] uppercase tracking-wide text-ink-faint">
              {copy.create.summary}
            </p>
            <h2 className="mt-2 text-lg font-bold text-ink-strong">
              {state.displayName || template.display_name}
            </h2>
            <p className="mt-1 font-mono text-xs text-ink-faint">
              {state.name}
            </p>
            <div className="mt-5 space-y-4 border-t border-border pt-4 text-sm">
              <SummaryItem label={copy.create.template} value={template.display_name} />
              <SummaryItem label={copy.selection.resolved} value={`${resolvedDokIds.length} ${copy.common.doks}`} />
              <SummaryItem
                label={copy.update.title}
                value={state.updateMode === 'review'
                  ? copy.update.review
                  : copy.update.manual}
              />
              <SummaryItem label={copy.create.format} value={`${state.locale.toUpperCase()} · ${state.format}`} />
            </div>
          </aside>
        </div>
      </div>
    </main>
  );
}

function initialState(model: PublicationWorkspaceModel): CreateState {
  const template = model.templates[0];
  if (!template) {
    return {
      step: 1,
      template: '',
      selection: { mode: 'all_eligible' },
      updateMode: 'review',
      locale: model.workspace_default_locale,
      format: 'markdown',
      displayName: '',
      name: '',
      destination: '',
      vars: {},
    };
  }
  return stateForTemplate(template, model, 1);
}

function reducer(state: CreateState, action: CreateAction): CreateState {
  switch (action.type) {
    case 'step':
      return { ...state, step: action.step };
    case 'template':
      return action.template.name === state.template
        ? state
        : stateForTemplate(action.template, action.model, state.step);
    case 'selection':
      return { ...state, selection: action.selection };
    case 'updateMode':
      return { ...state, updateMode: action.value };
    case 'field':
      return { ...state, [action.field]: action.value };
    case 'format':
      return { ...state, format: action.value };
    case 'variable':
      return {
        ...state,
        vars: { ...state.vars, [action.name]: action.value },
      };
  }
}

function stateForTemplate(
  template: PublicationTemplateReadModel,
  model: PublicationWorkspaceModel,
  step: CreateStep,
): CreateState {
  const defaultSelection: SelectionDraft =
    template.selection.default_kind === 'explicit'
      ? {
          mode: 'explicit',
          dok_ids: template.selection.eligible_dok_ids.slice(0, 1),
        }
      : { mode: 'all_eligible' };
  const locale = template.supported_locales.includes(
    model.workspace_default_locale,
  )
    ? model.workspace_default_locale
    : template.default_locale;
  return {
    step,
    template: template.name,
    selection: defaultSelection,
    updateMode: 'review',
    locale,
    format: template.default_format,
    displayName: template.display_name,
    name: uniquePublicationName(template.name, model),
    destination: '',
    vars: Object.fromEntries(
      Object.entries(template.variables)
        .filter(([, definition]) => definition.default !== undefined)
        .map(([name, definition]) => [
          name,
          String(definition.default),
        ]),
    ),
  };
}

function uniquePublicationName(
  templateName: string,
  model: PublicationWorkspaceModel,
): string {
  const taken = new Set(
    model.publications.map((entry) => entry.publication.name),
  );
  if (!taken.has(templateName)) return templateName;
  let index = 2;
  while (taken.has(`${templateName}-${index}`)) index += 1;
  return `${templateName}-${index}`;
}

function resolveDraftDoks(
  model: PublicationWorkspaceModel,
  template: PublicationTemplateReadModel | undefined,
  selection: SelectionDraft,
): string[] {
  if (!template) return [];
  const eligible = new Set(template.selection.eligible_dok_ids);
  if (selection.mode === 'all_eligible') return [...eligible].sort();
  if (selection.mode === 'explicit') {
    return selection.dok_ids.filter((id) => eligible.has(id)).sort();
  }
  return model.doks
    .filter((dok) => eligible.has(dok.dok_id))
    .filter((dok) => {
      const tags = new Set(dok.tags);
      return selection.include_tags.every((tag) => tags.has(tag))
        && !selection.exclude_tags.some((tag) => tags.has(tag))
        && (
          selection.statuses.length === 0
          || selection.statuses.includes(dok.status)
        );
    })
    .map((dok) => dok.dok_id)
    .sort();
}

function StepPanel({
  active,
  children,
}: {
  active: boolean;
  children: ReactNode;
}) {
  return (
    <div hidden={!active} aria-hidden={!active}>
      {children}
    </div>
  );
}

function StepHeading({
  id,
  eyebrow,
  title,
  description,
}: {
  id: string;
  eyebrow: string;
  title: string;
  description: string;
}) {
  return (
    <div className="mb-6">
      <p className="font-mono text-[11px] font-semibold tracking-wide text-accent">
        {eyebrow}
      </p>
      <h2 id={id} className="mt-1 text-lg font-bold text-ink-strong">
        {title}
      </h2>
      <p className="mt-1 text-sm text-ink-muted">{description}</p>
    </div>
  );
}

function Field({
  label,
  htmlFor,
  children,
}: {
  label: string;
  htmlFor: string;
  children: ReactNode;
}) {
  return (
    <label htmlFor={htmlFor} className="block text-sm font-semibold text-ink-secondary">
      {label}
      <span className="mt-2 block font-normal">{children}</span>
    </label>
  );
}

function UpdateChoice({
  checked,
  name,
  body,
  onChange,
}: {
  checked: boolean;
  name: string;
  body: string;
  onChange: () => void;
}) {
  return (
    <label
      className={[
        'cursor-pointer rounded-lg border p-5 transition-colors',
        checked
          ? 'border-accent bg-accent-soft'
          : 'border-border bg-surface hover:border-border-strong',
      ].join(' ')}
    >
      <span className="flex items-center gap-2">
        <input
          type="radio"
          name="update-mode"
          checked={checked}
          onChange={onChange}
          className="accent-accent"
        />
        <span className="font-semibold text-ink-strong">{name}</span>
      </span>
      <span className="mt-3 block text-sm leading-relaxed text-ink-muted">
        {body}
      </span>
    </label>
  );
}

function ResolvedSelection({
  model,
  ids,
  locale,
}: {
  model: PublicationWorkspaceModel;
  ids: string[];
  locale: PublicationUiLocale;
}) {
  const copy = publicationCopy(locale);
  return (
    <div className="mt-6 rounded-md bg-surface-2 p-4">
      <div className="flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-ink-muted">
          {copy.selection.resolved}
        </p>
        <span className="font-mono text-xs text-accent-ink">
          {ids.length} {copy.common.doks}
        </span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        {ids.map((id) => (
          <span
            key={id}
            title={model.doks.find((dok) => dok.dok_id === id)?.name}
            className="rounded-pill border border-border bg-surface px-2.5 py-1 font-mono text-[11px] text-ink-secondary"
          >
            {id}
          </span>
        ))}
      </div>
    </div>
  );
}

function SummaryItem({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div>
      <p className="text-xs text-ink-faint">{label}</p>
      <p className="mt-0.5 font-medium text-ink">{value}</p>
    </div>
  );
}

function ReviewRow({
  label,
  value,
}: {
  label: string;
  value: string;
}) {
  return (
    <div className="grid gap-1 py-4 sm:grid-cols-[180px_1fr]">
      <dt className="text-sm text-ink-muted">{label}</dt>
      <dd className="text-sm font-semibold text-ink">{value}</dd>
    </div>
  );
}

const inputClass = [
  'w-full rounded-md border border-border bg-surface px-3 py-2.5',
  'text-sm text-ink outline-none transition-colors',
  'placeholder:text-ink-faint hover:border-border-strong',
  'focus:border-accent focus:ring-2 focus:ring-accent/15',
].join(' ');
