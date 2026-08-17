import { afterAll, type TestContext } from "vitest";

export interface StackReachabilityOptions {
  apiKey?: string;
  probe?: () => Promise<boolean>;
  requiredValues?: Array<unknown>;
  url?: string;
}

/**
 * A suite that resolves its own stack coordinates can gate on one stack and
 * talk to another once a default drifts, and that failure reads as whatever
 * the suite was asserting rather than as a misdirected connection. Reachability
 * and the suites it admits resolve through these.
 */
export function resolveStackUrl(): string {
  return process.env.SUPABASE_URL
    ?? process.env.NEXT_PUBLIC_SUPABASE_URL
    ?? "http://127.0.0.1:54321";
}

export function resolveStackAnonKey(): string | undefined {
  return process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
}

export function resolveStackServiceRoleKey(): string | undefined {
  return process.env.SUPABASE_SERVICE_ROLE_KEY;
}

export async function stackReachable({
  apiKey = resolveStackAnonKey(),
  probe,
  requiredValues = [resolveStackAnonKey(), resolveStackServiceRoleKey()],
  url = resolveStackUrl(),
}: StackReachabilityOptions = {}): Promise<boolean> {
  const reachable = requiredValues.every(Boolean) && await (probe
    ? probe()
    : fetch(`${url}/auth/v1/health`, {
        headers: apiKey ? { apikey: apiKey } : undefined,
        signal: AbortSignal.timeout(2_000),
      }).then((response) => response.ok)
  ).catch(() => false);

  if (!reachable && process.env.SNAPLIST_REQUIRE_DB_STACK === "1") {
    throw new Error("SNAPLIST_REQUIRE_DB_STACK=1 requires a reachable local Supabase stack");
  }

  return reachable;
}

// Isolated per file: vitest runs each file in its own process, so this counts
// only the current file's skips, and the `afterAll` below fires once per file.
let skippedInThisFile = 0;
let filePath: string | undefined;

afterAll(() => {
  if (skippedInThisFile === 0) return;
  // A green summary here is not tenancy coverage — it means the suite never
  // ran. Loud on purpose so a local run can't be read as proof RLS held.
  // `process.stderr.write` bypasses vitest's per-task console buffering
  // (which the default reporter drops for non-failing tasks), so this is
  // visible under a plain `vitest run` and not only `--reporter=verbose`.
  process.stderr.write(
    `[supabase-stack] SKIPPED ${skippedInThisFile} test(s) in `
    + `${filePath ?? "a tenancy suite"}: local Supabase stack unreachable. `
    + "Tenancy/RLS coverage was NOT exercised this run. Start the local stack, "
    + "or set SNAPLIST_REQUIRE_DB_STACK=1 (as CI does) to fail instead of skip.\n",
  );
});

export function skipIfStackUnreachable(
  context: TestContext,
  reachable: boolean,
): void {
  if (!reachable) {
    skippedInThisFile += 1;
    filePath ??= context.task.file?.filepath;
    context.skip();
  }
}

export async function whenStackReachable<T>(
  reachable: boolean,
  work: () => T | Promise<T>,
): Promise<T | undefined> {
  return reachable ? work() : undefined;
}
