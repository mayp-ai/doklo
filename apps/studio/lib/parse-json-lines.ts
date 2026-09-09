export async function readJsonLines(
  stream: ReadableStream<Uint8Array>,
  onEvent: (event: Record<string, unknown>) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let buffer = '';

  try {
    while (true) {
      const { value, done } = await reader.read();
      try {
        if (value !== undefined) buffer += decoder.decode(value, { stream: true });
        if (done) buffer += decoder.decode();
      } catch {
        throw new Error('Generation returned an unreadable progress event.');
      }

      let newline = buffer.indexOf('\n');
      while (newline >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (line) {
          let parsed: unknown;
          try {
            parsed = JSON.parse(line) as unknown;
          } catch {
            throw new Error('Generation returned an unreadable progress event.');
          }
          if (
            parsed === null ||
            typeof parsed !== 'object' ||
            typeof (parsed as { stage?: unknown }).stage !== 'string'
          ) {
            throw new Error('Generation returned an unreadable progress event.');
          }
          onEvent(parsed as Record<string, unknown>);
        }
        newline = buffer.indexOf('\n');
      }
      if (done) break;
    }
  } catch (error) {
    await reader.cancel(error).catch(() => undefined);
    if (error instanceof Error && error.message.startsWith('Generation ')) throw error;
    throw new Error('Generation returned an unreadable progress event.');
  } finally {
    reader.releaseLock();
  }

  if (buffer.trim()) throw new Error('Generation stream ended with a partial event.');
}
