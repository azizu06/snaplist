import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_ROOT = join(tmpdir(), "snaplist-exclusive-test-resources");

interface LockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

export interface ExclusiveTestResourceLease {
  release(): Promise<void>;
}

interface ExclusiveTestResourceOptions {
  beforePublish?: () => Promise<void>;
  retryDelayMs?: number;
  timeoutMs?: number;
}

function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) === "EPERM";
  }
}

async function readLockOwner(lockPath: string): Promise<Partial<LockOwner> | null> {
  try {
    return JSON.parse(await readFile(lockPath, "utf8")) as Partial<LockOwner>;
  } catch (error) {
    if (errorCode(error) === "ENOENT") return null;
    if (error instanceof SyntaxError) return {};
    throw error;
  }
}

async function removeAbandonedLock(
  lockPath: string,
  reaperDirectory: string,
): Promise<boolean> {
  const observed = await readLockOwner(lockPath);
  if (observed === null) return true;
  if (typeof observed.pid === "number" && processIsAlive(observed.pid)) {
    return false;
  }

  // Serialize stale-owner removal and re-read after winning. Without this,
  // two waiters could both observe a dead owner and the slower waiter could
  // unlink a successor lease after the faster waiter replaces it.
  try {
    await mkdir(reaperDirectory);
  } catch (error) {
    if (errorCode(error) === "EEXIST") return false;
    throw error;
  }

  try {
    const current = await readLockOwner(lockPath);
    if (current === null) return true;
    if (typeof current.pid === "number" && processIsAlive(current.pid)) {
      return false;
    }
    await rm(lockPath, { force: true });
    return true;
  } finally {
    await rm(reaperDirectory, { force: true, recursive: true });
  }
}

/**
 * Cross-process mutex for live local integration tests that share one external
 * resource. Vitest files run in separate workers, so an in-memory mutex cannot
 * protect a global PGMQ queue. An owner record is fully written before an
 * atomic hard-link publishes it as the lock, keeping this coordination
 * test-only without exposing an ownerless acquisition window.
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
  const lockName = createHash("sha256").update(resource).digest("hex").slice(0, 24);
  const lockPath = join(LOCK_ROOT, lockName);
  const reaperDirectory = join(LOCK_ROOT, `${lockName}.reaper`);
  const owner: LockOwner = {
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  };
  const candidatePath = join(
    LOCK_ROOT,
    `${lockName}.${owner.pid}.${owner.token}.candidate`,
  );
  const deadline = Date.now() + timeoutMs;

  await mkdir(LOCK_ROOT, { recursive: true });
  await writeFile(candidatePath, JSON.stringify(owner), { flag: "wx" });

  try {
    await options.beforePublish?.();
    while (true) {
      try {
        await link(candidatePath, lockPath);
      } catch (error) {
        if (errorCode(error) !== "EEXIST") throw error;
        if (await removeAbandonedLock(lockPath, reaperDirectory)) continue;
        if (Date.now() >= deadline) {
          throw new Error(`Timed out waiting for exclusive test resource: ${resource}`);
        }
        await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
        continue;
      }

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const current = await readLockOwner(lockPath);
            if (current === null) return;
            if (current.token !== owner.token) return;
          } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw error;
          }
          await rm(lockPath, { force: true });
        },
      };
    }
  } finally {
    await rm(candidatePath, { force: true });
  }
}
