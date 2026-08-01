/**
 * One shared boundary that makes a checkpoint payload storable as PostgreSQL
 * `jsonb`.
 *
 * Checkpoint content is model-derived, and `listings.copy.fields` is an open
 * record — arbitrary keys, arbitrary nesting — so there is no finite list of
 * fields to guard. A single recursive repair is the only shape that can hold.
 */

/** PostgreSQL rejects this inside `jsonb` text (SQLSTATE 22P05). */
const NUL = String.fromCharCode(0);

/**
 * `toWellFormed` replaces lone UTF-16 surrogates with U+FFFD — PostgREST refuses
 * to parse them (PGRST102) before Postgres ever sees the payload. It leaves
 * `U+0000` alone, which is well-formed UTF-16 but still unstorable, so both
 * repairs are needed. Every other control character is legal in `jsonb` and is
 * deliberately preserved: seller descriptions contain real newlines and tabs.
 */
function repairString(value: string): string {
  return value.toWellFormed().replaceAll(NUL, "");
}

/**
 * Returns `value` with every string it contains — including object keys — made
 * safe to persist as `jsonb`. Non-string leaves are returned untouched.
 *
 * Expects plain JSON: the checkpoint stages are Zod-validated and every leaf
 * originates as parsed model output, so only objects, arrays, strings, numbers,
 * booleans and null arrive here. A `Date`, `Map`, or anything relying on
 * `toJSON` would be walked as a plain object and flattened — do not put one in
 * the open `listingCopySchema.fields` record.
 *
 * Repairing a key can collide with a sibling (`"a<NUL>b"` and `"ab"` both become
 * `"ab"`). The later entry wins. That is deterministic and strictly better than
 * dead-lettering the run, which is what the unrepaired key would have caused.
 */
export function toJsonbSafe(value: unknown): unknown {
  if (typeof value === "string") return repairString(value);
  if (Array.isArray(value)) return value.map(toJsonbSafe);
  if (value === null || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, entry]) => [
      repairString(key),
      toJsonbSafe(entry),
    ]),
  );
}
