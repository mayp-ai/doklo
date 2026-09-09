export interface DoneCounters {
  succeeded: number;
  failed: number;
  layerFailed: number;
}

export function doneCounters(
  event: Record<string, unknown>,
): DoneCounters | null {
  const succeeded = event.succeeded;
  const failed = event.failed;
  const layerFailed = event.layerFailed;
  if (
    typeof succeeded !== 'number' ||
    !Number.isInteger(succeeded) ||
    succeeded < 0 ||
    typeof failed !== 'number' ||
    !Number.isInteger(failed) ||
    failed < 0 ||
    typeof layerFailed !== 'number' ||
    !Number.isInteger(layerFailed) ||
    layerFailed < 0
  ) {
    return null;
  }
  return { succeeded, failed, layerFailed };
}
