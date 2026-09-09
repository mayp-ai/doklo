const activeRuns = new Set<string>();

function runKey(root: string, service: string): string {
  return `${root}\0${service}`;
}

export class GenerationAlreadyRunningError extends Error {
  constructor() {
    super('Generation already running');
    this.name = 'GenerationAlreadyRunningError';
  }
}

export function isGenerationActive(root: string, service: string): boolean {
  return activeRuns.has(runKey(root, service));
}

export function acquireGenerationRun(root: string, service: string): { release(): void } {
  const key = runKey(root, service);
  if (activeRuns.has(key)) throw new GenerationAlreadyRunningError();
  activeRuns.add(key);
  let released = false;
  return {
    release() {
      if (released) return;
      released = true;
      activeRuns.delete(key);
    },
  };
}
