import { createHash, randomUUID } from "node:crypto";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "pg";
import { describe, expect, it } from "vitest";
import {
  acquireExclusiveTestResource,
  resolveLocalTestDatabaseUrl,
} from "./exclusive-resource-lock";

const sleep = (milliseconds: number) =>
  new Promise((resolve) => setTimeout(resolve, milliseconds));

const LOCAL_DATABASE_URL = resolveLocalTestDatabaseUrl(
  process.env.SUPABASE_TEST_DB_URL ??
    "postgresql://postgres:postgres@127.0.0.1:54322/postgres",
);

async function localDatabaseReachable(): Promise<boolean> {
  const client = new Client({
    connectionString: LOCAL_DATABASE_URL,
    connectionTimeoutMillis: 500,
  });
  try {
    await client.connect();
    return true;
  } catch {
    return false;
  } finally {
    await client.end().catch(() => undefined);
  }
}

describe("local test database URL guard", () => {
  it("accepts IPv4 and IPv6 loopback connections", () => {
    expect(
      resolveLocalTestDatabaseUrl("postgresql://postgres:postgres@127.0.0.1/db"),
    ).toContain("127.0.0.1");
    expect(
      resolveLocalTestDatabaseUrl("postgresql://postgres:postgres@[::1]/db"),
    ).toContain("[::1]");
  });

  it("rejects non-loopback connections", () => {
    expect(() =>
      resolveLocalTestDatabaseUrl("postgresql://postgres:secret@db.example.com/db"),
    ).toThrow(/loopback/);
  });
});

describe.runIf(await localDatabaseReachable())("exclusive test resource lock", () => {
  it("waits until the current owner releases the same resource", async () => {
    const resource = `same-resource-${randomUUID()}`;
    const first = await acquireExclusiveTestResource(resource);
    let secondAcquired = false;
    const secondPromise = acquireExclusiveTestResource(resource).then((lease) => {
      secondAcquired = true;
      return lease;
    });

    await sleep(50);
    expect(secondAcquired).toBe(false);

    await first.release();
    const second = await secondPromise;
    expect(secondAcquired).toBe(true);
    await second.release();
  });

  it("does not serialize independent resources", async () => {
    const suffix = randomUUID();
    const [first, second] = await Promise.all([
      acquireExclusiveTestResource(`resource-a-${suffix}`),
      acquireExclusiveTestResource(`resource-b-${suffix}`),
    ]);

    await Promise.all([first.release(), second.release()]);
  });

  it("is not blocked by an abandoned filesystem coordinator", async () => {
    const resource = `abandoned-reaper-${randomUUID()}`;
    const lockName = createHash("sha256")
      .update(resource)
      .digest("hex")
      .slice(0, 24);
    const lockRoot = join(tmpdir(), "snaplist-exclusive-test-resources");
    const lockPath = join(lockRoot, lockName);
    const reaperDirectory = join(lockRoot, `${lockName}.reaper`);

    await mkdir(lockRoot, { recursive: true });
    await writeFile(
      lockPath,
      JSON.stringify({ pid: 2_147_483_647, startedAt: 0, token: randomUUID() }),
      { flag: "wx" },
    );
    await mkdir(reaperDirectory);

    try {
      const lease = await acquireExclusiveTestResource(resource, {
        retryDelayMs: 5,
        timeoutMs: 500,
      });
      await lease.release();
    } finally {
      await rm(lockPath, { force: true });
      await rm(reaperDirectory, { force: true, recursive: true });
    }
  });
});
