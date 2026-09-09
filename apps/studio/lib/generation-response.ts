export interface GenerationResponseOptions {
  requestSignal: AbortSignal;
  headers: HeadersInit;
  encode: (event: Record<string, unknown>) => Uint8Array;
  run: (
    signal: AbortSignal,
    emit: (event: Record<string, unknown>) => Promise<void>,
  ) => Promise<void>;
}

/** Stream a generation response with writer acknowledgements as the delivery
 *  contract. Request aborts and response-body cancellation share one signal. */
export function generationStreamResponse(options: GenerationResponseOptions): Response {
  const abort = new AbortController();
  const onRequestAbort = () => abort.abort();
  if (options.requestSignal.aborted) abort.abort();
  else options.requestSignal.addEventListener('abort', onRequestAbort, { once: true });

  const transform = new TransformStream<Uint8Array, Uint8Array>();
  const writer = transform.writable.getWriter();
  void writer.closed.catch(() => {
    abort.abort();
  });

  void (async () => {
    try {
      await options.run(abort.signal, (event) => writer.write(options.encode(event)));
    } catch (error) {
      if (!abort.signal.aborted) {
        try {
          await writer.write(options.encode({
            stage: 'error',
            message: error instanceof Error ? error.message : String(error),
          }));
        } catch {
          // The reader was cancelled while the run was finishing.
        }
      }
    } finally {
      options.requestSignal.removeEventListener('abort', onRequestAbort);
      try {
        await writer.close();
      } catch {
        // A cancelled reader has already closed the writable side.
      }
    }
  })();

  return new Response(transform.readable, { headers: options.headers });
}
