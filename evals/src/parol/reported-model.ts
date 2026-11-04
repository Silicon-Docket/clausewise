/**
 * Reads the model a provider names in its responses, so that a results file can pin "the model as
 * reported" (docs/parol/05, 'Pinning and repeatability'). An alias such as `claude-sonnet-5-5` can
 * move to a new snapshot between two runs; the request names the alias and only the response says
 * which model answered, so two runs that asked for the same alias are comparable only if the
 * responses named the same model.
 *
 * The Anthropic adapter reports usage but not the model of a response (it lists a model only for
 * the attempts of a server-side fallback, which an evaluation refuses to run with). The runner
 * hands the adapter its own `fetch`, so this wraps that one: it reads the `model` field of each
 * successful Messages API response from a copy of the response and leaves the original untouched
 * for the adapter. A body is read as JSON, or, for a streamed response, only up to its
 * `message_start` event.
 *
 * Only a plain model identifier is kept. A response is provider data, and nothing else in it is
 * read, stored or shown.
 */

const MODEL_NAME = /^[A-Za-z0-9][\w.:/@+-]{0,99}$/;
/** The `message_start` event comes first in a stream; a stream that has not shown it by now never will. */
const MAX_STREAM_PREFIX_CHARS = 65_536;

const accept = (value: unknown): string | undefined =>
  typeof value === "string" && MODEL_NAME.test(value) ? value : undefined;

const modelOfMessage = (body: unknown): string | undefined =>
  typeof body === "object" && body !== null
    ? accept((body as { model?: unknown }).model)
    : undefined;

/** The model named by the `message_start` event in the text of a server-sent event stream so far. */
function modelInStreamText(text: string): string | undefined {
  for (const line of text.split("\n")) {
    if (!line.startsWith("data:")) continue;
    let event: unknown;
    try {
      event = JSON.parse(line.slice(5).trim());
    } catch {
      continue;
    }
    if (typeof event !== "object" || event === null) continue;
    const { type, message } = event as { type?: unknown; message?: unknown };
    if (type === "message_start") return modelOfMessage(message);
  }
  return undefined;
}

async function modelOfStream(response: Response): Promise<string | undefined> {
  if (response.body === null) return undefined;
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  try {
    while (text.length < MAX_STREAM_PREFIX_CHARS) {
      const { done, value } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      // Only complete lines are read, so an event cut in two by a chunk boundary is not misread.
      const complete = text.slice(0, text.lastIndexOf("\n") + 1);
      const found = modelInStreamText(complete);
      if (found !== undefined) return found;
    }
    return modelInStreamText(text);
  } finally {
    // Stops reading this copy. The adapter's own copy of the stream goes on to its end. The
    // cancellation of one half of a split stream settles only when the other half is done too, so
    // it is not waited for: this must return as soon as the model is known.
    void reader.cancel().catch(() => undefined);
  }
}

/** The model a successful response names, or undefined when it names none that reads as a model id. */
export async function modelOfResponse(response: Response): Promise<string | undefined> {
  const type = response.headers.get("content-type") ?? "";
  if (type.includes("text/event-stream")) return modelOfStream(response);
  if (!type.includes("json")) return undefined;
  try {
    return modelOfMessage(await response.json());
  } catch {
    return undefined;
  }
}

export interface ReportingFetch {
  /** Stands in for `fetch`. A response is returned as the inner fetch returned it. */
  fetch: typeof globalThis.fetch;
  /** Resolves once every response seen so far has been read. */
  settle: () => Promise<void>;
}

/**
 * Wraps `inner` so that the model of each successful response is passed to `onModel`. A failure to
 * read a response is ignored: the pin is then empty, which a report prints as "not reported", and
 * the request itself is never affected.
 */
export function reportingFetch(
  inner: typeof globalThis.fetch,
  onModel: (model: string) => void,
): ReportingFetch {
  const pending = new Set<Promise<void>>();
  const wrapped = async (...request: Parameters<typeof globalThis.fetch>): Promise<Response> => {
    const response = await inner(...request);
    if (response.ok) {
      const read: Promise<void> = modelOfResponse(response.clone()).then(
        (model) => {
          if (model !== undefined) onModel(model);
        },
        () => undefined,
      );
      pending.add(read);
      void read.finally(() => pending.delete(read));
    }
    return response;
  };
  return {
    fetch: wrapped,
    settle: async () => {
      await Promise.allSettled([...pending]);
    },
  };
}
