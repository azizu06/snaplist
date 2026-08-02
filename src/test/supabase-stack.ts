import type { TestContext } from "vitest";

export interface StackReachabilityOptions {
  apiKey?: string;
  probe?: () => Promise<boolean>;
  requiredValues?: Array<unknown>;
  url?: string;
}

export async function stackReachable({
  apiKey = process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
  probe,
  requiredValues = [
    process.env.SUPABASE_ANON_KEY ?? process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    process.env.SUPABASE_SERVICE_ROLE_KEY,
  ],
  url =
    process.env.SUPABASE_URL ??
    process.env.NEXT_PUBLIC_SUPABASE_URL ??
    "http://127.0.0.1:54321",
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

export function skipIfStackUnreachable(
  context: TestContext,
  reachable: boolean,
): void {
  if (!reachable) context.skip();
}

export async function whenStackReachable<T>(
  reachable: boolean,
  work: () => T | Promise<T>,
): Promise<T | undefined> {
  return reachable ? work() : undefined;
}
