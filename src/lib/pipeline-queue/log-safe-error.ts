/**
 * One shared boundary that makes an error printable in a worker log line.
 *
 * A pipeline failure on a voice item is not content-free. The seller's spoken
 * transcript is in flight as `sellerContext`, so a provider that echoes its own
 * input, or a validation error that reports the value it rejected, carries those
 * words in `error.message`. Handing that object to `console.error` writes the
 * seller's speech into an operational log (#795).
 *
 * So the descriptor is built from *fields*, never from prose. No free text
 * survives — not `message`, not `details`, not `hint`, not a Zod issue path —
 * whatever layer produced the error. That is deliberate: the defect is any
 * seller-supplied text reaching a log line, so stripping one known phrase would
 * leave the leak open for the next transcript.
 *
 * What an operator keeps is exactly what the collapsed failure code cannot tell
 * them, which is why the diagnostic was restored in 23031e7e2 in the first
 * place: the error's type, the machine codes each layer attaches (our own
 * failure codes, SQLSTATE, HTTP status, Node/undici `ECONNRESET`), and the
 * `cause` chain that separates "the provider refused" from "the socket died".
 */

import { z } from "zod";

/**
 * A machine code — SQLSTATE `23505`, `ECONNRESET`, `provider_usage_temporarily_unavailable`.
 * Anything outside this shape is prose, and prose is what we refuse to repeat.
 * Bounded in length so a long attacker- or provider-chosen `code` cannot smuggle
 * a sentence through the guard.
 */
const MACHINE_CODE = /^[A-Za-z0-9_.:-]{1,64}$/;

/** `cause` chains are usually 1-2 deep; stop before a cyclic one runs away. */
const MAX_CAUSE_DEPTH = 3;

/**
 * The error's type. Prefers `name` because subclasses set it deliberately
 * (`PipelineWorkerFailure`, `ZodError`), but only when it looks like an
 * identifier — a non-Error throwable can carry anything in `name`, so an
 * unrecognised one falls back to the constructor, which is code-defined.
 */
function typeName(error: object): string {
  const named = error as { name?: unknown };
  if (typeof named.name === "string" && MACHINE_CODE.test(named.name)) {
    return named.name;
  }
  return error.constructor?.name ?? "Object";
}

/**
 * The codes worth keeping, in the order an operator reads them. `code` is a
 * string on our own failures and on Node/undici errors and a string SQLSTATE on
 * PostgrestError; some clients report a numeric one, so both are allowed.
 */
function machineFields(error: object): string[] {
  const fields: string[] = [];
  const candidate = error as {
    code?: unknown;
    status?: unknown;
    statusCode?: unknown;
    retryable?: unknown;
  };
  if (typeof candidate.code === "number") {
    fields.push(`code=${candidate.code}`);
  } else if (
    typeof candidate.code === "string" &&
    MACHINE_CODE.test(candidate.code)
  ) {
    fields.push(`code=${candidate.code}`);
  }
  const status =
    typeof candidate.status === "number" ? candidate.status : candidate.statusCode;
  if (typeof status === "number") fields.push(`status=${status}`);
  if (typeof candidate.retryable === "boolean") {
    fields.push(`retryable=${candidate.retryable}`);
  }
  return fields;
}

/**
 * How many issues, and which kinds — enough to tell a shape mismatch from a
 * missing field without reproducing any value.
 *
 * Issue *paths* are deliberately dropped even though they look like schema
 * vocabulary. They are not reliably ours: `listings.copy.fields` is an open
 * record and `guidedCorrectionCompletion` validates
 * `z.record(z.string(), z.unknown())`, so a path segment can itself be a
 * model-derived key. The full paths remain recoverable from the persisted
 * checkpoint, which is access-controlled; the log line is not.
 */
function zodFields(error: z.ZodError): string[] {
  const codes = [...new Set(error.issues.map((issue) => issue.code))]
    .filter((code) => MACHINE_CODE.test(code))
    .sort();
  const fields = [`issues=${error.issues.length}`];
  if (codes.length > 0) fields.push(`issue_codes=${codes.join(",")}`);
  return fields;
}

function describe(error: unknown, depth: number): string {
  // A non-object throwable has no fields to whitelist, and its own value may be
  // the transcript (`throw someProviderString`). Report the type alone.
  if (error === null) return "<null>";
  if (typeof error !== "object") return `<${typeof error}>`;

  const parts = [typeName(error), ...machineFields(error)];
  if (error instanceof z.ZodError) parts.push(...zodFields(error));

  const cause = (error as { cause?: unknown }).cause;
  if (cause !== undefined && cause !== null && depth < MAX_CAUSE_DEPTH) {
    parts.push(`cause=(${describe(cause, depth + 1)})`);
  }
  return parts.join(" ");
}

/**
 * Returns a one-line description of `error` that is safe to write to an
 * operational log: its type and machine codes, and none of its text.
 */
export function describeErrorForLog(error: unknown): string {
  if (error === undefined) return "<undefined>";
  return describe(error, 0);
}
