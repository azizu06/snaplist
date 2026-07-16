import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const LOCK_ROOT = join(tmpdir(), "snaplist-exclusive-test-resources");
const OWNER_FILE = "owner.json";

interface LockOwner {
  pid: number;
  startedAt: number;
  token: string;
}

export interface ExclusiveTestResourceLease {
  release(): Promise<void>;
}

interface ExclusiveTestResourceOptions {
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

async function removeAbandonedLock(lockDirectory: string): Promise<boolean> {
  try {
    const owner = JSON.parse(
      await readFile(join(lockDirectory, OWNER_FILE), "utf8"),
    ) as Partial<LockOwner>;
    if (typeof owner.pid === "number" && processIsAlive(owner.pid)) {
      return false;
    }
  } catch (error) {
    if (errorCode(error) !== "ENOENT" && !(error instanceof SyntaxError)) {
      throw error;
    }

    // The mkdir winner may still be writing its owner record. Only reap an
    // ownerless directory after a short grace period.
    try {
      const lockStat = await stat(lockDirectory);
      if (Date.now() - lockStat.mtimeMs < 2_000) return false;
    } catch (statError) {
      if (errorCode(statError) === "ENOENT") return true;
      throw statError;
    }
  }

  await rm(lockDirectory, { force: true, recursive: true });
  return true;
}

/**
 * Cross-process mutex for live local integration tests that share one external
 * resource. Vitest files run in separate workers, so an in-memory mutex cannot
 * protect a global PGMQ queue. Atomic mkdir keeps this coordination test-only
 * and avoids adding any production database capability.
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
  const lockDirectory = join(LOCK_ROOT, lockName);
  const owner: LockOwner = {
    pid: process.pid,
    startedAt: Date.now(),
    token: randomUUID(),
  };
  const deadline = Date.now() + timeoutMs;

  await mkdir(LOCK_ROOT, { recursive: true });

  while (true) {
    try {
      await mkdir(lockDirectory);
      try {
        await writeFile(
          join(lockDirectory, OWNER_FILE),
          JSON.stringify(owner),
          { flag: "wx" },
        );
      } catch (error) {
        await rm(lockDirectory, { force: true, recursive: true });
        throw error;
      }

      let released = false;
      return {
        async release() {
          if (released) return;
          released = true;
          try {
            const current = JSON.parse(
              await readFile(join(lockDirectory, OWNER_FILE), "utf8"),
            ) as Partial<LockOwner>;
            if (current.token !== owner.token) return;
          } catch (error) {
            if (errorCode(error) === "ENOENT") return;
            throw error;
          }
          await rm(lockDirectory, { force: true, recursive: true });
        },
      };
    } catch (error) {
      if (errorCode(error) !== "EEXIST") throw error;
      if (await removeAbandonedLock(lockDirectory)) continue;
      if (Date.now() >= deadline) {
        throw new Error(`Timed out waiting for exclusive test resource: ${resource}`);
      }
      await new Promise((resolve) => setTimeout(resolve, retryDelayMs));
    }
  }
}
