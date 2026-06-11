/**
 * Minimal structured observability (issue #18): one JSON line per event to
 * stdout, where every deploy target (Docker, Vercel, `pnpm dev`) already
 * collects logs. Deliberately NOT an APM/vendor SDK — no new dependencies, no
 * required env, fully offline-testable via the injectable sink + clock.
 *
 * Two primitives:
 *  - `logEvent`  — emit a single structured event line.
 *  - `timed`     — run an async step and emit one line with its duration and
 *                  outcome (ok / error), rethrowing on failure so callers'
 *                  error handling is untouched.
 *
 * Field discipline: log IDENTIFIERS and SIGNALS (runId, itemId, tier,
 * confidence, durations) — never photo contents, listing copy, or anything a
 * user typed. Lines stay grep- and `jq`-able.
 */

/** Flat, JSON-serializable fields. Keep values scalar so lines stay greppable. */
export type LogFields = Record<string, string | number | boolean | null | undefined>;

/** Where lines go. Injectable for tests; defaults to stdout via console.log. */
export type LogSink = (line: string) => void;

export interface ObservabilityOptions {
  sink?: LogSink;
  /** Millisecond clock (timestamp + duration source). Injectable for tests. */
  now?: () => number;
}

const defaultSink: LogSink = (line) => console.log(line);

function emit(
  event: string,
  fields: LogFields,
  opts: ObservabilityOptions | undefined,
  timestampMs: number,
): void {
  const sink = opts?.sink ?? defaultSink;
  // `event` and `ts` first so raw lines scan well; undefined fields drop out
  // of JSON.stringify naturally, so optional signals never emit `null` noise.
  sink(JSON.stringify({ event, ts: new Date(timestampMs).toISOString(), ...fields }));
}

/** Emit one structured event line. */
export function logEvent(
  event: string,
  fields: LogFields = {},
  opts?: ObservabilityOptions,
): void {
  emit(event, fields, opts, (opts?.now ?? Date.now)());
}

/**
 * Run `fn` and emit one event line with `durationMs` and `ok`. Failures are
 * logged (`ok: false` + the error message) and RETHROWN — this wrapper observes,
 * it never swallows.
 */
export async function timed<T>(
  event: string,
  fields: LogFields,
  fn: () => Promise<T>,
  opts?: ObservabilityOptions,
): Promise<T> {
  const now = opts?.now ?? Date.now;
  const start = now();
  try {
    const result = await fn();
    emit(event, { ...fields, durationMs: now() - start, ok: true }, opts, now());
    return result;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    emit(
      event,
      { ...fields, durationMs: now() - start, ok: false, error: message },
      opts,
      now(),
    );
    throw err;
  }
}
