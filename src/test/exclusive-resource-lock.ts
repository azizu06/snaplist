import { createHash } from "node:crypto";
import { Client } from "pg";

const DEFAULT_LOCAL_DATABASE_URL =
  "postgresql://postgres:postgres@127.0.0.1:54322/postgres";

export interface ExclusiveTestResourceLease {
  release(): Promise<void>;
}

interface ExclusiveTestResourceOptions {
  retryDelayMs?: number;
  timeoutMs?: number;
}

export function resolveLocalTestDatabaseUrl(
  connectionString =
    process.env.SUPABASE_TEST_DB_URL ?? DEFAULT_LOCAL_DATABASE_URL,
): string {
  const hostname = new URL(connectionString).hostname;

  if (
    hostname !== "127.0.0.1" &&
    hostname !== "localhost" &&
    hostname !== "::1" &&
    hostname !== "[::1]"
  ) {
    throw new Error(
      "Exclusive DB test resources may only use a loopback Postgres connection",
    );
  }

  return connectionString;
}

function advisoryLockKeys(resource: string): [number, number] {
  const digest = createHash("sha256").update(resource).digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

/**
 * Cross-process mutex for live local integration tests that share one database
 * resource. The lock lives on a dedicated local Postgres session, so Vitest
 * workers serialize through the database and Postgres releases ownership
 * automatically if a worker exits or is killed. This stays test-only and adds
 * no production RPC, migration, or queue authority.
 */
export async function acquireExclusiveTestResource(
  resource: string,
  options: ExclusiveTestResourceOptions = {},
): Promise<ExclusiveTestResourceLease> {
  if (resource.trim().length === 0) {
    throw new Error("Exclusive test resource name must not be empty");
  }

  const retryDelayMs = options.retryDelayMs ?? 25;
  const timeoutMs = options.timeoutMs ?? 60_000;
  const deadline = Date.now() + timeoutMs;
  const [firstKey, secondKey] = advisoryLockKeys(resource);
  const client = new Client({
    connectionString: resolveLocalTestDatabaseUrl(),
    connectionTimeoutMillis: Math.min(timeoutMs, 2_000),
  });

  try {
    await client.connect();

    while (true) {
      const result = await client.query<{ acquired: boolean }>(
        "select pg_try_advisory_lock($1::integer, $2::integer) as acquired",
        [firstKey, secondKey],
      );

      if (result.rows[0]?.acquired) {
        let released = false;
        return {
          async release() {
            if (released) return;
            released = true;
            try {
              await client.query(
                "select pg_advisory_unlock($1::integer, $2::integer)",
                [firstKey, secondKey],
              );
            } finally {
              await client.end();
            }
          },
        };
      }

      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for exclusive test resource: ${resource}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
}
