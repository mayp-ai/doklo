import { spawn } from 'node:child_process';
import {
  loadDok,
  loadLexicon,
  resolveTermText,
} from './data';
import {
  streamCliGenerate,
  type CliChild,
  type StreamCliOptions,
} from './generate-subprocess';
import {
  acquireGenerationRun,
} from './generation-run';
import { resolveStudioCliBin } from './cli-bin';

export { GenerationAlreadyRunningError, acquireGenerationRun, isGenerationActive } from './generation-run';

export type GenerationEvent = Record<string, unknown>;
export type GenerationEmitter = (event: GenerationEvent) => void | Promise<void>;

export interface OnboardingGenerationInput {
  root: string;
  service: string;
  signal?: AbortSignal;
}

export interface DokGenerationSummary {
  dok_id: string;
  name: string;
  status: string;
  anchorFiles: string[];
}

export interface OnboardingGenerationDeps {
  cliBin?: string;
  stream: (
    opts: StreamCliOptions,
    emit: GenerationEmitter,
  ) => Promise<void>;
  summarizeDok: (dokId: string) => Promise<DokGenerationSummary | null>;
}


export async function summarizePersistedDok(dokId: string): Promise<DokGenerationSummary | null> {
  const [dok, lexicon] = await Promise.all([loadDok(dokId), loadLexicon()]);
  if (!dok) return null;
  const dokName = dok.name;
  const name = typeof dokName === 'string'
    ? dokName
    : resolveTermText(
      lexicon.terms.find((term) => term.term_id === dokName.term_ref),
      'en',
    ) ?? `{${dokName.term_ref}}`;
  return {
    dok_id: dok.dok_id,
    name,
    status: dok.status,
    anchorFiles: dok._meta?.source_anchors?.map((anchor) => anchor.file) ?? [],
  };
}

const productionDeps: OnboardingGenerationDeps = {
  stream: (opts, emit) => streamCliGenerate(opts, emit, {
    spawn: (cmd, args, opts) =>
      spawn(cmd, args, { ...opts, stdio: ['ignore', 'pipe', 'pipe'] }) as unknown as CliChild,
  }),
  summarizeDok: summarizePersistedDok,
};

export async function startOnboardingGeneration(
  input: OnboardingGenerationInput,
  emit: GenerationEmitter,
  deps: OnboardingGenerationDeps = productionDeps,
): Promise<void> {
  const lease = acquireGenerationRun(input.root, input.service);
  let delivery = Promise.resolve();

  const deliver = (event: GenerationEvent): Promise<void> => {
    const next = delivery.then(async () => {
      if (
        event.stage === 'dok-done' &&
        event.success === true &&
        typeof event.dokId === 'string'
      ) {
        const dok = await deps.summarizeDok(event.dokId);
        await emit(dok ? { ...event, dok } : event);
        return;
      }
      await emit(event);
    });
    delivery = next;
    return next;
  };

  try {
    const cliBin = deps.cliBin ?? await resolveStudioCliBin();
    await deps.stream(
      {
        cliBin,
        root: input.root,
        service: input.service,
        signal: input.signal,
      },
      deliver,
    );
    await delivery;
  } finally {
    lease.release();
  }
}
